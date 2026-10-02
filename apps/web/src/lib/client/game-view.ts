/**
 * Abgeleitete Ansichtsdaten für Lobby und Spiel – reine Funktionen über den öffentlichen und privaten
 * Zustand (docs/05 §Zustände). Keine Geheimnisse: vor `reveal` gibt es weder `correct` noch `picks`.
 * Die Regeln für Plätze entsprechen der Engine (gleiche Punkte = gleicher Platz, Aufgegebene hinter
 * allen Aktiven; docs/01 §Punkte & Ergebnis).
 */
import type {
  AnswerIndex,
  BoardRow,
  CategoryOption,
  Phase,
  PlayerStatus,
  PrivatePlayerState,
  PublicLobbyState,
  PublicPlayer,
  PublicQuestion,
} from "@quizmaster/shared";
import type { AnswerPicker, AnswerState } from "../../components/ui/answer-button";
import { de } from "../../i18n/de";
import type { CategoryVisual } from "../ui/category";

/** Bekannte Kategorien dieser Lobby (id → Darstellung aus den Daten). */
export type CategoryCatalog = Readonly<Record<string, CategoryOption>>;

/** Laufende Spielphasen (ohne Lobby und Spielende). */
const RUNNING_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "intro",
  "category_pick",
  "question",
  "reveal",
  "turn_summary",
  "round_board",
]);

export function isRunningPhase(phase: Phase): boolean {
  return RUNNING_PHASES.has(phase);
}

export function findPlayer(players: readonly PublicPlayer[], id: string | null | undefined): PublicPlayer | undefined {
  if (id === null || id === undefined) return undefined;
  return players.find((player) => player.id === id);
}

export function hostPlayer(players: readonly PublicPlayer[]): PublicPlayer | undefined {
  return players.find((player) => player.isHost);
}

/** Eigene Person zuerst, sonst Reihenfolge der Lobby (docs/09 §7 Spielerstreifen). */
export function playersSelfFirst(players: readonly PublicPlayer[], selfId: string | null): PublicPlayer[] {
  const self = findPlayer(players, selfId);
  return self ? [self, ...players.filter((player) => player.id !== self.id)] : [...players];
}

/** Verbundene Personen (Bots zählen) – „Spiel starten“ ab 2 (docs/01 §Lobby). */
export function connectedCount(players: readonly PublicPlayer[]): number {
  return players.filter((player) => player.connected).length;
}

/** Personen des laufenden bzw. letzten Spiels (in Wahl-Reihenfolge); ohne Spiel alle. */
export function gameParticipants(state: Pick<PublicLobbyState, "players" | "order">): PublicPlayer[] {
  if (!state.order) return [...state.players];
  return state.order.flatMap((id) => {
    const player = findPlayer(state.players, id);
    return player ? [player] : [];
  });
}

/** Darstellung einer Kategorie; unbekannte IDs bekommen einen neutralen Platzhalter (kein Icon). */
export function categoryVisual(catalog: CategoryCatalog, id: string | null | undefined): CategoryVisual {
  const option = id ? catalog[id] : undefined;
  if (option) return { name: option.name, icon: option.icon, color: option.color };
  return { name: de.game.unknownCategory, icon: "", color: "" };
}

/** Kategorie-IDs, die Tafel, Zug oder Frage zeigen, deren Darstellung aber (noch) unbekannt ist. */
export function missingCategoryIds(
  state: Pick<PublicLobbyState, "board" | "turn" | "question"> | null,
  catalog: CategoryCatalog,
): string[] {
  if (!state) return [];
  const ids = new Set<string>();
  for (const row of state.board) ids.add(row.categoryId);
  if (state.turn?.categoryId) ids.add(state.turn.categoryId);
  if (state.question) ids.add(state.question.categoryId);
  return [...ids].filter((id) => !catalog[id]);
}

/** Neue Optionen in den Katalog übernehmen; liefert denselben Katalog, wenn sich nichts ändert. */
export function mergeCategories(catalog: CategoryCatalog, options: readonly CategoryOption[]): CategoryCatalog {
  const changed = options.some((option) => {
    const known = catalog[option.id];
    return !known || known.name !== option.name || known.icon !== option.icon || known.color !== option.color;
  });
  if (!changed) return catalog;
  const next: Record<string, CategoryOption> = { ...catalog };
  for (const option of options) next[option.id] = { ...option };
  return next;
}

// ---------------------------------------------------------------------------------------------
// Frage und Auflösung
// ---------------------------------------------------------------------------------------------

