/**
 * Test-Fixture `players`: erzeugt Personen in eigenen Browser-Kontexten (eigene Gast-Session, Mobil-Viewport
 * des Projekts), protokolliert die Bühnen-Overlays und überwacht jede Seite. Am Testende: Konsolenprotokoll als
 * Anhang, Kontexte schließen und prüfen, dass es 0 CSP-Verstöße, 0 unbehandelte Fehler und keine unerwarteten
 * Konsolenfehler gab.
 */
import { type BrowserContext, test as base, expect } from "@playwright/test";
import { BrowserMonitor } from "./monitor.ts";
import { Player } from "./player.ts";
import { installStageRecorder } from "./stage-recorder.ts";

export interface Players {
  /** Neue Person mit eigener Session (neuer Kontext, leere Speicher). */
  create(name: string): Promise<Player>;
  /** Schließt den Kontext einer Person (Tab zu, Verbindung weg). */
  close(player: Player): Promise<void>;
}

export const test = base.extend<{ players: Players }>({
  players: async ({ browser, baseURL }, use, testInfo) => {
    const monitor = new BrowserMonitor();
    const contexts = new Map<Player, BrowserContext>();
    const players: Players = {
      async create(name) {
        // Die Projekt-Optionen (Gerät, Sprache, baseURL) gelten auch für zusätzliche Kontexte.
        const context = await browser.newContext({ baseURL });
        await monitor.watchContext(context, name);
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
