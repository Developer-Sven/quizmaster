import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ackResponseSchema } from "./ack.ts";
import { connectErrorDataSchema } from "./auth.ts";
import { lobbyDocSchema } from "./documents/lobby.ts";
import { CLIENT_EVENT_NAMES, CLIENT_EVENTS, SERVER_EVENT_NAMES, SERVER_EVENTS } from "./events.ts";
import {
  categoriesResponseSchema,
  healthResponseSchema,
  httpErrorBodySchema,
  sessionResponseSchema,
  ticketResponseSchema,
} from "./http.ts";
import { CLIENT_FORBIDDEN_KEYS, findKeysDeep, PRE_REVEAL_FORBIDDEN_KEYS } from "./invariants.ts";
import {
  type PublicLobbyState,
  privatePlayerStateSchema,
  publicLobbyStateSchema,
  publicQuestionSchema,
  reviewItemSchema,
} from "./schemas.ts";

/**
 * Sammelt rekursiv alle Objekt-Schlüssel eines zod-Schemas (Objekte, Arrays, Tupel, Unions, Records,
 * optional/nullable, Pipes …) – über die öffentlichen Definitionen in `schema._zod.def`.
 */
function collectSchemaKeys(schema: z.core.$ZodType, keys = new Set<string>(), seen = new Set<unknown>()): Set<string> {
  if (seen.has(schema)) return keys;
  seen.add(schema);
  const def = schema._zod.def as unknown as Record<string, unknown>;
  const visit = (child: unknown) => {
    if (isSchema(child)) collectSchemaKeys(child, keys, seen);
  };
  switch (def.type) {
    case "object":
      for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
        keys.add(key);
        visit(child);
      }
      visit(def.catchall);
      break;
    case "array":
      visit(def.element);
      break;
    case "tuple":
      for (const item of def.items as unknown[]) visit(item);
      visit(def.rest);
      break;
    case "union":
      for (const option of def.options as unknown[]) visit(option);
      break;
    case "record":
      visit(def.keyType);
      visit(def.valueType);
      break;
    case "pipe":
      visit(def.in);
      visit(def.out);
      break;
    case "intersection":
      visit(def.left);
      visit(def.right);
      break;
    case "lazy":
      visit((def.getter as () => unknown)());
      break;
    default:
      visit(def.innerType);
  }
  return keys;
}

function isSchema(value: unknown): value is z.core.$ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

const players = [
  {
    id: "p1",
    name: "Mia",
    color: "blue",
    isHost: true,
    isBot: false,
    connected: true,
    status: "active",
    score: 2,
  },
  {
    id: "p2",
    name: "Ben",
    color: "sky",
    isHost: false,
    isBot: false,
    connected: false,
    status: "active",
    score: 1,
  },
] as const;

const options = [
  { id: "rund-um-die-welt", name: "Rund um die Welt", icon: "globe", color: "#3F9FF3" },
  { id: "im-labor", name: "Im Labor", icon: "flask-conical", color: "#26D9B5" },
  { id: "tv-serien", name: "TV-Serien", icon: "tv", color: "#35C8DE" },
] as const;

