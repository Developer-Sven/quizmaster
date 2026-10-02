/**
 * Beispiel-Zustände nur für /dev/game: gültige `PublicLobbyState`-/`PrivatePlayerState`-Objekte je Phase
 * und Overlay mit 2 bzw. 6 Personen, Zeitpunkte relativ zu `now` (die Vorschau friert die Uhr ein).
 * Die Kategorien entsprechen docs/09 §2 – im Produkt kommen sie immer aus den Daten.
 */

import type {
  AnswerIndex,
  BoardRow,
  CategoryOption,
  ErrorCode,
  PrivatePlayerState,
  PublicLobbyState,
  PublicPlayer,
  PublicQuestion,
  ReviewItem,
} from "@quizmaster/shared";
import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";
import { placesFor } from "../../../lib/client/game-view";
import type { LobbyExit, PendingAnswer } from "../../../stores/game-store";
import { LONGEST_ANSWER, LONGEST_QUESTION } from "../ui/sample-data";

export type PreviewPlayers = 2 | 6;

export interface PreviewContext {
  /** eingefrorene Client-Zeit der Vorschau (ms) */
  now: number;
  count: PreviewPlayers;
}

export type PreviewScene =
  | { kind: "lobby"; lobby: PublicLobbyState; self: PrivatePlayerState; settingsOpen?: boolean; qrOpen?: boolean }
  | {
      kind: "game";
      lobby: PublicLobbyState;
      self: PrivatePlayerState;
      pendingAnswer?: PendingAnswer | null;
      review?: { items: ReviewItem[]; reportingId?: string | null };
      /** Verbindungs-Overlay mit dieser Restfrist (ms) */
      connectionMs?: number;
    }
  | { kind: "exit"; exit: LobbyExit }
  | { kind: "fatal"; code: ErrorCode }
  | { kind: "loading"; connecting?: boolean };

