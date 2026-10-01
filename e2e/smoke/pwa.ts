/**
 * Installierbarkeit (docs/10): Chromium selbst bewertet Manifest und Installierbarkeit (CDP `Page.getAppManifest`,
 * `Page.getInstallabilityErrors` – wie DevTools „Application → Manifest“), dazu Service Worker aktiv und
 * steuernd sowie Manifest und Icons erreichbar. Alle Abrufe laufen im Browser, damit `SMOKE_RESOLVE_TO` gilt.
 */
import type { Page } from "@playwright/test";

export interface ServiceWorkerState {
  scriptUrl: string;
  scope: string;
  /** Zustand des aktiven Workers, erwartet „activated“ */
  state: string;
  /** Der Worker steuert die Seite (`navigator.serviceWorker.controller`) */
  controlling: boolean;
}

export interface ManifestIcon {
  src: string;
  sizes: string;
  purpose: string | null;
  status: number;
  contentType: string;
}

export interface ManifestFetch {
  url: string;
  status: number;
  contentType: string;
  name: string | null;
  shortName: string | null;
  startUrl: string | null;
  display: string | null;
  icons: ManifestIcon[];
}

export interface PwaReport {
  /** Manifest-URL laut Chromium (leer = kein Manifest gefunden) */
  manifestUrl: string;
  /** Parser-Fehler und -Warnungen von Chromium */
  manifestErrors: string[];
  /** Einwände gegen die Installierbarkeit (`errorId` + Argumente), leer = installierbar */
  installabilityErrors: string[];
  manifest: ManifestFetch;
  serviceWorker: ServiceWorkerState;
}

const SERVICE_WORKER_TIMEOUT_MS = 30_000;

/** Wartet, bis ein Service Worker aktiv ist und die Seite steuert (`clientsClaim`, docs/10). */
export async function waitForActiveServiceWorker(page: Page): Promise<ServiceWorkerState> {
  const registration = await page.evaluate(async (timeoutMs) => {
    if (!("serviceWorker" in navigator)) return { error: "navigator.serviceWorker fehlt (kein sicherer Kontext?)" };
    const deadline = Date.now() + timeoutMs;
    const timeout = new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), timeoutMs));
    const ready = await Promise.race([navigator.serviceWorker.ready, timeout]);
    if (ready === null) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      return {
        error: `kein aktiver Service Worker nach ${timeoutMs / 1000} s (${registrations.length} Registrierungen)`,
      };
    }
    // `ready` liefert den aktiven Worker schon während „activating“ – bis „activated“ abwarten.
    const active = ready.active;
    while (active && active.state === "activating" && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    }
    return { scriptUrl: active?.scriptURL ?? "", scope: ready.scope, state: active?.state ?? "" };
  }, SERVICE_WORKER_TIMEOUT_MS);
  if ("error" in registration) throw new Error(`Service Worker: ${registration.error}`);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: SERVICE_WORKER_TIMEOUT_MS,
  });
  return { ...registration, controlling: true };
}

/** Manifest- und Installierbarkeits-Bewertung von Chromium. */
export async function chromiumInstallability(
  page: Page,
): Promise<Pick<PwaReport, "manifestUrl" | "manifestErrors" | "installabilityErrors">> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const manifest = await cdp.send("Page.getAppManifest", {});
    const installability = await cdp.send("Page.getInstallabilityErrors");
    return {
      manifestUrl: manifest.url,
      manifestErrors: manifest.errors.map(
        (entry) => `${entry.critical ? "kritisch" : "Hinweis"}: ${entry.message} (Zeile ${entry.line})`,
      ),
      installabilityErrors: installability.installabilityErrors.map((entry) =>
        [entry.errorId, ...entry.errorArguments.map((argument) => `${argument.name}=${argument.value}`)].join(" "),
      ),
    };
  } finally {
    await cdp.detach();
  }
}

/** Lädt das Manifest und jedes Icon im Browser (gleiche Origin, gleiche Auflösung wie die Seite). */
export async function fetchManifest(page: Page, manifestUrl: string): Promise<ManifestFetch> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    const contentType = response.headers.get("content-type") ?? "";
    const data: unknown = response.ok ? await response.json() : null;
    const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null);
    const rawIcons = Array.isArray(record.icons) ? (record.icons as unknown[]) : [];
    const icons: ManifestIcon[] = [];
    for (const raw of rawIcons) {
      const icon = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
      const src = typeof icon.src === "string" ? icon.src : "";
      const file = src === "" ? null : await fetch(new URL(src, url), { cache: "no-store" });
      icons.push({
        src,
        sizes: typeof icon.sizes === "string" ? icon.sizes : "",
        purpose: typeof icon.purpose === "string" ? icon.purpose : null,
        status: file?.status ?? 0,
        contentType: file?.headers.get("content-type") ?? "",
      });
    }
    return {
      url,
      status: response.status,
      contentType,
      name: text("name"),
      shortName: text("short_name"),
      startUrl: text("start_url"),
      display: text("display"),
      icons,
    };
  }, manifestUrl);
}