/** Eigene Antwort auf die laufende Frage: bestätigt (`lobby:self`) oder gerade getippt (optimistisch). */
export function myChoiceFor(
  question: Pick<PublicQuestion, "id"> | null,
  self: PrivatePlayerState | null,
  pending: { questionId: string; choice: AnswerIndex } | null,
): AnswerIndex | null {
  if (!question) return null;
  if (self?.myAnswer && self.myAnswer.questionId === question.id) return self.myAnswer.choice;
  if (pending && pending.questionId === question.id) return pending.choice;
  return null;
}

/**
 * Wie viele verbundene aktive Personen noch antworten müssen („Warte auf 2 weitere …“) – ohne die
 * eigene Person. Getrennte zählen nicht (die frühe Auflösung wartet nicht auf sie, docs/05 §Phasen).
 */
export function answerWaitingCount(
  state: Pick<PublicLobbyState, "players" | "question">,
  selfId: string | null,
): number {
  const answered = new Set(state.question?.answeredBy ?? []);
  return state.players.filter(
    (player) => player.id !== selfId && player.status === "active" && player.connected && !answered.has(player.id),
  ).length;
}

const ANSWER_POSITIONS = [0, 1, 2, 3] as const satisfies readonly AnswerIndex[];

/** Zustände der vier Antworten während der Frage (docs/09 §7.4–5). */
export function questionAnswerStates(
  choice: AnswerIndex | null,
  canAnswer: boolean,
  presenting = false,
): AnswerState[] {
  return ANSWER_POSITIONS.map((index) => {
    if (choice !== null) return index === choice ? "locked" : "dimmed";
    if (canAnswer) return "idle";
    // Anzeige-Modus (ADR-046): voll lesbar statt ausgegraut – nur nicht bedienbar.
    return presenting ? "view" : "disabled";
  });
}

/** Zustände in der Auflösung: richtig grün, eigene falsche rot, übrige gedimmt (docs/09 §7.6). */
export function revealAnswerStates(correct: AnswerIndex | undefined, choice: AnswerIndex | null): AnswerState[] {
  return ANSWER_POSITIONS.map((index) => {
    if (index === correct) return "correct";
    if (index === choice) return "wrong";
    return "dimmed";
  });
}

/** Personen je Antwort (Auflösung): Avatare in der Reihenfolge der Lobby. */
export function pickersByAnswer(
  picks: Readonly<Record<string, AnswerIndex | null>> | undefined,
  players: readonly PublicPlayer[],
): AnswerPicker[][] {
  const result: AnswerPicker[][] = [[], [], [], []];
  if (!picks) return result;
  for (const player of players) {
    const pick = picks[player.id];
    if (pick === undefined || pick === null) continue;
    result[pick]?.push({ id: player.id, name: player.name, color: player.color });
  }
  return result;
}

/** Hat die eigene Person an der Frage teilgenommen, aber nicht geantwortet? („Zeit abgelaufen“) */
export function missedAnswer(
  picks: Readonly<Record<string, AnswerIndex | null>> | undefined,
  selfId: string | null,
): boolean {
  if (!picks || selfId === null || !Object.hasOwn(picks, selfId)) return false;
  return picks[selfId] === null;
}

// ---------------------------------------------------------------------------------------------
// Zug-Ergebnis, Tafel, Plätze
// ---------------------------------------------------------------------------------------------

export interface TurnSummaryEntry {
  playerId: string;
  results: ReadonlyArray<boolean | null>;
  /** Punkte dieses Zuges (+1 je richtiger Antwort) */
  points: number;
}

export interface TurnSummary {
  row: BoardRow;
  /** nach Punkten dieses Zuges, absteigend (stabil: Reihenfolge der Tafel) */
  entries: TurnSummaryEntry[];
  /** beste Person(en) – leer, wenn niemand gepunktet hat */
  bestPlayerIds: string[];
}

export function summarizeTurn(row: BoardRow): TurnSummary {
  const entries = Object.entries(row.results)
    .map(([playerId, results]) => ({
      playerId,
      results,
      points: results.filter((result) => result === true).length,
    }))
    .sort((a, b) => b.points - a.points);
  const best = entries[0]?.points ?? 0;
  return {
    row,
    entries,
    bestPlayerIds: best > 0 ? entries.filter((entry) => entry.points === best).map((entry) => entry.playerId) : [],
  };
}