export const PREVIEW_CATEGORIES: readonly CategoryOption[] = [
  { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" },
  { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" },
  { id: "kinofilme", name: "Kinofilme", icon: "clapperboard", color: "#EE5858" },
  { id: "rund-um-die-welt", name: "Rund um die Welt", icon: "globe", color: "#3F9FF3" },
  { id: "sport-freizeit", name: "Sport & Freizeit", icon: "trophy", color: "#7BCB4D" },
  { id: "im-labor", name: "Im Labor", icon: "flask-conical", color: "#26D9B5" },
  { id: "zeugen-der-zeit", name: "Zeugen der Zeit", icon: "hourglass", color: "#BA9978" },
  { id: "essen-trinken", name: "Essen & Trinken", icon: "utensils", color: "#F27C5F" },
  { id: "tv-serien", name: "TV-Serien", icon: "tv", color: "#35C8DE" },
];

export const PREVIEW_CATALOG: Readonly<Record<string, CategoryOption>> = Object.fromEntries(
  PREVIEW_CATEGORIES.map((category) => [category.id, category]),
);

function category(index: number): CategoryOption {
  const found = PREVIEW_CATEGORIES[index % PREVIEW_CATEGORIES.length];
  if (!found) throw new Error("Beispielkategorien fehlen");
  return found;
}

function options(start: number): [CategoryOption, CategoryOption, CategoryOption] {
  return [category(start), category(start + 1), category(start + 2)];
}

const PEOPLE: ReadonlyArray<Pick<PublicPlayer, "id" | "name" | "color">> = [
  { id: "p1", name: "Mia", color: "blue" },
  { id: "p2", name: "Ben", color: "sky" },
  { id: "p3", name: "Lea", color: "cyan" },
  { id: "p4", name: "Tom", color: "yellow" },
  { id: "p5", name: "Ida Sommer", color: "ochre" },
  { id: "p6", name: "Kai", color: "sand" },
];

/** Wahl-Reihenfolge (ausgelost) der Beispiele. */
function orderFor(count: PreviewPlayers): string[] {
  return count === 2 ? ["p2", "p1"] : ["p3", "p1", "p5", "p2", "p6", "p4"];
}

const K = 3;
const ROUNDS = 3;

/** Trefferquote je Person (von 10) – unterschiedliche Stände für Podest, Rangliste und Pfeile. */
const ACCURACY = [8, 6, 7, 4, 5, 3] as const;

/** Deterministische Ergebnisse je Runde, Zug, Person und Frage (true/false, selten keine Antwort). */
function result(round: number, turn: number, player: number, question: number, count: PreviewPlayers): boolean | null {
  const hash = (round * 31 + turn * 17 + question * 13 + player * 7 + count) % 10;
  if (hash === 9 && player % 2 === 1) return null;
  return hash < (ACCURACY[player] ?? 5);
}

/** Tafel: `rounds` volle Runden plus `extraTurns` Züge der nächsten Runde. */
function makeBoard(count: PreviewPlayers, rounds: number, extraTurns = 0): BoardRow[] {
  const order = orderFor(count);
  const rows: BoardRow[] = [];
  const turns: Array<[number, number]> = [];
  for (let round = 1; round <= rounds; round++)
    for (let turn = 0; turn < order.length; turn++) turns.push([round, turn]);
  for (let turn = 0; turn < extraTurns; turn++) turns.push([rounds + 1, turn]);
  turns.forEach(([round, turn], index) => {
    rows.push({
      round,
      pickerId: order[turn] ?? "p1",
      categoryId: category(index * 2).id,
      results: Object.fromEntries(
        order.map((playerId, player) => [
          playerId,
          Array.from({ length: K }, (_, question) => result(round, turn, player, question, count)),
        ]),
      ),
    });
  });
  return rows;
}

function scoresOf(board: readonly BoardRow[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const row of board) {
    for (const [playerId, results] of Object.entries(row.results)) {
      scores.set(playerId, (scores.get(playerId) ?? 0) + results.filter((value) => value === true).length);
    }
  }
  return scores;
}

function players(
  count: PreviewPlayers,
  board: readonly BoardRow[] = [],
  patch: Partial<Record<string, Partial<PublicPlayer>>> = {},
): PublicPlayer[] {
  const scores = scoresOf(board);
  return PEOPLE.slice(0, count).map((person, index) => ({
    ...person,
    isHost: index === 0,
    isBot: false,
    connected: true,
    status: "active" as const,
    score: scores.get(person.id) ?? 0,
    ...patch[person.id],
  }));
}

function base(ctx: PreviewContext, patch: Partial<PublicLobbyState>): PublicLobbyState {
  return {
    rev: 42,
    protocolVersion: 1,
    code: "ABC234",
    phase: "lobby",
    phaseStartedAt: ctx.now - 1_000,
    phaseEndsAt: null,
    settings: { ...DEFAULT_LOBBY_SETTINGS, rounds: ROUNDS, questionsPerCategory: K },
    players: players(ctx.count),
    order: null,
    progress: null,
    turn: null,
    question: null,
    board: [],
    results: null,
    suggestions: [],
    ...patch,
  };
}

function self(playerId: string, patch: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
  return { playerId, isHost: playerId === "p1", canPick: false, myAnswer: null, ...patch };
}

function progress(ctx: PreviewContext, round: number, turn: number) {
  return { round, rounds: ROUNDS, turn, turnsPerRound: ctx.count };
}

// --- Fragen --------------------------------------------------------------------------------------

interface SampleQuestion {
  prompt: string;
  answers: [string, string, string, string];
  correct: AnswerIndex;
  media: PublicQuestion["media"];
  explanation: string | null;
  /** Index in PREVIEW_CATEGORIES – die Kategorie muss zur Frage passen (Manifest-Screenshot frage.png) */
  category: number;
}

/** „Rund um die Welt“: Hauptstädte, Flüsse und Flaggen gehören hierher. */
const GEOGRAPHY = 3;

const CAPITAL: SampleQuestion = {
  prompt: "Wie heißt die Hauptstadt von Australien?",
  answers: ["Sydney", "Canberra", "Melbourne", "Perth"],
  correct: 1,
  media: null,
  explanation: "Canberra wurde als Kompromiss zwischen Sydney und Melbourne gegründet.",
  category: GEOGRAPHY,
};

const LONG: SampleQuestion = {
  prompt: LONGEST_QUESTION,
  answers: [
    LONGEST_ANSWER,
    "Der Rhein zwischen Alpen und Nordsee XY",
    "Die Elbe auf ihrem Weg nach Hamburg XYZ",
    "Die Weichsel durch Krakau und Warschau",
  ],
  correct: 0,
  media: null,
  explanation: null,
  category: GEOGRAPHY,
};

const FLAG: SampleQuestion = {
  prompt: "Zu welchem Land gehört diese Flagge?",
  answers: ["Belgien", "Deutschland", "Österreich", "Spanien"],
  correct: 1,
  media: { kind: "flag", code: "de" },
  explanation: null,
  category: GEOGRAPHY,
};

/** Zug, in dem die Beispielfrage gestellt wird: Kategorie der Frage, gewählt aus drei Optionen. */
function turnFor(sample: SampleQuestion) {
  return { pickerId: "p1", options: options(sample.category), categoryId: category(sample.category).id };
}

function question(
  sample: SampleQuestion,
  index: number,
  startsAt: number,
  answeredBy: string[],
  reveal?: Record<string, AnswerIndex | null>,
): PublicQuestion {
  const base = {
    id: `q${index}x7k2m9p4`,
    index,
    total: K,
    categoryId: category(sample.category).id,
    prompt: sample.prompt,
    answers: sample.answers,
    media: sample.media,
    startsAt,
    deadline: startsAt + 20_000,
    answeredBy,
  };
  return reveal ? { ...base, correct: sample.correct, picks: reveal, explanation: sample.explanation } : base;
}

function answeredFor(count: PreviewPlayers): string[] {
  return count === 2 ? ["p2"] : ["p2", "p4", "p6"];
}

function picksFor(count: PreviewPlayers, own: AnswerIndex | null): Record<string, AnswerIndex | null> {
  return count === 2 ? { p1: own, p2: 1 } : { p1: own, p2: 1, p3: 0, p4: 1, p5: null, p6: 3 };
}

// --- Szenen --------------------------------------------------------------------------------------

function lobbyScene(
  ctx: PreviewContext,
  selfId: string,
  extra: { settingsOpen?: boolean; qrOpen?: boolean } = {},
): PreviewScene {
  const patch = ctx.count === 6 ? { p4: { connected: false } } : {};
  return {
    kind: "lobby",
    lobby: base(ctx, { players: players(ctx.count, [], patch) }),
    self: self(selfId),
    ...extra,
  };
}

function introScene(ctx: PreviewContext, elapsed: number): PreviewScene {
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "intro",
      phaseStartedAt: ctx.now - elapsed,
      phaseEndsAt: ctx.now - elapsed + 4_000,
      order: orderFor(ctx.count),
      progress: progress(ctx, 1, 1),
    }),
    self: self("p1"),
  };
}

