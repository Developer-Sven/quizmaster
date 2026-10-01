/**
 * Test-Fixture `players`: erzeugt Personen in eigenen Browser-Kontexten (eigene Gast-Session, Mobil-Viewport
 * des Projekts), protokolliert die Bühnen-Overlays und überwacht jede Seite. Am Testende: Konsolenprotokoll als
 * Anhang, Kontexte schließen und prüfen, dass es 0 CSP-Verstöße, 0 unbehandelte Fehler und keine unerwarteten
 * Konsolenfehler gab.
 */
import { type BrowserContext, type BrowserContextOptions, test as base, expect } from "@playwright/test";
import { BrowserMonitor } from "./monitor.ts";
import { Player } from "./player.ts";
import { installStageRecorder } from "./stage-recorder.ts";

/** Kontext-Optionen einer Person (ergänzen die Projekt-Optionen, z. B. `{ reducedMotion: "reduce" }`). */
export interface PlayerOptions extends BrowserContextOptions {
  /** Konsolenfehler, die der Test für diese Person absichtlich auslöst (siehe `BrowserMonitor`) */
  expectedConsoleErrors?: readonly RegExp[];
}

export interface Players {
  /** Neue Person mit eigener Session (neuer Kontext, leere Speicher). */
  create(name: string, options?: PlayerOptions): Promise<Player>;
  /** Schließt den Kontext einer Person (Tab zu, Verbindung weg). */
  close(player: Player): Promise<void>;
}

export const test = base.extend<{ players: Players }>({
  players: async ({ browser, baseURL }, use, testInfo) => {
    const monitor = new BrowserMonitor();
    const contexts = new Map<Player, BrowserContext>();
    const players: Players = {
      async create(name, options = {}) {
        const { expectedConsoleErrors = [], ...contextOptions } = options;
        // Die Projekt-Optionen (Gerät, Sprache, baseURL) gelten auch für zusätzliche Kontexte.
        const context = await browser.newContext({ baseURL, ...contextOptions });
        await monitor.watchContext(context, name, expectedConsoleErrors);
        await context.addInitScript(installStageRecorder);
        const page = await context.newPage();
        const player = new Player(page, name);
        contexts.set(player, context);
        return player;
      },
      async close(player) {
        await contexts.get(player)?.close();
        contexts.delete(player);
      },
    };

    await use(players);

    await testInfo.attach("browser-console.txt", {
      body: monitor.console.join("\n") || "(keine Konsolenmeldungen)",
      contentType: "text/plain",
    });
    for (const context of contexts.values()) await context.close();
    expect(monitor.problems, "CSP-Verstöße, unbehandelte Fehler oder unerwartete Konsolenfehler").toEqual([]);
  },
});

export { expect };
