/**
 * Kaltstart „Öffnen → Lobby erstellt und sichtbar“ unter Slow-4G-Drosselung (CDP): frischer Kontext ohne Cache
 * und ohne Service Worker, Startseite laden, Namen eintragen, „Lobby erstellen“, bis die Lobby mit Code steht.
 *
 * Gemessen wird im Browser (`performance.now()`, je Frame per `requestAnimationFrame` geprüft) relativ zum
 * Navigationsbeginn der Startseite – die Zeit, die ein Mensch zum Tippen braucht, ist nicht enthalten.
 *
 * Ziele: docs/01 „Öffnen → in einer Lobby in unter 10 Sekunden“ (docs/07 hat dafür keine eigene Zeile) und
 * docs/07 „Startseite LCP < 1,8 s (Mittelklasse-Android, 4G)“ – hier als Einzelmessung im Labor.
 */
import type { Page, Request, Response } from "@playwright/test";

/** Slow-4G-Profil wie Lighthouse mobil: 150 ms Latenz je Anfrage, 1,6 Mbit/s down, 750 kbit/s up, CPU 4×. */
export const SLOW_4G = {
  latencyMs: 150,
  downloadBitsPerSecond: 1_600_000,
  uploadBitsPerSecond: 750_000,
  cpuSlowdown: 4,
} as const;

/** docs/01 Erfolgskriterien: Öffnen → in einer Lobby in unter 10 Sekunden. */
export const COLD_START_SLO_MS = 10_000;

/** docs/07 SLOs: Startseite LCP < 1,8 s. */
export const START_LCP_SLO_MS = 1_800;

/** Höchstwartezeit für Startseite bzw. Lobby (danach Abbruch mit Diagnose). */
const STEP_TIMEOUT_MS = 60_000;

export interface ColdStartResult {
  code: string;
  /** Navigationsbeginn → Lobby mit Code sichtbar (erster Frame) */
  openToLobbyMs: number;
  sloMs: number;
  /** Antwort der Startseite (erstes Byte) */
  ttfbMs: number | null;
  fcpMs: number | null;
  /** Largest Contentful Paint der Startseite (bis zur ersten Eingabe) */
  lcpMs: number | null;
  lcpSloMs: number;
  /** Namensfeld hydriert = Startseite bedienbar */
  interactiveMs: number;
  /** übertragene Bytes bis dahin (Dokument + Ressourcen, KB) */
  transferredKb: number;
  /** Klick auf „Lobby erstellen“ (relativ zum Navigationsbeginn) */
  clickMs: number | null;
  /** Klick → Lobby sichtbar: Client nachladen, Session, Ticket, Socket, `lobby:create`, Lobby-Seite */
  createToLobbyMs: number | null;
  throttling: {
    latencyMs: number;
    downloadKbitPerSecond: number;
    uploadKbitPerSecond: number;
    cpuSlowdown: number;
  };
}

/** Beobachtungen am Netz während des Kaltstarts (Diagnose, z. B. Turnstile). */
export interface SessionGate {
  /** HTTP-Status der Antworten von `POST /api/session` */
  sessionStatuses: number[];
  /** Fehlercodes aus den Antworten (`TURNSTILE_REQUIRED`, `RATE_LIMITED` …) */
  errorCodes: string[];
  /** Turnstile von challenges.cloudflare.com geladen */
  turnstileLoaded: boolean;
}

interface StartMarks {
  timeOrigin: number;
  interactiveMs: number;
  ttfbMs: number | null;
  fcpMs: number | null;
  transferredBytes: number;
}

type LobbyOutcome = { kind: "lobby"; at: number; code: string } | { kind: "error"; text: string };

interface FinalMarks {
  timeOrigin: number;
  lcpMs: number | null;
  clickAt: number | null;
}

interface MarksWindow {
  __qmSmokeMarks?: { lcpMs: number | null; clickAt: number | null };
}

/**
 * Init-Skript für den Kaltstart-Kontext (wird serialisiert – nur Browser-APIs): merkt den letzten LCP-Kandidaten
 * und den Zeitpunkt des Klicks auf „Lobby erstellen“.
 */