function pickScene(ctx: PreviewContext, pickerId: string, picked: boolean): PreviewScene {
  const startedAt = ctx.now - 4_000;
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "category_pick",
      phaseStartedAt: startedAt,
      phaseEndsAt: startedAt + 15_000,
      order: orderFor(ctx.count),
      progress: progress(ctx, 1, 2),
      turn: { pickerId, options: options(0), categoryId: picked ? category(1).id : null },
      board: makeBoard(ctx.count, 0, 1),
      players: players(ctx.count, makeBoard(ctx.count, 0, 1)),
    }),
    self: self("p1", { canPick: pickerId === "p1" && !picked }),
  };
}

function questionScene(
  ctx: PreviewContext,
  sample: SampleQuestion,
  options_: { remainingMs: number; own?: AnswerIndex },
): PreviewScene {
  const startsAt = ctx.now - (20_000 - options_.remainingMs);
  const board = makeBoard(ctx.count, 0, 1);
  const questionState = question(
    sample,
    2,
    startsAt,
    answeredFor(ctx.count).concat(options_.own === undefined ? [] : ["p1"]),
  );
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "question",
      phaseStartedAt: startsAt - 800,
      phaseEndsAt: startsAt + 20_000,
      order: orderFor(ctx.count),
      progress: progress(ctx, 1, 2),
      turn: turnFor(sample),
      question: questionState,
      board,
      players: players(ctx.count, board),
    }),
    self: self("p1", {
      myAnswer: options_.own === undefined ? null : { questionId: questionState.id, choice: options_.own },
    }),
  };
}

