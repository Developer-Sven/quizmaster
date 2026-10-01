/**
 * Szenario 10 (docs/11, docs/10): PWA im Prod-Build (`next start` des Test-Stacks) – Manifest erreichbar und
 * gültig (ohne feste Ausrichtung, ADR-035), Service Worker registriert und steuert die Seite (`/sw.js` mit
 * `no-cache` + ETag, ADR-036), statische Dateien mit Cache-Headern und ohne Proxy, Offline-Seite bei Netzverlust,
 * Update-Banner „Neue Version verfügbar“ nie während des laufenden Spiels (erst ab Spielende).
 */
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { OFFLINE_ERRORS } from "./support/network.ts";
import type { Player } from "./support/player.ts";

/** Gültiges Format, aber keine aktive Lobby (wie Szenario 7). */
const UNKNOWN_CODE = "ZZZZ22";

/** Theme- und Hintergrundfarbe (docs/10 Manifest, Token `--color-bg`). */
const STUDIO_NAVY = "#0B1426";

/** Wartet, bis der Service Worker aktiv ist und die Seite steuert (clientsClaim, docs/10). */
async function waitForServiceWorker(page: Page): Promise<{ script: string; scope: string }> {
  const ready = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { script: registration.active?.scriptURL ?? "", scope: registration.scope };
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  return ready;
}

/**
 * Liefert `/sw.js` mit einer Markierung je „Generation“ aus. Erhöht der Test die Generation und ruft
 * `registration.update()`, ist das Skript bytegleich verschieden → der Browser installiert eine neue Version,
 * die wartet (wie nach einem Deploy). Fängt Playwright die Update-Anfrage nicht ab, liefert das Netz das
 * unmarkierte Original – auch das unterscheidet sich von der markierten ersten Version.
 */
async function serveVersionedServiceWorker(context: BrowserContext): Promise<{ publish(): void; fetches(): number }> {
  let generation = 0;
  let fetches = 0;
  await context.route("**/sw.js", async (route) => {
    fetches += 1;
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: `${body}\n// e2e-Version ${generation}\n` });
  });
  return {
    publish() {
      generation += 1;
    },
    fetches: () => fetches,
  };
}

async function waitingWorkerState(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.waiting?.state ?? null;
  });
}

test("Manifest erreichbar und gültig, Service Worker registriert (Prod-Build)", async ({ players, request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await response.json()) as {
    id: string;
    name: string;
    short_name: string;
    lang: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
    screenshots: { src: string; sizes: string; type: string; form_factor: string }[];
    shortcuts: { name: string; url: string }[];
  };
  expect(manifest).toMatchObject({
    id: "/",
    name: "quizmaster – Das Live-Quiz",
    short_name: "quizmaster",
    lang: "de",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
  });
  // Keine feste Ausrichtung (ADR-035, WCAG 1.3.4): Querformat bleibt möglich.
  expect(manifest).not.toHaveProperty("orientation");
  expect(manifest.background_color.toUpperCase()).toBe(STUDIO_NAVY);
  expect(manifest.theme_color.toUpperCase()).toBe(STUDIO_NAVY);
  expect(manifest.icons.map((icon) => `${icon.sizes}${icon.purpose ? ` ${icon.purpose}` : ""}`)).toEqual([
    "192x192",
    "512x512",
    "512x512 maskable",
  ]);
  expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(["/?action=create", "/?action=join"]);
  // Icons und Screenshots sind erreichbare PNGs.
  for (const image of [...manifest.icons, ...manifest.screenshots]) {
    const file = await request.get(image.src);
    expect(file.status(), image.src).toBe(200);
    expect(file.headers()["content-type"], image.src).toBe("image/png");
  }

  const mia = await players.create("Mia");
  await mia.openStart();
  await expect(mia.page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(mia.page.locator('meta[name="theme-color"]')).toHaveAttribute("content", STUDIO_NAVY);

  const origin = new URL(mia.page.url()).origin;
  const worker = await waitForServiceWorker(mia.page);
  expect(worker).toEqual({ script: `${origin}/sw.js`, scope: `${origin}/` });
  const script = await request.get("/sw.js");
  // ADR-036: immer beim Server prüfen (no-cache), dank ETag als bedingte Anfrage – ohne neue Version ein 304.
  expect(script.headers()["cache-control"]).toBe("no-cache");
  expect(script.headers()["content-type"]).toBe("application/javascript; charset=utf-8");
  const etag = script.headers().etag ?? "";
  expect(etag, "ETag an /sw.js").not.toBe("");
  const unchanged = await request.get("/sw.js", { headers: { "If-None-Match": etag } });
  expect(unchanged.status(), "bedingte Update-Prüfung ohne neue Version").toBe(304);

  // Chromium bewertet Manifest und Installierbarkeit selbst (DevTools „Application → Manifest“).
  const cdp = await mia.page.context().newCDPSession(mia.page);
  const appManifest = await cdp.send("Page.getAppManifest");
  expect(appManifest.errors, "Manifest-Fehler laut Chromium").toEqual([]);
  const installability = await cdp.send("Page.getInstallabilityErrors");
  expect(installability.installabilityErrors, "Installierbarkeit laut Chromium").toEqual([]);

  // Die Offline-Seite liegt nach der Installation im Precache (docs/10).
  await expect
    .poll(() =>
      mia.page.evaluate(async () => {
        const cache = await caches.open("qm-precache-v1");
        return (await cache.keys()).some((entry) => new URL(entry.url).pathname === "/offline");
      }),
    )
    .toBe(true);
});

test("Statische Dateien: eine Woche gecacht und ohne Proxy, HTML-Seiten weiter mit Nonce-CSP", async ({ request }) => {
  // Namen ohne Hash: eine Woche frisch, danach ein Tag stale-while-revalidate (der SW cached sie zusätzlich).
  const cacheControl = "public, max-age=604800, stale-while-revalidate=86400";
  for (const path of [
    "/sounds/lock.webm",
    "/sounds/lock.mp3",
    "/sounds/LICENSE.md",
    "/flags/de.svg",
    "/icons/icon-192.png",
    "/icons/favicon.svg",
    "/screenshots/lobby.png",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toBe(cacheControl);
    // Nicht durch den Proxy gelaufen: keine CSP mit Nonce (die setzt nur proxy.ts)
    expect(response.headers()["content-security-policy"], path).toBeUndefined();
  }

  const page = await request.get("/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  expect(page.status()).toBe(200);
  const csp = page.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/]{22}==)' 'strict-dynamic'/.exec(csp)?.[1];
  expect(nonce, "Nonce-CSP der Startseite").toBeDefined();
  expect(await page.text()).toContain(`nonce="${nonce}"`);
});

test("Offline-Seite bei Netzverlust, nach Rückkehr „Erneut versuchen“", async ({ players }) => {
  const mia = await players.create("Mia", { expectedConsoleErrors: OFFLINE_ERRORS });
  await mia.openStart();
  await waitForServiceWorker(mia.page);
  const context = mia.page.context();

  await context.setOffline(true);
  await mia.page.goto(`/lobby/${UNKNOWN_CODE}`);
  const offline = mia.page.getByTestId("offline-page");
  await expect(offline.getByRole("heading", { name: "Du bist offline." })).toBeVisible();
  await expect(offline.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
  expect(new URL(mia.page.url()).pathname).toBe(`/lobby/${UNKNOWN_CODE}`);
  // Vollständig gestaltet aus dem Cache (CSS + Schrift vorab gewärmt), ohne Netz.
  const look = await mia.page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    font: getComputedStyle(document.body).fontFamily,
  }));
  expect(look.background).toBe("rgb(11, 20, 38)");
  expect(look.font).toMatch(/Rubik/);

  // Netz zurück: „Erneut versuchen“ lädt dieselbe Adresse – ohne Mitgliedschaft weiter zur Beitreten-Seite.
  await context.setOffline(false);
  await offline.getByRole("button", { name: "Erneut versuchen" }).click();
  await mia.page.waitForURL(`**/j/${UNKNOWN_CODE}`);
  await expect(mia.page.getByTestId("join-screen")).toBeVisible();
});