export function installColdStartMarks(): void {
  const target = window as unknown as MarksWindow;
  if (target.__qmSmokeMarks) return;
  const marks = { lcpMs: null as number | null, clickAt: null as number | null };
  target.__qmSmokeMarks = marks;
  if (PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint")) {
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) marks.lcpMs = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  }
  document.addEventListener(
    "click",
    (event) => {
      if (marks.clickAt !== null || !(event.target instanceof Element)) return;
      if (event.target.closest('[data-testid="start-create"]'))
        marks.clickAt = performance.timeOrigin + performance.now();
    },
    { capture: true },
  );
}

/** Drosselt Netz und CPU der Seite (CDP); die zurückgegebene Funktion hebt die Drosselung wieder auf. */
export async function throttleSlow4g(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: SLOW_4G.latencyMs,
    downloadThroughput: SLOW_4G.downloadBitsPerSecond / 8,
    uploadThroughput: SLOW_4G.uploadBitsPerSecond / 8,
    connectionType: "cellular4g",
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: SLOW_4G.cpuSlowdown });
  return async () => {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  };
}

/** Fehlercode aus einem Fehler-Body der Web-API (`{ error: { code } }`, docs/06), sonst `null`. */
export function apiErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/**
 * Beobachtet `POST /api/session` und Turnstile-Anfragen (nur zur Diagnose, verändert nichts); `stop()` entfernt
 * die Beobachter wieder.
 */