function revealCategoryScene(ctx: PreviewContext): PreviewScene {
  const phaseStartedAt = ctx.now - 700;
  const board = makeBoard(ctx.count, 0, 1);
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "question",
      phaseStartedAt,
      phaseEndsAt: phaseStartedAt + 22_000,
      order: orderFor(ctx.count),
      progress: progress(ctx, 1, 2),
      turn: turnFor(CAPITAL),
      question: question(CAPITAL, 1, phaseStartedAt + 2_000, []),
      board,
      players: players(ctx.count, board),
    }),
    self: self("p1"),
  };
}

function answerScene(ctx: PreviewContext, own: AnswerIndex | null): PreviewScene {
  const phaseStartedAt = ctx.now - 800;
  const board = makeBoard(ctx.count, 0, 1);
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "reveal",
      phaseStartedAt,
      phaseEndsAt: phaseStartedAt + 3_500,
      order: orderFor(ctx.count),
      progress: progress(ctx, 1, 2),
      turn: turnFor(CAPITAL),
      question: question(CAPITAL, 2, phaseStartedAt - 12_000, [], picksFor(ctx.count, own)),
      board,
      players: players(ctx.count, board),
    }),
    self: self("p1"),
  };
}

function turnSummaryScene(ctx: PreviewContext): PreviewScene {
  const board = makeBoard(ctx.count, 0, 2);
  const order = orderFor(ctx.count);
  const last = board.at(-1);
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "turn_summary",
      phaseStartedAt: ctx.now - 900,
      phaseEndsAt: ctx.now + 3_100,
      order,
      progress: progress(ctx, 1, 2),
      turn: {
        pickerId: last?.pickerId ?? "p1",
        options: [category(2), category(3), category(4)],
        categoryId: last?.categoryId ?? category(2).id,
      },
      board,
      players: players(ctx.count, board),
    }),
    self: self("p1"),
  };
}

function roundBoardScene(ctx: PreviewContext): PreviewScene {
  const board = makeBoard(ctx.count, 2);
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "round_board",
      phaseStartedAt: ctx.now - 1_200,
      phaseEndsAt: ctx.now + 4_800,
      order: orderFor(ctx.count),
      progress: progress(ctx, 2, ctx.count),
      board,
      players: players(ctx.count, board),
    }),
    self: self("p1"),
  };
}

type Outcome = "won" | "lost" | "draw";

function gameOverScene(ctx: PreviewContext, outcome: Outcome, review?: { reportingId?: string | null }): PreviewScene {
  const board = outcome === "draw" ? drawBoard() : makeBoard(ctx.count, ROUNDS);
  const resigned = ctx.count === 6 ? { p6: { status: "resigned" as const, connected: false } } : {};
  const list = players(ctx.count, board, resigned);
  const places = placesFor(list.map((player) => ({ playerId: player.id, status: player.status, score: player.score })));
  const ranking = [...list]
    .sort((a, b) => (places.get(a.id) ?? 99) - (places.get(b.id) ?? 99))
    .map((player) => ({
      playerId: player.id,
      place: places.get(player.id) ?? list.length,
      score: player.score,
      status: player.status,
    }));
  const active = ranking.filter((entry) => entry.status === "active");
  const allTied = active.every((entry) => entry.score === active[0]?.score);
  const winnerId = ranking[0]?.playerId ?? "p1";
  const loserId = (ctx.count === 2 ? ranking[1] : active[3])?.playerId ?? "p2";
  const selfId = outcome === "lost" ? loserId : outcome === "won" ? winnerId : "p1";
  return {
    kind: "game",
    lobby: base(ctx, {
      phase: "game_over",
      phaseStartedAt: ctx.now - 2_000,
      phaseEndsAt: null,
      order: orderFor(ctx.count),
      board,
      players: list,
      results: { ranking, outcome: allTied ? "draw" : "win" },
    }),
    self: self(selfId, { isHost: selfId === "p1" }),
    review: review ? { items: reviewItems(ctx.count, selfId), reportingId: review.reportingId ?? null } : undefined,
  };
}

