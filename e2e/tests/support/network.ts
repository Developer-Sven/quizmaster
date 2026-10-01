/**
 * Netzwerk-Störungen für E2E (Playwright-Routing): gezielt Dateien nicht ausliefern, um Fehlerpfade der App zu
 * prüfen. Routing sieht Anfragen nur ohne Service Worker – Kontexte dafür mit `serviceWorkers: "block"` anlegen.
 */
import type { Page } from "@playwright/test";

/**
 * Konsolenfehler, die Chromium bei emuliertem Netzverlust (`context.setOffline(true)`) meldet – z. B. wenn
 * Socket.IO in dieser Zeit neu zu verbinden versucht (für `expectedConsoleErrors`).
 */
export const OFFLINE_ERRORS: readonly RegExp[] = [/net::ERR_INTERNET_DISCONNECTED/];

/** Konsolenfehler, die ein abgebrochener Chunk-Download erzeugt (für `expectedConsoleErrors`). */
export const CHUNK_FAILURE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_FAILED/,
  /ChunkLoadError/,
  /Unerwarteter Fehler: ChunkLoadError/,
];

/**
 * Lässt beim Aufruf von `path` alle nachgeladenen JavaScript-Chunks scheitern (wie ein Netzabbruch direkt nach
 * dem Laden der Seite): Nur die Chunks, die das HTML selbst einbindet, kommen an; alles, was die App danach per
 * `import()` bzw. `next/dynamic` nachlädt, bricht ab. Liefert eine Funktion, die das Netz wiederherstellt.
 */
export async function failLazyChunks(page: Page, path: string): Promise<() => Promise<void>> {
  const initial = new Set<string>();
  const documentPattern = `**${path}`;
  const chunkPattern = "**/_next/static/chunks/**";
  await page.route(documentPattern, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    for (const match of html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s<>()]+/g)) initial.add(match[0]);
    await route.fulfill({ response, body: html });
  });
  await page.route(chunkPattern, async (route) => {
    if (initial.has(new URL(route.request().url()).pathname)) await route.continue();
    else await route.abort("failed");
  });
  return async () => {
    await page.unroute(chunkPattern);
    await page.unroute(documentPattern);
  };
}