export function watchSessionGate(page: Page): { gate: SessionGate; stop: () => void } {
  const gate: SessionGate = { sessionStatuses: [], errorCodes: [], turnstileLoaded: false };
  const onRequest = (request: Request) => {
    if (request.url().startsWith("https://challenges.cloudflare.com/")) gate.turnstileLoaded = true;
  };
  const onResponse = async (response: Response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/session") return;
    gate.sessionStatuses.push(response.status());
    if (response.ok()) return;
    try {
      const code = apiErrorCode(await response.json());
      gate.errorCodes.push(code ?? `HTTP ${response.status()}`);
    } catch (error) {
      // Body nicht lesbar (z. B. Seite inzwischen weiter) – der Status reicht für die Diagnose.
      gate.errorCodes.push(`HTTP ${response.status()} (${error instanceof Error ? error.name : "unlesbar"})`);
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    gate,
    stop: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

/** Erklärt, warum keine Lobby entstand (Turnstile, Limits, Wartung …). */
export function explainMissingLobby(gate: SessionGate, shownError: string | null): string {
  const parts: string[] = [];
  if (shownError) parts.push(`Startseite meldet „${shownError}“`);
  if (gate.errorCodes.includes("TURNSTILE_REQUIRED") || gate.turnstileLoaded) {
    parts.push(
      "neue Gast-Sessions verlangen Turnstile (TURNSTILE_ENABLED=true) – ein automatisierter Browser kann die " +
        "Prüfung nicht lösen; siehe README „Smoke-Test gegen eine laufende Instanz“",
    );
  } else if (gate.errorCodes.length > 0) {
    parts.push(`POST /api/session: ${gate.errorCodes.join(", ")}`);
  }
  if (gate.sessionStatuses.length === 0) parts.push("POST /api/session wurde nicht aufgerufen");
  return parts.join(" · ");
}

/**
 * Misst den Kaltstart auf der (frischen, noch leeren) Seite einer Person: Drosselung an, Startseite, Name,
 * „Lobby erstellen“, Lobby sichtbar, Drosselung aus. Danach läuft die Seite ungedrosselt weiter.
 */
export async function measureColdStart(page: Page, name: string): Promise<ColdStartResult> {
  await page.addInitScript(installColdStartMarks);
  const { gate, stop } = watchSessionGate(page);
  const release = await throttleSlow4g(page);
  let start: StartMarks;
  let outcome: LobbyOutcome;
  try {
    await page.goto("/", { waitUntil: "commit", timeout: STEP_TIMEOUT_MS });
    // Bedienbar = React hat das Namensfeld hydriert (sonst gehen Eingaben verloren). Je Frame geprüft.
    const startHandle = await page.waitForFunction(
      (): StartMarks | false => {
        const input = document.querySelector('[data-testid="start-name"]');
        if (!input || !Object.keys(input).some((key) => key.startsWith("__reactFiber$"))) return false;
        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        return {
          timeOrigin: performance.timeOrigin,
          interactiveMs: performance.now(),
          ttfbMs: navigation ? navigation.responseStart : null,
          fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
          transferredBytes:
            (navigation?.transferSize ?? 0) + resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        };
      },
      undefined,
      { polling: "raf", timeout: STEP_TIMEOUT_MS },
    );
    const startValue = await startHandle.jsonValue();
    if (startValue === false) throw new Error("Startseite: Messwerte fehlen");
    start = startValue;

    await page.getByLabel("Dein Name").fill(name);
    await page.getByRole("button", { name: "Lobby erstellen" }).click();
    const outcomeHandle = await page
      .waitForFunction(
        (): LobbyOutcome | false => {
          const code = document.querySelector('[data-testid="lobby-screen"] [data-testid="lobby-code"]');
          const text = code?.textContent?.trim() ?? "";
          if (code && text !== "" && code.checkVisibility({ visibilityProperty: true })) {
            return { kind: "lobby", at: performance.timeOrigin + performance.now(), code: text };
          }
          if (location.pathname === "/") {
            const alert = [...document.querySelectorAll('[role="alert"]')]
              .map((element) => element.textContent?.trim() ?? "")
              .find((message) => message !== "");
            if (alert) return { kind: "error", text: alert };
          }
          return false;
        },
        undefined,
        { polling: "raf", timeout: STEP_TIMEOUT_MS },
      )
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        const where = new URL(page.url()).pathname;
        throw new Error(
          `Lobby nicht erstellt (${STEP_TIMEOUT_MS / 1000} s, Seite ${where}): ${explainMissingLobby(gate, null)}`,
          { cause: error },
        );
      });
    const outcomeValue = await outcomeHandle.jsonValue();
    if (outcomeValue === false) throw new Error("Lobby: Messwerte fehlen");
    outcome = outcomeValue;
  } finally {
    stop();
    // Ein Fehler beim Aufheben (z. B. Seite abgestürzt) darf den eigentlichen Fehler nicht verdecken.
    await release().catch((error: unknown) => {
      console.warn(`Drosselung nicht aufgehoben: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (outcome.kind === "error") {
    throw new Error(`Lobby nicht erstellt: ${explainMissingLobby(gate, outcome.text)}`);
  }

  const final = await page.evaluate((): FinalMarks => {
    const marks = (window as unknown as MarksWindow).__qmSmokeMarks;
    return { timeOrigin: performance.timeOrigin, lcpMs: marks?.lcpMs ?? null, clickAt: marks?.clickAt ?? null };
  });
  // Die Lobby-Seite kommt per Client-Navigation (gleiches Dokument). Lädt sie als neues Dokument, fehlen LCP und
  // Klickzeit der Startseite – dann bleiben sie leer statt falsch.
  const sameDocument = Math.abs(final.timeOrigin - start.timeOrigin) < 1;
  const clickAt = sameDocument ? final.clickAt : null;
  return {
    code: outcome.code.replace(/\s+/g, ""),
    openToLobbyMs: Math.round(outcome.at - start.timeOrigin),
    sloMs: COLD_START_SLO_MS,
    ttfbMs: start.ttfbMs === null ? null : Math.round(start.ttfbMs),
    fcpMs: start.fcpMs === null ? null : Math.round(start.fcpMs),
    lcpMs: sameDocument && final.lcpMs !== null ? Math.round(final.lcpMs) : null,
    lcpSloMs: START_LCP_SLO_MS,
    interactiveMs: Math.round(start.interactiveMs),
    transferredKb: Math.round(start.transferredBytes / 1024),
    clickMs: clickAt === null ? null : Math.round(clickAt - start.timeOrigin),
    createToLobbyMs: clickAt === null ? null : Math.round(outcome.at - clickAt),
    throttling: {
      latencyMs: SLOW_4G.latencyMs,
      downloadKbitPerSecond: SLOW_4G.downloadBitsPerSecond / 1000,
      uploadKbitPerSecond: SLOW_4G.uploadBitsPerSecond / 1000,
      cpuSlowdown: SLOW_4G.cpuSlowdown,
    },
  };
}
