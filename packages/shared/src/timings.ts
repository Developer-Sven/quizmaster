/**
 * Phasen- und Fristzeiten in Millisekunden (docs/05 §Timings). `fast` nur für E2E-Tests
 * (`GAME_TIMING=fast`, in Produktion verboten – siehe Env-Regeln).
 */

export const GAME_TIMING_MODES = ["normal", "fast"] as const;
export type GameTimingMode = (typeof GAME_TIMING_MODES)[number];

export interface Timings {
  /** Intro (Auslosung der Reihenfolge). */
  readonly introMs: number;
  /** Kategoriewahl; danach Zufall aus den drei Optionen. */
  readonly categoryPickMs: number;
  /** Vorlauf vor der ersten Frage eines Zuges (`startsAt − Versand`, Kategorie-Einblendung). */
  readonly leadInFirstQuestionMs: number;
  /** Vorlauf vor jeder weiteren Frage im Zug. */
  readonly leadInNextQuestionMs: number;
  /** Antwortzeit ab `startsAt` bis `deadline`. */
  readonly answerMs: number;
  /** Kulanz nach der Deadline (Netzlaufzeit): Antworten bis `deadline + deadlineGraceMs` zählen. */
  readonly deadlineGraceMs: number;
  /** Frühe Auflösung, sobald alle verbundenen aktiven Personen geantwortet haben. */
  readonly earlyRevealMs: number;
  /** Auflösung (Phase `reveal`). */
  readonly revealMs: number;
  /** Zug-Ergebnis (Phase `turn_summary`). */
  readonly turnSummaryMs: number;
  /** Rundentafel (Phase `round_board`). */
  readonly roundBoardMs: number;
  /** Reconnect-Frist in der Lobby. */
  readonly reconnectLobbyMs: number;
  /** Reconnect-Frist im Spiel; danach gilt die Person als „Aufgegeben“. */
  readonly reconnectGameMs: number;
  /** Host-Übergabe nach Trennung des Hosts. */
  readonly hostHandoverMs: number;
  /** Lobby ohne verbundene Personen schließen. */
  readonly emptyLobbyCloseMs: number;
}

export const TIMINGS = {
  normal: {
    introMs: 4_000,
    categoryPickMs: 15_000,
    leadInFirstQuestionMs: 2_000,
    leadInNextQuestionMs: 800,
    answerMs: 20_000,
    deadlineGraceMs: 250,
    earlyRevealMs: 400,
    revealMs: 3_500,
    turnSummaryMs: 4_000,
    roundBoardMs: 6_000,
    reconnectLobbyMs: 30_000,
    reconnectGameMs: 90_000,
    hostHandoverMs: 30_000,
    emptyLobbyCloseMs: 60_000,
  },
  fast: {
    introMs: 300,
    categoryPickMs: 1_500,
    leadInFirstQuestionMs: 150,
    leadInNextQuestionMs: 100,
    answerMs: 2_000,
    deadlineGraceMs: 250,
    earlyRevealMs: 50,
    revealMs: 300,
    turnSummaryMs: 300,
    roundBoardMs: 300,
    reconnectLobbyMs: 2_000,
    reconnectGameMs: 5_000,
    hostHandoverMs: 2_000,
    emptyLobbyCloseMs: 2_000,
  },
} as const satisfies Record<GameTimingMode, Timings>;

export function getTimings(mode: GameTimingMode): Timings {
  return TIMINGS[mode];
}

/** Vorlauf vor der Frage `indexInTurn` (1-basiert: 1 = erste Frage des Zuges). */
export function questionLeadInMs(timings: Timings, indexInTurn: number): number {
  return indexInTurn <= 1 ? timings.leadInFirstQuestionMs : timings.leadInNextQuestionMs;
}

/**
 * Lebensdauer von Lobbys unabhängig vom Timing-Modus (docs/01 §Lobby „Schließen“, docs/04 lobbies):
 * 30 min ohne Aktivität, 2 h nach Spielende.
 */
export const LOBBY_LIFETIME = {
  idleCloseMs: 30 * 60_000,
  afterGameCloseMs: 2 * 60 * 60_000,
} as const;