/** Tafelzeile des aktuellen Zuges (Zug-Ergebnis): letzte Zeile der wählenden Person mit dieser Kategorie. */
export function currentTurnRow(state: Pick<PublicLobbyState, "board" | "turn" | "progress">): BoardRow | null {
  const turn = state.turn;
  for (let index = state.board.length - 1; index >= 0; index--) {
    const row = state.board[index];
    if (!row) continue;
    if (!turn) return row;
    if (
      row.pickerId === turn.pickerId &&
      row.categoryId === turn.categoryId &&
      (!state.progress || row.round === state.progress.round)
    ) {
      return row;
    }
  }
  return null;
}

/** Index der ersten Tafelzeile einer Runde (für „neue Zeilen füllen sich animiert“). */
export function firstRowOfRound(board: readonly BoardRow[], round: number): number {
  const index = board.findIndex((row) => row.round === round);
  return index === -1 ? board.length : index;
}

interface StandingInput {
  playerId: string;
  status: PlayerStatus;
  score: number;
}

/** Plätze: gleiche Punkte = gleicher Platz (1, 1, 3 …), Aufgegebene hinter allen Aktiven. */
export function placesFor(entries: readonly StandingInput[]): Map<string, number> {
  const places = new Map<string, number>();
  const assign = (group: readonly StandingInput[], firstPlace: number) => {
    const sorted = [...group].sort((a, b) => b.score - a.score);
    let previous: { score: number; place: number } | null = null;
    sorted.forEach((entry, index) => {
      const place = previous !== null && previous.score === entry.score ? previous.place : firstPlace + index;
      places.set(entry.playerId, place);
      previous = { score: entry.score, place };
    });
  };
  const active = entries.filter((entry) => entry.status === "active");
  assign(active, 1);
  assign(
    entries.filter((entry) => entry.status !== "active"),
    active.length + 1,
  );
  return places;
}

/** Punkte je Person aus den Tafelzeilen bis einschließlich Runde `round`. */
export function pointsUntilRound(board: readonly BoardRow[], round: number): Map<string, number> {
  const points = new Map<string, number>();
  for (const row of board) {
    if (row.round > round) continue;
    for (const [playerId, results] of Object.entries(row.results)) {
      points.set(playerId, (points.get(playerId) ?? 0) + results.filter((result) => result === true).length);
    }
  }
  return points;
}

/** Plätze nach Runde `round` (Grundlage der Pfeile auf der Rundentafel). */
export function standingsAfterRound(
  board: readonly BoardRow[],
  players: ReadonlyArray<Pick<PublicPlayer, "id" | "status">>,
  round: number,
): Map<string, number> {
  const points = pointsUntilRound(board, round);
  return placesFor(
    players.map((player) => ({ playerId: player.id, status: player.status, score: points.get(player.id) ?? 0 })),
  );
}

/** Platzwechsel in Runde `round` gegenüber der Vorrunde (`arrow-up`/`arrow-down`); Runde 1 ohne Pfeile. */
export function rankChanges(
  board: readonly BoardRow[],
  players: ReadonlyArray<Pick<PublicPlayer, "id" | "status">>,
  round: number,
): Record<string, "up" | "down" | null> {
  const changes: Record<string, "up" | "down" | null> = {};
  if (round <= 1) {
    for (const player of players) changes[player.id] = null;
    return changes;
  }
  const before = standingsAfterRound(board, players, round - 1);
  const after = standingsAfterRound(board, players, round);
  for (const player of players) {
    const previous = before.get(player.id);
    const current = after.get(player.id);
    changes[player.id] =
      previous === undefined || current === undefined || previous === current
        ? null
        : current < previous
          ? "up"
          : "down";
  }
  return changes;
}

/** Duell-Seiten (2 Personen): eigene Person links, sonst Wahl-Reihenfolge. */
export function duelSides(
  participants: readonly PublicPlayer[],
  selfId: string | null,
): [PublicPlayer, PublicPlayer] | null {
  if (participants.length !== 2) return null;
  const [first, second] = participants;
  if (!first || !second) return null;
  return second.id === selfId ? [second, first] : [first, second];
}

/** Ergebnis aus Sicht der eigenen Person bei 2 Personen (docs/09 §6 Spielende). */
export type DuelOutcome = "won" | "lost" | "draw";

export function duelOutcome(
  results: NonNullable<PublicLobbyState["results"]>,
  selfId: string | null,
): DuelOutcome | null {
  const own = results.ranking.find((entry) => entry.playerId === selfId);
  if (!own) return null;
  if (results.outcome === "draw" && own.status === "active") return "draw";
  return own.place === 1 && own.status === "active" ? "won" : "lost";
}

