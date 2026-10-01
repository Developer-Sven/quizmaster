/**
 * Protokoll der Bühnen-Overlays im Browser (docs/09 §7): Mit `GAME_TIMING=fast` stehen Auflösung,
 * Zug-Ergebnis und Rundentafel nur 300 ms auf dem Schirm – zu kurz für zuverlässiges Polling. Ein
 * MutationObserver (Init-Skript, läuft vor dem App-Code) vermerkt deshalb jedes eingefügte Overlay
 * (`data-testid="overlay-…"`) mit Zeitpunkt, HUD-Fortschritt, Überschrift und Zeilenzahl.
 */
import type { Page } from "@playwright/test";

export interface StageEvent {
  /** z. B. `overlay-turn-summary` */
  testId: string;
  /** Client-Zeit (ms) */
  at: number;
  /** HUD-Fortschritt beim Einfügen, z. B. „Runde 1/2 · Zug 3/3“ */
  progress: string;
  /** erste Überschrift im Overlay (z. B. „Runde 1 von 2“) */
  heading: string;
  /** Zeilen im Zug-Ergebnis */
  rows: number;
  /** Kategoriestreifen beim Einfügen, z. B. „Bücher & Wörter1/2“ */
  strip: string;
  /** Auflösung: eine Antwort ist als richtig markiert */
  correctMarked: boolean;
}

interface StageWindow {
  __qmStage?: StageEvent[];
}

/** Init-Skript (wird serialisiert – nur Browser-APIs, keine Imports). */
export function installStageRecorder(): void {
  const target = window as unknown as StageWindow;
  if (target.__qmStage) return;
  const events: StageEvent[] = [];
  target.__qmStage = events;
  const record = (element: Element) => {
    events.push({
      testId: element.getAttribute("data-testid") ?? "",
      at: Date.now(),
      progress: document.querySelector('[data-testid="hud-progress"]')?.textContent?.trim() ?? "",
      heading: element.querySelector("h1, h2")?.textContent?.trim() ?? "",
      rows: element.querySelectorAll('[data-testid="turn-summary-row"]').length,
      strip: document.querySelector('[data-testid="category-strip"]')?.textContent?.trim() ?? "",
      correctMarked: element.querySelector('[data-state="correct"]') !== null,
    });
  };
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node.matches('[data-testid^="overlay-"]')) record(node);
    for (const element of node.querySelectorAll('[data-testid^="overlay-"]')) record(element);
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  }).observe(document, { childList: true, subtree: true });
}

/** Bisher vermerkte Overlays dieser Seite (seit dem letzten Laden des Dokuments). */
export async function stageEvents(page: Page): Promise<StageEvent[]> {
  return page.evaluate(() => [...((window as unknown as StageWindow).__qmStage ?? [])]);
}

/** Anzahl je Overlay-Typ. */
export function countByOverlay(events: readonly StageEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.testId] = (counts[event.testId] ?? 0) + 1;
  return counts;
}
