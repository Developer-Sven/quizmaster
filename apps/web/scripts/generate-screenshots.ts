// Manifest-Screenshots erzeugen (docs/10): 1080 × 1920 (360 × 640 CSS-Pixel bei Pixeldichte 3) nach
// public/screenshots/ – lobby.png („Lobby mit Code“) und frage.png („Frage mit Timer“).
//
//   node apps/web/scripts/generate-screenshots.ts --base-url http://127.0.0.1:3421
//
// Quelle ist /dev/game (nur in `next dev`): eingefrorene Beispiel-Zustände aus app/dev/game/sample-states.ts –
// ausschließlich Beispielinhalte, nie Fragen aus dem Katalog (öffentliches Repo, ADR-021). Voraussetzung ist ein
// laufender Dev-Server mit Test-Env (z. B. Web eines Test-Stacks im Dev-Modus, eigenes NEXT_DIST_DIR).
// Playwright kommt aus dem e2e-Paket (keine zusätzliche Abhängigkeit), sharp verkleinert die PNG-Dateien.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";

const webRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webRoot, "..", "..");
export const SCREENSHOTS_DIR = path.join(webRoot, "public", "screenshots");

/** 360 × 640 bei Pixeldichte 3 = 1080 × 1920 (Manifest `sizes`). */
export const VIEWPORT = { width: 360, height: 640 } as const;
export const DEVICE_SCALE = 3;

export interface ScreenshotSpec {
  file: string;
  /** Pfad unter der Basis-URL (/dev/game mit Ansicht und Personenzahl) */
  path: string;
  /** erscheint, sobald die Ansicht steht */
  ready: string;
}

export const SCREENSHOTS: readonly ScreenshotSpec[] = [
  { file: "lobby.png", path: "/dev/game?view=lobby-host&players=6", ready: '[data-testid="lobby-screen"]' },
  { file: "frage.png", path: "/dev/game?view=question&players=2", ready: '[data-testid="overlay-question"]' },
];

/** Next-Entwicklerhinweise (Dev-Indikator) gehören nicht in Screenshots. */
const HIDE_DEV_TOOLS = "nextjs-portal { display: none !important; }";

/** Die genutzten Teile der Playwright-API (das e2e-Paket bringt die Typen nicht nach apps/web). */
interface ScreenshotPage {
  goto(url: string, options: { waitUntil: "load" }): Promise<unknown>;
  waitForSelector(selector: string, options: { state: "visible"; timeout: number }): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { type: "png"; animations: "allow" }): Promise<Buffer>;
}

interface ScreenshotBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
    locale: string;
    colorScheme: "dark";
    reducedMotion: "reduce";
    serviceWorkers: "block";
  }): Promise<{ newPage(): Promise<ScreenshotPage>; close(): Promise<void> }>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: { launch(options: { headless: boolean }): Promise<ScreenshotBrowser> };
}

function isPlaywright(value: unknown): value is PlaywrightLike {
  // `@playwright/test` exportiert die Funktion `test` mit angehängten Eigenschaften (chromium, expect …).
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !("chromium" in value)) {
    return false;
  }
  const { chromium } = value;
  return (
    typeof chromium === "object" && chromium !== null && "launch" in chromium && typeof chromium.launch === "function"
  );
}

function loadPlaywright(): PlaywrightLike {
  const loaded: unknown = createRequire(path.join(repoRoot, "e2e", "package.json"))("@playwright/test");
  if (!isPlaywright(loaded)) throw new Error("@playwright/test aus e2e/ nicht ladbar (pnpm install im Repo?)");
  return loaded;
}

export async function generateScreenshots(baseUrl: string, outDir: string = SCREENSHOTS_DIR): Promise<string[]> {
  const browser = await loadPlaywright().chromium.launch({ headless: true });
  const written: string[] = [];
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      isMobile: true,
      hasTouch: true,
      locale: "de-DE",
      colorScheme: "dark",
      // Ohne Einflug-Animationen: das Bild zeigt den fertigen Zustand; der Timer läuft trotzdem (Information).
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    mkdirSync(outDir, { recursive: true });
    for (const shot of SCREENSHOTS) {
      await page.goto(new URL(shot.path, baseUrl).href, { waitUntil: "load" });
      await page.waitForSelector(shot.ready, { state: "visible", timeout: 60_000 });
      await page.addStyleTag({ content: HIDE_DEV_TOOLS });
      // Kein Fokusring im Bild (Overlays setzen den Fokus programmatisch für Tastatur und Screenreader).
      await page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
      await page.evaluate("document.fonts.ready.then(() => true)");
      await page.waitForTimeout(400);
      const raw = await page.screenshot({ type: "png", animations: "allow" });
      const image = sharp(raw);
      const { width, height } = await image.metadata();
      const expected = { width: VIEWPORT.width * DEVICE_SCALE, height: VIEWPORT.height * DEVICE_SCALE };
      if (width !== expected.width || height !== expected.height) {
        throw new Error(`${shot.file}: ${width}×${height} statt ${expected.width}×${expected.height}`);
      }
      const png = await image
        .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, effort: 10 })
        .toBuffer();
      writeFileSync(path.join(outDir, shot.file), png);
      written.push(`${shot.file} (${(png.byteLength / 1024).toFixed(0)} KB)`);
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return written;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "base-url": { type: "string" } } });
  const baseUrl = values["base-url"];
  if (!baseUrl) {
    console.error("Aufruf: node apps/web/scripts/generate-screenshots.ts --base-url http://127.0.0.1:<port>");
    process.exit(2);
  }
  for (const line of await generateScreenshots(baseUrl))
    console.info(`generate-screenshots – public/screenshots/${line}`);
}