// ---------------------------------------------------------------------------------------------
// Ansagen und Hinweise
// ---------------------------------------------------------------------------------------------

/**
 * Ansage der `aria-live`-Region im HUD (docs/09 §7 „Screenreader“) zum aktuellen Zustand:
 * Kategoriewahl, Frage, Auflösung (nur für Teilnehmende), Rundenende mit eigenem Platz.
 */
export function announcementFor(
  state: PublicLobbyState,
  selfId: string | null,
  catalog: CategoryCatalog,
): string | null {
  const progress = state.progress;
  switch (state.phase) {
    case "category_pick": {
      if (!progress || !state.turn) return null;
      if (state.turn.pickerId === selfId) return de.announcements.roundPickSelf(progress.round, progress.rounds);
      const picker = findPlayer(state.players, state.turn.pickerId);
      return picker ? de.announcements.roundPick(progress.round, progress.rounds, picker.name) : null;
    }
    case "question": {
      const question = state.question;
      if (!question) return null;
      return de.announcements.categoryQuestion(
        categoryVisual(catalog, question.categoryId).name,
        question.index,
        question.total,
      );
    }
    case "reveal": {
      const question = state.question;
      if (!question || question.correct === undefined || selfId === null || !question.picks) return null;
      if (!Object.hasOwn(question.picks, selfId)) return null;
      if (question.picks[selfId] === question.correct) return de.announcements.correct;
      return de.announcements.wrong(question.answers[question.correct]);
    }
    case "round_board": {
      if (!progress || selfId === null) return null;
      const place = standingsAfterRound(state.board, gameParticipants(state), progress.round).get(selfId);
      return place === undefined ? null : de.announcements.roundEnded(progress.round, place);
    }
    default:
      return null;
  }
}

export interface LobbyRosterChanges {
  /** Namen der neu Beigetretenen */
  joined: string[];
  /** Namen derer, die die Lobby verlassen haben oder entfernt wurden */
  left: string[];
}

/**
 * Wer in der Lobby-Phase dazugekommen bzw. gegangen ist (ohne die eigene Person) – für die Screenreader-Ansage
 * „Ben ist beigetreten.“ (WCAG 4.1.3; sichtbar ändert sich nur die Liste, kein Toast). Getrennte bleiben in der
 * Liste („offline“) und zählen nicht als gegangen; ohne Vorzustand, bei fremder Lobby und außerhalb der
 * Lobby-Phase (Start, Revanche) gibt es keine Ansage.
 */
export function lobbyRosterChanges(
  previous: PublicLobbyState | null,
  next: PublicLobbyState,
  selfId: string | null,
): LobbyRosterChanges {
  if (!previous || previous.code !== next.code || previous.phase !== "lobby" || next.phase !== "lobby") {
    return { joined: [], left: [] };
  }
  const before = new Set(previous.players.map((player) => player.id));
  const after = new Set(next.players.map((player) => player.id));
  return {
    joined: next.players.filter((player) => player.id !== selfId && !before.has(player.id)).map((p) => p.name),
    left: previous.players.filter((player) => player.id !== selfId && !after.has(player.id)).map((p) => p.name),
  };
}

export type LobbyNotice = { kind: "hostChanged"; name: string } | { kind: "playerResigned"; name: string };

/**
 * Hinweise aus dem Vergleich zweier Zustände derselben Lobby (docs/09 §7.10): Host gewechselt
 * (Toast `crown`) und Person hat aufgegeben (Toast `log-out`, nur im laufenden Spiel, nicht die eigene).
 */
export function lobbyNotices(
  previous: PublicLobbyState | null,
  next: PublicLobbyState,
  selfId: string | null,
): LobbyNotice[] {
  if (!previous || previous.code !== next.code) return [];
  const notices: LobbyNotice[] = [];
  const previousHost = hostPlayer(previous.players);
  const nextHost = hostPlayer(next.players);
  if (previousHost && nextHost && previousHost.id !== nextHost.id) {
    notices.push({ kind: "hostChanged", name: nextHost.name });
  }
  if (isRunningPhase(previous.phase)) {
    const before = new Map(previous.players.map((player) => [player.id, player.status]));
    for (const player of next.players) {
      if (player.id !== selfId && player.status === "resigned" && before.get(player.id) === "active") {
        notices.push({ kind: "playerResigned", name: player.name });
      }
    }
  }
  return notices;
}
