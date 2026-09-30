/**
 * Zustand einer Lobby inklusive laufendem Spiel (docs/02 §Engine-Muster, docs/04 lobbies). Der Zustand
 * ist reines JSON (keine Maps, Dates oder Funktionen) und wird von der Engine nie verändert: `reduce`
 * liefert immer ein neues Objekt (strukturelles Teilen unveränderter Teile).
 *
 * GEHEIM (nur Server): `guestId`, richtige Antworten (`correct`, `shownOrder`), Erklärungen, Antworten
 * vor der Auflösung. Clients bekommen ausschließlich `toPublicState`/`toPrivateState` (projection.ts).
 */
import type {
  AnswerIndex,
  CategoryOption,
  Difficulty,
  GameTimingMode,
  LobbySettings,
  Media,
  Phase,
  PlayerColor,
  PlayerStatus,
  PublicLobbyState,
  PublicQuestion,
} from "@quizmaster/shared";

/** Arten der Engine-Timer (Effect `scheduleTimer`, Command `TIMEOUT`). */
export const TIMER_KINDS = [
  /** Ende der laufenden Phase (Intro, Kategoriewahl, Frage inkl. Kulanz/früher Auflösung, Auflösung …). */
  "phase",
  /** Reconnect-Frist einer getrennten Person (Lobby 30 s, Spiel 90 s). */
  "reconnect",
  /** Host-Übergabe 30 s nach Trennung des Hosts. */
  "host_handover",
  /** Lobby schließen, wenn 60 s lang kein Mensch verbunden ist. */
  "empty_close",
  /** Lobby schließen: 30 min ohne Aktivität (Phase lobby) bzw. 2 h nach Spielende (game_over). */
  "idle_close",
  /**
   * Frist der offenen Anfrage an die Shell (`offerCategories`/`loadQuestions`, `SHELL_REQUEST_TIMEOUT_MS`):
   * bleibt eine gültige Antwort aus, endet das Spiel mit `load_failed` statt ewig zu warten.
   */
  "request",
] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

/** Geplanter Timer. Ein `TIMEOUT` mit unbekanntem Token ist veraltet und wird ignoriert. */
export interface PendingTimer {
  /** Eindeutig je Lobby (fortlaufend aus `LobbyState.seq`). */
  token: number;
  kind: TimerKind;
  /** Fälligkeit (Serverzeit, ms). */
  at: number;
  /** Betroffene Person (reconnect: getrennte Person, host_handover: getrennter Host), sonst `null`. */
  playerId: string | null;
}