/** Duell mit Gleichstand (2 Personen). */
function drawBoard(): BoardRow[] {
  return makeBoard(2, ROUNDS).map((row) => ({
    ...row,
    results: { p1: row.results.p2 ?? [], p2: row.results.p2 ?? [] },
  }));
}

function reviewItems(count: PreviewPlayers, selfId: string): ReviewItem[] {
  const picks = (own: AnswerIndex | null) => ({ ...picksFor(count, 1), [selfId]: own });
  return [
    {
      questionId: "q1x7k2m9p4",
      categoryId: category(CAPITAL.category).id,
      prompt: CAPITAL.prompt,
      media: null,
      answers: CAPITAL.answers,
      correct: CAPITAL.correct,
      explanation: CAPITAL.explanation,
      picks: picks(2),
      myRating: 1,
      myReported: false,
    },
    {
      questionId: "q2x7k2m9p4",
      categoryId: category(FLAG.category).id,
      prompt: FLAG.prompt,
      media: FLAG.media,
      answers: FLAG.answers,
      correct: FLAG.correct,
      explanation: null,
      picks: picks(1),
      myRating: null,
      myReported: true,
    },
    {
      questionId: "q3x7k2m9p4",
      categoryId: category(LONG.category).id,
      prompt: LONG.prompt,
      media: null,
      answers: LONG.answers,
      correct: LONG.correct,
      explanation: null,
      picks: picks(null),
      myRating: -1,
      myReported: false,
    },
  ];
}

/** Szene mit Verbindungs-Overlay (Restfrist in ms). */
function withConnection(scene: PreviewScene, connectionMs: number): PreviewScene {
  return scene.kind === "game" ? { ...scene, connectionMs } : scene;
}

// --- Registry --------------------------------------------------------------------------------------

export interface PreviewDefinition {
  title: string;
  /** false = unabhängig von der Personenzahl (nur eine Variante) */
  byPlayers: boolean;
  build: (ctx: PreviewContext) => PreviewScene;
}

