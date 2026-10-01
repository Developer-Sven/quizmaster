/**
 * Fixture `smoke`: Personen in eigenen Browser-Kontexten mit festem Gerät (Pixel 7 bzw. iPhone 15, beide in
 * Chromium – ADR-026), überwacht wie in den E2E-Tests (`BrowserMonitor`: CSP-Verstöße per Event
 * `securitypolicyviolation` und Konsole „Refused to …“, unbehandelte Fehler, Konsolenfehler, Abstürze).
 * `record()` hängt Messwerte als Berichtsabschnitt an (reporter.ts). Am Testende: Kontexte schließen,
 * Konsolenprotokoll und Befunde anhängen, 0 Befunde verlangen.
 */
import {
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  devices,
  expect,
  type Page,
} from "@playwright/test";
import { BrowserMonitor } from "../tests/support/monitor.ts";
import { Player } from "../tests/support/player.ts";
import { installStageRecorder } from "../tests/support/stage-recorder.ts";
import { type BrowserSection, CONSOLE_LINES_PER_TEST, SECTION_PREFIX } from "./report.ts";

export const SMOKE_DEVICES = ["Pixel 7", "iPhone 15"] as const;
export type SmokeDevice = (typeof SMOKE_DEVICES)[number];

/**
 * Kontext-Optionen eines Geräts (Viewport, Bildschirm, User-Agent, Pixeldichte, Touch) – ohne
 * `defaultBrowserType`: Es läuft immer Chromium.
 */
export function deviceOptions(device: SmokeDevice): BrowserContextOptions {
  const { defaultBrowserType: _browser, ...options } = devices[device];
  return options;
}

/** Eine Person mit Gerät (Abläufe aus den E2E-Tests, `Player`). */
export class SmokePerson extends Player {
  readonly device: SmokeDevice;

  constructor(page: Page, name: string, device: SmokeDevice) {
    super(page, name);
    this.device = device;
  }
}

export interface SmokeFixture {
  /** Neue Person mit eigener Gast-Session (neuer Kontext: leerer Cache, leere Speicher). */
  person(name: string, device: SmokeDevice, options?: BrowserContextOptions): Promise<SmokePerson>;
  /** Berichtsabschnitt anhängen (JSON, siehe report.ts). */
  record(section: string, data: unknown): Promise<void>;
}

export const test = base.extend<{ smoke: SmokeFixture }>({
  smoke: async ({ browser }, use, testInfo) => {
    const monitor = new BrowserMonitor();
    const contexts: BrowserContext[] = [];
    const record = async (section: string, data: unknown) => {
      await testInfo.attach(`${SECTION_PREFIX}${section}`, {
        body: JSON.stringify(data),
        contentType: "application/json",
      });
    };

    await use({
      async person(name, device, options = {}) {
        // Die Optionen der Konfiguration (baseURL, Sprache, Zertifikate) gelten auch hier (Playwright Test).
        const context = await browser.newContext({ ...deviceOptions(device), ...options });
        contexts.push(context);
        await monitor.watchContext(context, `${name} (${device})`);
        await context.addInitScript(installStageRecorder);
        return new SmokePerson(await context.newPage(), name, device);
      },
      record,
    });

    for (const context of contexts) {
      await context.close().catch((error: unknown) => {
        monitor.problems.push({
          kind: "crash",
          page: "Kontext",
          text: `Schließen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
    await testInfo.attach("browser-console.txt", {
      body: monitor.console.join("\n") || "(keine Konsolenmeldungen)",
      contentType: "text/plain",
    });
    const browserSection: BrowserSection = {
      messages: monitor.console.length,
      problems: monitor.problems,
      console: monitor.console.slice(0, CONSOLE_LINES_PER_TEST),
    };
    await record("browser", browserSection);
    expect(monitor.problems, "CSP-Verstöße, unbehandelte Fehler, Konsolenfehler oder Abstürze").toEqual([]);
  },
});

export { expect };
