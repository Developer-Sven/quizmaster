/**
 * Phasenuhr (docs/05 §Uhrenabgleich, docs/09 §7, ADR-020): Alle Overlays und Timer rechnen mit der
 * Serverzeit `Date.now() + offset` gegen `phaseStartedAt`, `phaseEndsAt`, `startsAt` und `deadline`.
 * Dadurch sehen alle Personen jede Einblendung zur selben Zeit – auch nach einem Reconnect setzt die
 * Bühne an der richtigen Stelle fort. Reine Funktionen (Zeiten in ms), ohne Uhrzugriff.
 */
import { type GameTimingMode, type Phase, type PublicLobbyState, TIMINGS } from "@quizmaster/shared";

/** Serverzeit aus Client-Zeit und Uhren-Offset (`offset = serverNow − clientNow`). */
export function toServerTime(clientNow: number, offset: number): number {
  return clientNow + offset;
}

/** Client-Zeit zu einem Serverzeitpunkt (für `setTimeout`). */
export function toClientTime(serverTime: number, offset: number): number {
  return serverTime - offset;
}

/** Restzeit bis `target` (Serverzeit) in ms, nie negativ; `null` ohne Ziel (Phase wartet auf eine Aktion). */
export function remainingMs(target: number | null, serverNow: number): number | null {
  if (target === null) return null;
  return Math.max(0, target - serverNow);
}

/** Seit `start` (Serverzeit) vergangene ms, nie negativ. */
export function elapsedMs(start: number, serverNow: number): number {
  return Math.max(0, serverNow - start);
}

/**
 * Was die Bühne zeigt (docs/09 §7). Die Phase `question` beginnt mit einem Vorlauf: vor der ersten Frage
 * eines Zuges läuft die Kategorie-Einblendung (2 s), vor weiteren Fragen eine kurze Pause (800 ms);
 * die Frage selbst erscheint erst ab `startsAt` (docs/05 §Phasen).
 */
export type StageKind =
  | "none"
  | "intro"
  | "category_pick"
  | "category_reveal"
  | "lead_in"
  | "question"
  | "answer_reveal"
  | "turn_summary"
  | "round_board"
  | "game_over";

type StageInput = Pick<PublicLobbyState, "phase" | "question">;

export function stageAt(state: StageInput, serverNow: number): StageKind {
  switch (state.phase) {
    case "lobby":
      return "none";
    case "intro":
      return "intro";
    case "category_pick":
      return "category_pick";
    case "question": {
      const question = state.question;
      if (!question) return "lead_in";
      if (serverNow >= question.startsAt) return "question";
      return question.index <= 1 ? "category_reveal" : "lead_in";
    }
    case "reveal":
      return "answer_reveal";
    case "turn_summary":
      return "turn_summary";
    case "round_board":
      return "round_board";
    case "game_over":
      return "game_over";
  }
}

/** Serverzeitpunkte, an denen sich `stageAt` innerhalb der aktuellen Phase ändert (Vorlauf → Frage). */
export function stageBoundaries(state: StageInput): number[] {
  if (state.phase === "question" && state.question) return [state.question.startsAt];
  return [];
}

/** Choreografie des Intros relativ zum Phasenbeginn (docs/09 §7.1, Intro 5 s – Spieltempo ADR-044). */
export const INTRO_TIMELINE = {
  /** Scrim, dann fahren die Avatare ein */
  scrimMs: 480,
  /** Titelkarte „Runde 1“ schiebt sich hoch */
  titleAtMs: 3_500,
  /** Ausblenden */
  exitAtMs: 4_600,
} as const;

export type IntroStage = "people" | "title" | "done";

export function introStage(elapsed: number): IntroStage {
  if (elapsed >= INTRO_TIMELINE.exitAtMs) return "done";
  if (elapsed >= INTRO_TIMELINE.titleAtMs) return "title";
  return "people";
}

/** Kategorie-Einblendung blendet 600 ms vor `startsAt` aus (2.400 von 3.000 ms, docs/09 §7.3). */
export const CATEGORY_REVEAL_EXIT_BEFORE_START_MS = 600;

/**
 * Auflösung blendet 500 ms vor ihrem Phasenende aus (docs/09 §7.6, Ende nach den Weiter-Einstellungen, ADR-045);
 * wartet sie auf den Host, bleibt sie stehen.
 */
export const ANSWER_REVEAL_EXIT_BEFORE_END_MS = 500;

/** Wandernder Rahmen bei der Kategoriewahl für Zuschauende (docs/09 §7.2): 1,2-s-Takt. */
export const PICK_HIGHLIGHT_STEP_MS = 1_200;

/** Kachel mit dem wandernden Rahmen (0–2) nach `elapsed` ms. */
export function pickHighlightIndex(elapsed: number, count = 3): number {
  if (count <= 0) return 0;
  return Math.floor(Math.max(0, elapsed) / PICK_HIGHLIGHT_STEP_MS) % count;
}

/**
 * Timing-Modus aus einer Phase mit fester Dauer (normal/fast, docs/05 §Timings) – `null`, wenn die Phase
 * keine feste Dauer hat (Lobby, Spielende, die einstellbaren Weiter-Phasen nach ADR-045) oder die Dauer zu keinem
 * Modus passt.
 */
export function inferTimingMode(
  state: Pick<PublicLobbyState, "phase" | "phaseStartedAt" | "phaseEndsAt" | "question">,
): GameTimingMode | null {
  const duration = (mode: GameTimingMode): number | null => {
    const timings = TIMINGS[mode];
    switch (state.phase) {
      case "intro":
        return timings.introMs;
      case "category_pick":
        return timings.categoryPickMs;
      default:
        return null;
    }
  };
  if (state.phase === "question" && state.question) {
    const answerWindow = state.question.deadline - state.question.startsAt;
    if (answerWindow === TIMINGS.fast.answerMs) return "fast";
    if (answerWindow === TIMINGS.normal.answerMs) return "normal";
    return null;
  }
  if (state.phaseEndsAt === null) return null;
  const actual = state.phaseEndsAt - state.phaseStartedAt;
  if (actual === duration("fast")) return "fast";
  if (actual === duration("normal")) return "normal";
  return null;
}

/** Reconnect-Frist (Lobby 30 s, im Spiel und danach 90 s – docs/05 §Timings). */
export function reconnectGraceMs(phase: Phase, mode: GameTimingMode): number {
  const timings = TIMINGS[mode];
  return phase === "lobby" ? timings.reconnectLobbyMs : timings.reconnectGameMs;
}

/** Countdown „m:ss“ (aufgerundete Sekunden, nie negativ): 90 000 → „1:30“, 4 200 → „0:05“. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const secondsPart = total % 60;
  return `${minutes}:${String(secondsPart).padStart(2, "0")}`;
}