export const PREVIEW_VIEWS = {
  "lobby-host": { title: "Lobby (Host)", byPlayers: true, build: (ctx) => lobbyScene(ctx, "p1") },
  "lobby-guest": { title: "Lobby (Gast)", byPlayers: true, build: (ctx) => lobbyScene(ctx, "p2") },
  "lobby-settings": {
    title: "Lobby: Einstellungen",
    byPlayers: false,
    build: (ctx) => lobbyScene(ctx, "p1", { settingsOpen: true }),
  },
  "lobby-qr": { title: "Lobby: QR-Code", byPlayers: false, build: (ctx) => lobbyScene(ctx, "p1", { qrOpen: true }) },
  intro: { title: "Intro", byPlayers: true, build: (ctx) => introScene(ctx, 1_000) },
  "intro-title": { title: "Intro: Titelkarte", byPlayers: false, build: (ctx) => introScene(ctx, 3_400) },
  "pick-self": { title: "Kategoriewahl (selbst)", byPlayers: true, build: (ctx) => pickScene(ctx, "p1", false) },
  "pick-other": { title: "Kategoriewahl (andere)", byPlayers: true, build: (ctx) => pickScene(ctx, "p2", false) },
  "pick-done": { title: "Kategorie gewählt", byPlayers: false, build: (ctx) => pickScene(ctx, "p2", true) },
  "category-reveal": { title: "Kategorie-Reveal", byPlayers: false, build: revealCategoryScene },
  question: {
    title: "Frage",
    byPlayers: true,
    build: (ctx) => questionScene(ctx, CAPITAL, { remainingMs: 14_000 }),
  },
  "question-locked": {
    title: "Frage: eingeloggt",
    byPlayers: true,
    build: (ctx) => questionScene(ctx, CAPITAL, { remainingMs: 12_000, own: 2 }),
  },
  "question-long": {
    title: "Frage: längster Text",
    byPlayers: false,
    build: (ctx) => questionScene(ctx, LONG, { remainingMs: 4_000 }),
  },
  "question-flag": {
    title: "Frage: Flagge",
    byPlayers: false,
    build: (ctx) => questionScene(ctx, FLAG, { remainingMs: 16_000 }),
  },
  "answer-correct": { title: "Auflösung: richtig", byPlayers: true, build: (ctx) => answerScene(ctx, 1) },
  "answer-wrong": { title: "Auflösung: falsch", byPlayers: true, build: (ctx) => answerScene(ctx, 2) },
  "answer-timeout": { title: "Auflösung: Zeit abgelaufen", byPlayers: false, build: (ctx) => answerScene(ctx, null) },
  "turn-summary": { title: "Zug-Ergebnis", byPlayers: true, build: turnSummaryScene },
  "round-board": { title: "Rundentafel", byPlayers: true, build: roundBoardScene },
  "game-over": { title: "Spielende: gewonnen", byPlayers: true, build: (ctx) => gameOverScene(ctx, "won") },
  "game-over-lost": { title: "Spielende: verloren", byPlayers: true, build: (ctx) => gameOverScene(ctx, "lost") },
  "game-over-draw": {
    title: "Spielende: unentschieden",
    byPlayers: false,
    build: (ctx) => gameOverScene({ ...ctx, count: 2 }, "draw"),
  },
  review: { title: "Fragen ansehen", byPlayers: true, build: (ctx) => gameOverScene(ctx, "won", {}) },
  report: {
    title: "Frage melden",
    byPlayers: false,
    build: (ctx) => gameOverScene(ctx, "won", { reportingId: "q1x7k2m9p4" }),
  },
  connection: {
    title: "Verbindung unterbrochen",
    byPlayers: false,
    build: (ctx) => withConnection(questionScene(ctx, CAPITAL, { remainingMs: 14_000 }), 72_000),
  },
  "exit-not-found": {
    title: "Lobby nicht gefunden",
    byPlayers: false,
    build: () => ({ kind: "exit", exit: { kind: "error", code: "LOBBY_NOT_FOUND" } }),
  },
  "exit-full": {
    title: "Lobby voll",
    byPlayers: false,
    build: () => ({ kind: "exit", exit: { kind: "error", code: "LOBBY_FULL" } }),
  },
  "exit-running": {
    title: "Spiel läuft bereits",
    byPlayers: false,
    build: () => ({ kind: "exit", exit: { kind: "error", code: "GAME_IN_PROGRESS" } }),
  },
  "exit-kicked": {
    title: "Entfernt",
    byPlayers: false,
    build: () => ({ kind: "exit", exit: { kind: "kicked", reason: "host" } }),
  },
  loading: { title: "Lobby lädt", byPlayers: false, build: () => ({ kind: "loading" }) },
  connecting: {
    title: "Erster Verbindungsaufbau scheitert",
    byPlayers: false,
    build: () => ({ kind: "loading", connecting: true }),
  },
  "fatal-update": {
    title: "Neue Version nötig",
    byPlayers: false,
    build: () => ({ kind: "fatal", code: "UPDATE_REQUIRED" }),
  },
} satisfies Record<string, PreviewDefinition>;

export type PreviewViewId = keyof typeof PREVIEW_VIEWS;

export function isPreviewViewId(value: unknown): value is PreviewViewId {
  return typeof value === "string" && Object.hasOwn(PREVIEW_VIEWS, value);
}