/** Gründe, aus denen eine Lobby schließt (docs/01 §Lobby „Schließen“). */
export const CLOSE_REASONS = ["empty", "idle", "after_game"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/** Person in der Lobby (Server-Sicht, enthält die geheime guestId). */
export interface EnginePlayer {
  /** Öffentlich, zufällig – NICHT die guestId. */
  playerId: string;
  /** GEHEIM (nur Server). Menschen: UUID aus dem Ticket; Dev-Bots: synthetisch „bot:…“. */
  guestId: string;
  name: string;
  color: PlayerColor;
  isBot: boolean;
  /** Beitritt (Serverzeit) – „am längsten anwesend“ für die Host-Übergabe. */
  joinedAt: number;
  connected: boolean;
  /** Zeitpunkt der Trennung (Basis der Fristen); `null` = verbunden. */
  disconnectedAt: number | null;
  /** Spielstatus; „resigned“ = aufgegeben (verlassen, Frist überschritten oder im Spiel entfernt). */
  status: PlayerStatus;
  /**
   * Nicht mehr Mitglied (verlassen, entfernt, Frist abgelaufen). In der Phase `lobby` werden solche
   * Personen sofort gelöscht; im Spiel und in `game_over` bleiben sie für Tafel und Ergebnis sichtbar
   * und werden bei der Revanche entfernt.
   */
  left: boolean;
}

/** Angezeigte Antworten einer Frage (genau 4, bereits gemischt/sortiert). */
export type ShownAnswers = PublicQuestion["answers"];

/** Mischung: `shownOrder[i]` = Index in den Repo-Antworten (`answers[0]` richtig) der an Position i gezeigten Antwort. */
export type ShownOrder = [AnswerIndex, AnswerIndex, AnswerIndex, AnswerIndex];

/** Eingegangene Antwort (vor der Auflösung geheim). */
export interface QuestionResponse {
  playerId: string;
  choice: AnswerIndex;
  /** Eingang (Serverzeit). */
  at: number;
}

/** Ergebnis einer Person für eine aufgelöste Frage. */
export interface QuestionOutcome {
  playerId: string;
  /** Gewählte Position oder `null` = keine Antwort (zählt als falsch). */
  choice: AnswerIndex | null;
  correct: boolean;
  /** Antwortzeit ab `startsAt` in ms; `null` ohne Antwort. */
  ms: number | null;
}

/** Eine Frage eines Zuges (Instanz in diesem Spiel). */
export interface QuestionState {
  /** Öffentliche, zufällige Instanz-ID – nicht die DB-ID. */
  instanceId: string;
  /** DB-ID (z. B. „rw-8f3k2m1q“) – nur Server (Bewertungen, Meldungen, Statistik). */
  questionId: string;
  categoryId: string;
  difficulty: Difficulty;
  prompt: string;
  answers: ShownAnswers;
  shownOrder: ShownOrder;
  /** GEHEIM bis `reveal`: Position der richtigen Antwort in `answers`. */
  correct: AnswerIndex;
  /** GEHEIM bis `reveal`. */
  explanation: string | null;
  media: Media;
  /** Ab hier sichtbar (Serverzeit); `null`, solange die Frage noch nicht gestellt wurde. */
  startsAt: number | null;
  /** Antwortschluss (Serverzeit); Antworten zählen bis `deadline + deadlineGraceMs`. */
  deadline: number | null;
  /** Antworten in Eingangsreihenfolge (eine je Person). */
  responses: QuestionResponse[];
  /** Ergebnis je aktiver Person, gesetzt bei der Auflösung; `null` = noch nicht aufgelöst. */
  outcomes: QuestionOutcome[] | null;
}

/** Wie die Kategorie eines Zuges bestimmt wurde (GameDoc `pickedBy`). */
export type PickedBy = "player" | "timeout";

/** Ein Zug: Kategoriewahl einer Person + die Fragen dieser Kategorie. */
export interface TurnState {
  /** Laufende Nummer im Spiel (1-basiert). */
  number: number;
  /** Runde (1-basiert). */
  round: number;
  pickerId: string;
  options: [CategoryOption, CategoryOption, CategoryOption];
  /** Gewählte Kategorie; `null` bis zur Wahl. */
  categoryId: string | null;
  pickedBy: PickedBy | null;
  /** Aktive Personen bei Zugbeginn (Spalten der Tafelzeile), in Spielreihenfolge. */
  participantIds: string[];
  /** Fragen des Zuges (leer bis QUESTIONS_READY). */
  questions: QuestionState[];
  /** Index der gestellten Frage in `questions`; −1 = noch keine gestellt. */
  currentIndex: number;
}

/**
 * Offene Anfrage an die Shell (Antwort per OPTIONS_READY / QUESTIONS_READY / LOAD_FAILED mit gleichem
 * Token). Der nächste Zug (Runde, Position in der Reihenfolge) wird erst mit OPTIONS_READY übernommen.
 */
export type PendingRequest =
  | { kind: "options"; token: number; pickerId: string; round: number; orderIndex: number }
  | { kind: "questions"; token: number; categoryId: string };

/** Endergebnis (Rangliste + Ausgang), wie im öffentlichen Zustand. */
export type GameResults = NonNullable<PublicLobbyState["results"]>;
export type RankingEntry = GameResults["ranking"][number];

/** Warum ein Spiel endete. */
export const GAME_END_REASONS = ["completed", "not_enough_players", "load_failed"] as const;
export type GameEndReason = (typeof GAME_END_REASONS)[number];

/** Laufendes bzw. zuletzt beendetes Spiel. */
export interface GameState {
  /** `_id` des games-Dokuments. */
  gameId: string;
  startedAt: number;
  endedAt: number | null;
  endReason: GameEndReason | null;
  /** Ausgeloste Reihenfolge der Kategoriewahl (playerIds), gilt für alle Runden. */
  order: string[];
  /** Runde des aktuellen bzw. zuletzt begonnenen Zuges (1-basiert; im Intro 1). */
  round: number;
  /** Position in `order` des aktuellen bzw. zuletzt begonnenen Zuges von `round`; −1 = noch keiner. */
  orderIndex: number;
  /** Alle Züge (chronologisch); der letzte ist der aktuelle. */
  turns: TurnState[];
  pending: PendingRequest | null;
  /** Ab `game_over`. */
  results: GameResults | null;
}

/** Vollständiger Zustand einer Lobby. */
export interface LobbyState {
  /** Server-interne ID (`lobbies._id`). */
  lobbyId: string;
  code: string;
  /** Timing-Modus (docs/05 §Timings); `fast` nur für E2E. */
  timing: GameTimingMode;
  /** Steigt bei jeder Änderung des öffentlichen Zustands. */
  rev: number;
  phase: Phase;
  /** Kennung der laufenden Phase (neu bei jedem Phasenwechsel); zugleich Token des Phasen-Timers. */
  phaseToken: number;
  phaseStartedAt: number;
  /** Serverzeit; `null` = wartet auf eine Aktion. */
  phaseEndsAt: number | null;
  createdAt: number;
  /** Letzte Zustandsänderung (für `lobbies.updatedAt`). */
  updatedAt: number;
  /** Letzte Aktion einer Person (für „30 min ohne Aktivität“). */
  lastActivityAt: number;
  /** GEHEIM: guestId der erstellenden Person (max. 1 aktive gehostete Lobby pro Gast). */
  createdByGuestId: string;
  hostPlayerId: string;
  settings: LobbySettings;
  /** Personen in Beitrittsreihenfolge. */
  players: EnginePlayer[];
  /** Gäste, die der Host entfernt hat – dürfen dieser Lobby nicht erneut beitreten. */
  bannedGuestIds: string[];
  /** Zuletzt vergebenes Token (Timer, Anfragen, Phasen). */
  seq: number;
  timers: PendingTimer[];
  game: GameState | null;
  /** Gesetzt, sobald die Lobby geschlossen ist (danach werden alle Commands abgelehnt). */
  closed: { at: number; reason: CloseReason } | null;
}

/** Phasen eines laufenden Spiels (Intro bis Rundentafel). */
export const RUNNING_PHASES = ["intro", "category_pick", "question", "reveal", "turn_summary", "round_board"] as const;
export type RunningPhase = (typeof RUNNING_PHASES)[number];

export function isRunningPhase(phase: Phase): phase is RunningPhase {
  return (RUNNING_PHASES as readonly Phase[]).includes(phase);
}