test("Update-Banner erscheint nicht während des Spiels, erst ab Spielende", async ({ players }) => {
  const mia: Player = await players.create("Mia");
  const versions = await serveVersionedServiceWorker(mia.page.context());
  await mia.createLobby();
  await waitForServiceWorker(mia.page);
  await mia.addBot();
  await expect(mia.lobbyPlayer("Bot 1")).toBeVisible();
  await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 2 });
  await mia.startGame();

  // Mitten im Spiel erscheint eine neue Version (Deploy): Sie wird installiert und wartet …
  const fetchesBefore = versions.fetches();
  versions.publish();
  await mia.page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
  await expect.poll(() => waitingWorkerState(mia.page), { message: "neue Version wartet" }).toBe("installed");
  // Ging die Update-Anfrage durch die Route, bleibt sie (gleiche Version beim Neuladen); sonst kommt das Netz-
  // Original – dann darf die Route beim Neuladen nicht wieder die alte markierte Version liefern.
  const updateRouted = versions.fetches() > fetchesBefore;

  // … aber das Banner bleibt im laufenden Spiel aus (docs/10: nie während eines Spiels, erst ab game_over).
  const banner = mia.page.getByTestId("update-banner");
  const phases = new Set<string>();
  for (;;) {
    // Phase, Spielende und Banner in EINEM Schritt lesen: Zwischen getrennten Abfragen kann das Spiel enden –
    // dann stünde das (ab Spielende erlaubte) Banner neben einer veralteten Phase und der Test schlüge fehl.
    const sample = await mia.page.evaluate(() => ({
      phase: document.querySelector('[data-testid="game-screen"]')?.getAttribute("data-phase") ?? null,
      gameOver: document.querySelector('[data-testid="overlay-game-over"]:not([data-exiting])') !== null,
      banners: document.querySelectorAll('[data-testid="update-banner"]').length,
    }));
    if (sample.gameOver || sample.phase === "game_over") break;
    if (sample.phase) phases.add(sample.phase);
    expect(sample.banners, `Update-Banner in Phase ${sample.phase}`).toBe(0);
    await mia.page.waitForTimeout(100);
  }
  expect([...phases], "Stichproben in laufenden Phasen").toEqual(
    expect.arrayContaining(["category_pick", "question", "reveal", "turn_summary"]),
  );

  // Spielende: jetzt erscheint das Banner; „Aktualisieren“ aktiviert die neue Version und lädt neu.
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Neue Version verfügbar");
  if (!updateRouted) await mia.page.context().unroute("**/sw.js");
  await Promise.all([mia.page.waitForEvent("load"), banner.getByRole("button", { name: "Aktualisieren" }).click()]);
  // Nach dem Neuladen: noch das Ergebnis oder schon zurück in der Lobby (nach 5 s automatisch, ADR-038).
  await expect(
    mia.page.locator('[data-testid="game-screen"][data-phase="game_over"], [data-testid="lobby-screen"]'),
  ).toBeVisible();
  await expect.poll(() => waitingWorkerState(mia.page)).toBeNull();
  await expect(banner).toHaveCount(0);
});