/** Zustand während einer Frage (vor der Auflösung). */
function questionState(): PublicLobbyState {
  return {
    rev: 17,
    protocolVersion: 1,
    code: "ABC234",
    phase: "question",
    phaseStartedAt: 1_727_000_000_000,
    phaseEndsAt: 1_727_000_022_000,
    settings: {
      rounds: 3,
      questionsPerCategory: 3,
      maxPlayers: 8,
      afterQuestionSec: 5,
      afterTurnSec: 5,
      afterRoundSec: 7,
      hostPlays: true,
      categoryIds: null,
      answerSec: 20,
      allowSuggestions: true,
      difficultyMin: 1,
      difficultyMax: 5,
      difficultyBasis: "question",
      difficultyOrder: "ascending",
    },
    players: players.map((player) => ({ ...player })),
    order: ["p1", "p2"],
    progress: { round: 1, rounds: 3, turn: 1, turnsPerRound: 2 },
    turn: {
      pickerId: "p1",
      options: [{ ...options[0] }, { ...options[1] }, { ...options[2] }],
      categoryId: "rund-um-die-welt",
    },
    question: {
      id: "q2",
      index: 2,
      total: 3,
      categoryId: "rund-um-die-welt",
      prompt: "Zu welchem Land gehört diese Flagge?",
      answers: ["Japan", "Bangladesch", "Palau", "Laos"],
      media: { kind: "flag", code: "jp" },
      startsAt: 1_727_000_002_000,
      deadline: 1_727_000_022_000,
      answeredBy: ["p2"],
    },
    board: [{ round: 1, pickerId: "p1", categoryId: "rund-um-die-welt", results: { p1: [true], p2: [null] } }],
    results: null,
    suggestions: [],
  };
}

describe("PublicLobbyState (docs/05 §Zustände)", () => {
  it("akzeptiert einen Snapshot während der Frage (ohne correct/picks/explanation)", () => {
    const state = questionState();
    expect(publicLobbyStateSchema.parse(state)).toEqual(state);
    expect(findKeysDeep(state, PRE_REVEAL_FORBIDDEN_KEYS)).toEqual([]);
  });

  it("akzeptiert die Auflösung mit correct/picks/explanation", () => {
    const state = questionState();
    const revealed = {
      ...state,
      phase: "reveal" as const,
      question: state.question && {
        ...state.question,
        correct: 0 as const,
        picks: { p1: 0 as const, p2: null },
        explanation: null,
      },
    };
    expect(publicLobbyStateSchema.safeParse(revealed).success).toBe(true);
    expect(findKeysDeep(revealed, PRE_REVEAL_FORBIDDEN_KEYS)).toEqual([
      "question.correct",
      "question.picks",
      "question.explanation",
    ]);
  });

  it("kennt correct/picks/explanation nur optional – alle anderen Frage-Felder sind Pflicht", () => {
    const shape = publicQuestionSchema.shape;
    for (const key of ["correct", "picks", "explanation"] as const) {
      expect(shape[key].safeParse(undefined).success, key).toBe(true);
    }
    const required = Object.keys(shape).filter((key) => !["correct", "picks", "explanation"].includes(key));
    expect(required.sort()).toEqual(
      ["answeredBy", "answers", "categoryId", "deadline", "id", "index", "media", "prompt", "startsAt", "total"].sort(),
    );
    for (const key of required) {
      expect(shape[key as keyof typeof shape].safeParse(undefined).success, key).toBe(false);
    }
  });

  it("lehnt Zusatzfelder ab – etwa guestId, source oder Punkte der laufenden Frage", () => {
    const state = questionState();
    const [first, second] = state.players;
    if (!first || !second || !state.question) throw new Error("Testdaten unvollständig");
    const leaks: unknown[] = [
      { ...state, players: [{ ...first, guestId: "0f8fad5b-d9cb-469f-a165-70867728950e" }, second] },
      { ...state, question: { ...state.question, source: "https://example.org" } },
      { ...state, question: { ...state.question, points: 1 } },
      { ...state, secret: true },
    ];
    for (const leak of leaks) expect(publicLobbyStateSchema.safeParse(leak).success).toBe(false);
  });

  it("prüft Grenzen: 4 Antworten, 1–3 Optionen (begrenzte Kategorien, ADR-048), index ≤ total, höchstens 8 Personen", () => {
    const state = questionState();
    if (!state.question || !state.turn) throw new Error("Testdaten unvollständig");
    const broken: unknown[] = [
      { ...state, question: { ...state.question, answers: ["a", "b", "c"] } },
      { ...state, question: { ...state.question, index: 4 } },
      { ...state, question: { ...state.question, index: 0 } },
      { ...state, turn: { ...state.turn, options: [] } },
      { ...state, turn: { ...state.turn, options: [...state.turn.options, state.turn.options[0]] } },
      { ...state, players: Array.from({ length: 9 }, (_, index) => ({ ...players[0], id: `p${index}` })) },
      { ...state, phase: "pause" },
      { ...state, code: "abc234" },
    ];
    for (const entry of broken) expect(publicLobbyStateSchema.safeParse(entry).success).toBe(false);
  });

  it("Weniger als 3 Optionen bei begrenzten Kategorien und „zeigt an“ als Status (ADR-046/048)", () => {
    const state = questionState();
    if (!state.turn) throw new Error("Testdaten unvollständig");
    const fewer = { ...state, turn: { ...state.turn, options: state.turn.options.slice(0, 1) } };
    expect(publicLobbyStateSchema.safeParse(fewer).success).toBe(true);
    const presenter = {
      ...state,
      players: state.players.map((player, index) => (index === 0 ? { ...player, status: "spectator" } : player)),
    };
    expect(publicLobbyStateSchema.safeParse(presenter).success).toBe(true);
  });
});

