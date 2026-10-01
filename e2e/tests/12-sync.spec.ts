/**
 * Szenario 12 (docs/11, docs/09 §7 + §13, ADR-020): Zwei Geräte zeigen jedes Overlay zeitgleich – Abweichung
 * unter 150 ms bei `normal`-Timing (Stichprobe: 1 Runde, 1 Frage je Kategorie, 2 Personen).
 *
 * Damit die Prüfung den Uhrenabgleich wirklich fordert, gehen die Uhren der beiden „Geräte“ verschieden falsch
 * (`Date.now` um +4,3 s bzw. −2,1 s verschoben, wie bei Handys ohne Zeitabgleich): Die App muss jede
 * Einblendung über ihren Server-Offset (docs/05 §Uhrenabgleich) zum selben Serverzeitpunkt zeigen.
 *
 * Messung: Der Stage-Recorder (Init-Skript) vermerkt je Seite, wann ein Overlay eingehängt wird (`at`, App-Uhr
 * = `Date.now`, hier um die bekannte Verschiebung bereinigt = Serverzeit) und wann es zum ersten Mal gezeichnet
 * wird (`frameAt`, erster Animation-Frame auf der unverschobenen Monotonuhr `performance`). Beide Kontexte
 * laufen im selben Browser auf demselben Rechner wie der Server – die Differenzen sind die Abweichungen, die
 * zwei Personen sähen. Die Frage erscheint client-seitig zum Serverzeitpunkt `startsAt` (Timer + Offset), die
 * Auflösung mit dem Server-Broadcast. Läuft im Projekt `sync`: zuletzt, ohne parallele Tests, mit Wiederholungen.
 */
import type { BrowserContext } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { playQuicklyUntil, waitForOverlay } from "./support/phases.ts";
import { type StageEvent, stageEvents } from "./support/stage-recorder.ts";

/** docs/09 §13: „Overlays laufen auf zwei Geräten sichtbar synchron (Abweichung < 150 ms)“. */
const MAX_SKEW_MS = 150;

/** Falsch gehende Geräte-Uhren (ms) – der Uhrenabgleich der App muss sie ausgleichen. */
const CLOCK_ERROR_MS = { mia: 4_321, ben: -2_109 } as const;

/** Pflicht-Stichproben laut Auftrag: Frage und Auflösung. */
const REQUIRED = ["overlay-question", "overlay-answer-reveal"] as const;

interface Skew {
  overlay: string;
  /** n-tes Auftreten dieses Overlays (0-basiert) */
  occurrence: number;
  /** Differenz der Einhängezeit in Serverzeit bzw. des ersten gezeichneten Frames (ms) */
  insertedMs: number;
  paintedMs: number;
}

/** Verschiebt `Date.now` aller Seiten des Kontexts (vor dem App-Code, wie eine falsch gestellte Geräte-Uhr). */
async function skewClock(context: BrowserContext, errorMs: number): Promise<void> {
  await context.addInitScript((offset: number) => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + offset;
  }, errorMs);
}

/** Ordnet die Overlays beider Seiten nach Typ und Reihenfolge einander zu. */
function skews(a: readonly StageEvent[], aClockError: number, b: readonly StageEvent[], bClockError: number): Skew[] {
  const byType = (events: readonly StageEvent[]) => {
    const map = new Map<string, StageEvent[]>();
    for (const event of events) map.set(event.testId, [...(map.get(event.testId) ?? []), event]);
    return map;
  };
  const left = byType(a);
  const right = byType(b);
  const result: Skew[] = [];
  for (const [overlay, events] of left) {
    const others = right.get(overlay) ?? [];
    expect(others.length, `${overlay}: gleich oft auf beiden Geräten`).toBe(events.length);
    for (const [occurrence, event] of events.entries()) {
      const other = others[occurrence];
      if (!other || event.frameAt === null || other.frameAt === null) continue;
      result.push({
        overlay,
        occurrence,
        insertedMs: Math.abs(event.at - aClockError - (other.at - bClockError)),
        paintedMs: Math.round(Math.abs(event.frameAt - other.frameAt)),
      });
    }
  }
  return result;
}

test.describe.configure({ mode: "serial" });

test("zwei Geräte mit falsch gehenden Uhren zeigen die Overlays zeitgleich (< 150 ms)", async ({
  players,
}, testInfo) => {
  test.setTimeout(180_000);
  const mia = await players.create("Mia");
  const ben = await players.create("Ben");
  await skewClock(mia.page.context(), CLOCK_ERROR_MS.mia);
  await skewClock(ben.page.context(), CLOCK_ERROR_MS.ben);
  const code = await mia.createLobby();
  await ben.joinByCode(code);
  // Die Uhren gehen wirklich verschieden (sonst wäre die Prüfung wertlos).
  const clocks = await Promise.all([mia, ben].map((player) => player.page.evaluate(() => Date.now())));
  expect(Math.abs((clocks[0] ?? 0) - (clocks[1] ?? 0))).toBeGreaterThan(6_000);
  await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
  await mia.startGame();

  // Beide wählen (wenn dran) und antworten sofort richtig – frühe Auflösung, Spiel bis zum Ende.
  await playQuicklyUntil([mia, ben], "game-over");
  await waitForOverlay(ben, "game-over");
  const [miaEvents, benEvents] = await Promise.all([stageEvents(mia.page), stageEvents(ben.page)]);
  const measured = skews(miaEvents, CLOCK_ERROR_MS.mia, benEvents, CLOCK_ERROR_MS.ben);
  await testInfo.attach("synchronitaet.json", {
    body: JSON.stringify(measured, null, 2),
    contentType: "application/json",
  });
  const worst = Math.max(...measured.map((skew) => Math.max(skew.insertedMs, skew.paintedMs)));
  testInfo.annotations.push({
    type: "Synchronität",
    description: `${measured.length} Overlays, größte Abweichung ${worst} ms (${measured
      .map((skew) => `${skew.overlay.replace("overlay-", "")}#${skew.occurrence + 1}: ${skew.paintedMs} ms`)
      .join(", ")})`,
  });

  // Stichprobe: 2 Züge → je 2 Fragen und Auflösungen, dazu Intro, Kategoriewahl/-Einblendung, Zug-Ergebnis,
  // Rundentafel und Spielende.
  for (const overlay of REQUIRED) {
    expect(
      measured.filter((skew) => skew.overlay === overlay),
      `${overlay}: Messungen`,
    ).toHaveLength(2);
  }
  for (const skew of measured) {
    const label = `${skew.overlay} #${skew.occurrence + 1}`;
    expect(skew.insertedMs, `${label}: Einhängen (Serverzeit)`).toBeLessThan(MAX_SKEW_MS);
    expect(skew.paintedMs, `${label}: erster Frame`).toBeLessThan(MAX_SKEW_MS);
  }
});
