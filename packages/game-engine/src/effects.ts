/**
 * Effects von `reduce` (docs/02 §Engine-Muster) – die Shell (Realtime-LobbyActor) führt sie in der
 * gelieferten Reihenfolge aus. Ergänzungen gegenüber docs/02 (dokumentiert):
 * - `notice` (HOST_CHANGED, PLAYER_LEFT) für das Server-Event `notice`,
 * - `cancelTimer` (Aufräumen; veraltete Timer würden ohnehin ignoriert),
 * - `closeLobby` (Lobby geschlossen → aus der Registry entfernen, `active: false` speichern),
 * - Tokens an `offerCategories`/`loadQuestions` (Antwort muss dasselbe Token tragen),
 * - `guestId` an `kick`/`sendPrivate` (Socket-Zuordnung, auch wenn die Person schon entfernt ist),
 * - `gameFinished` trägt das fertige games-Dokument und die Statistik-Deltas.
 */
import type { Difficulty, DifficultyRule, KickReason, NoticeCode } from "@quizmaster/shared";
import type { GameDoc } from "@quizmaster/shared/documents";
import type { CloseReason, TimerKind } from "./types.ts";

/** Daten für die Kategorieauswahl (`offerCategories()` in selection/category-offer.ts). */
export interface TurnRef {
  gameId: string;
  /** Runde des anstehenden Zuges (1-basiert). */
  round: number;
  /** Laufende Nummer des anstehenden Zuges im Spiel (1-basiert). */
  turnNumber: number;
  /** Wählende Person (playerId). */
  pickerId: string;
  /** K = Fragen pro Kategorie. */
  questionsPerTurn: number;
  /** Kategorien der bisherigen Züge, chronologisch (letzter Eintrag = Kategorie des letzten Zuges). */
  playedCategoryIds: string[];
  /** Im Spiel bereits benutzte Fragen (DB-IDs) – nie doppelt im selben Spiel. */
  usedQuestionIds: string[];
  /** Auswahl des Hosts (`settings.categoryIds`, ADR-048); `null` = alle spielbaren Kategorien. */
  categoryIds: string[] | null;
  /** Schwierigkeitsbereich (ADR-055): angeboten werden nur Kategorien mit Fragen darin. */
  difficulty: { min: Difficulty; max: Difficulty };
}

/** Anlass eines Snapshots (Shell speichert entprellt in `lobbies`). */
export const PERSIST_REASONS = [
  "closed",
  "game_over",
  "game_started",
  "created",
  "players",
  "host",
  "settings",
  "phase",
] as const;
export type PersistReason = (typeof PERSIST_REASONS)[number];

/** Statistik-Delta je Gast (ohne Bots) für den Spielabschluss (docs/04 §Fragenauswahl 6). */
export interface GuestGameStats {
  guestId: string;
  /** Platz 1 bei Ausgang „win“ (als aktive Person). */
  won: boolean;
  /** Ausgang „draw“ (als aktive Person). */
  draw: boolean;
  /** Aufgelöste Fragen, an denen die Person teilnahm (keine Antwort zählt mit). */
  answers: number;
  correct: number;
  /** Gesehene Fragen (DB-IDs, Spielreihenfolge) für `recentQuestionIds` ($push + $slice: -1000). */
  questionIds: string[];
}

/** Statistik-Delta je Frage (nur menschliche Teilnehmende, `$inc` shown/correct). */
export interface QuestionGameStats {
  questionId: string;
  shown: number;
  correct: number;
}

export interface GameStats {
  guests: GuestGameStats[];
  questions: QuestionGameStats[];
}

export type Effect =
  /** Shell sendet `toPublicState(state)` als `lobby:state` an den Lobby-Raum. */
  | { type: "broadcast" }
  /** Shell sendet `toPrivateState(state, playerId)` als `lobby:self` an die Sockets dieser Person. */
  | { type: "sendPrivate"; playerId: string; guestId: string }
  /** Server-Event `notice { code }` an den Lobby-Raum. */
  | { type: "notice"; code: Extract<NoticeCode, "HOST_CHANGED" | "PLAYER_LEFT" | "GAME_ENDED"> }
  /** `kicked { reason }` an die Sockets der Person senden und sie aus dem Raum entfernen. */
  | { type: "kick"; playerId: string; guestId: string; reason: KickReason }
  /** Timer stellen; bei Fälligkeit `TIMEOUT { token }` dispatchen. */
  | { type: "scheduleTimer"; at: number; token: number; kind: TimerKind; playerId: string | null }
  /** Timer ist hinfällig (darf gelöscht werden). */
  | { type: "cancelTimer"; token: number }
  /** Kategorien anbieten (`offerCategories()`, 3 bzw. bei einer Auswahl des Hosts 1–3) → `OPTIONS_READY`. */
  | { type: "offerCategories"; token: number; turn: TurnRef }
  /** Fragen ziehen (`drawQuestions()`), Spielinhalte liefern → `QUESTIONS_READY { token, questions }`. */
  | {
      type: "loadQuestions";
      token: number;
      categoryId: string;
      count: number;
      excludeQuestionIds: string[];
      /** Schwierigkeit des Zuges (ADR-055) */
      difficulty: DifficultyRule;
    }
  /** Snapshot in `lobbies` schreiben (`toLobbySnapshot(state)`, entprellt). */
  | { type: "persist"; reason: PersistReason }
  /** Spiel beendet: games-Dokument + Gast-/Fragen-Statistik in einer Transaktion schreiben. */
  | { type: "gameFinished"; game: GameDoc; stats: GameStats }
  /** Lobby ist geschlossen: aus der Registry entfernen, Timer löschen, Snapshot `active: false`. */
  | { type: "closeLobby"; reason: CloseReason };

export type EffectType = Effect["type"];

/** Reihenfolge, in der Effects ausgeliefert werden (stabil innerhalb eines Typs). */
export const EFFECT_ORDER: readonly EffectType[] = [
  "kick",
  "broadcast",
  "sendPrivate",
  "notice",
  "cancelTimer",
  "scheduleTimer",
  "offerCategories",
  "loadQuestions",
  "gameFinished",
  "persist",
  "closeLobby",
];