describe("PrivatePlayerState und ReviewItem", () => {
  it("akzeptiert gültige Payloads", () => {
    expect(
      privatePlayerStateSchema.safeParse({
        playerId: "p1",
        isHost: true,
        canPick: false,
        myAnswer: { questionId: "q2", choice: 1 },
      }).success,
    ).toBe(true);
    expect(
      reviewItemSchema.safeParse({
        questionId: "q2",
        categoryId: "rund-um-die-welt",
        prompt: "Zu welchem Land gehört diese Flagge?",
        media: { kind: "flag", code: "jp" },
        answers: ["Japan", "Bangladesch", "Palau", "Laos"],
        correct: 0,
        explanation: null,
        picks: { p1: 0, p2: null },
        myRating: -1,
        myReported: false,
      }).success,
    ).toBe(true);
  });
});

describe("Invariante 4: keine guestId in Server→Client-Payloads (docs/06)", () => {
  const serverToClient: [string, z.core.$ZodType][] = [
    ...SERVER_EVENT_NAMES.map((event): [string, z.core.$ZodType] => [event, SERVER_EVENTS[event].payload]),
    ...CLIENT_EVENT_NAMES.map((event): [string, z.core.$ZodType] => [
      `${event} (Ack)`,
      ackResponseSchema(CLIENT_EVENTS[event].ack),
    ]),
    ["POST /api/session", sessionResponseSchema],
    ["POST /api/realtime/ticket", ticketResponseSchema],
    ["GET /api/categories", categoriesResponseSchema],
    ["GET /api/health", healthResponseSchema],
    ["HTTP-Fehler", httpErrorBodySchema],
    ["connect_error (data)", connectErrorDataSchema],
  ];

  it.each(serverToClient)("%s enthält rekursiv kein Feld guestId", (_name, schema) => {
    const keys = collectSchemaKeys(schema);
    for (const forbidden of CLIENT_FORBIDDEN_KEYS) expect(keys.has(forbidden)).toBe(false);
  });

  it("die Schema-Suche findet Felder tief verschachtelt (Gegenprobe mit einem Server-Dokument)", () => {
    const stateKeys = collectSchemaKeys(publicLobbyStateSchema);
    for (const key of ["rev", "players", "score", "options", "answeredBy", "results", "ranking", "place"]) {
      expect(stateKeys.has(key), key).toBe(true);
    }
    expect(collectSchemaKeys(lobbyDocSchema).has("guestId")).toBe(true);
  });

  it("findKeysDeep meldet Fundstellen mit Pfad", () => {
    expect(findKeysDeep({ a: [{ guestId: 1 }, { b: { guestId: 2 } }] }, ["guestId"])).toEqual([
      "a[0].guestId",
      "a[1].b.guestId",
    ]);
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(findKeysDeep(cyclic, ["guestId"])).toEqual([]);
  });
});
