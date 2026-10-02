import { describe, expect, expectTypeOf, it } from "vitest";
import { ackError, ackOk, ackResponseSchema } from "./ack.ts";
import { ERROR_CODES, ERROR_HTTP_STATUS, isErrorCode, ProtocolError } from "./errors.ts";
import {
  CLIENT_EVENT_NAMES,
  CLIENT_EVENTS,
  type ClientEventName,
  type ClientEventPayloadInput,
  isClientEventName,
  parseClientPayload,
  SERVER_EVENT_NAMES,
} from "./events.ts";

/** Ein gültiger Payload je Event (der Typ erzwingt Vollständigkeit). */
const VALID_PAYLOADS: { [E in ClientEventName]: ClientEventPayloadInput<E> } = {
  "time:sync": { t0: 1_727_000_000_000.5 },
  "lobby:create": { name: "Mia" },
  "lobby:join": { code: "ABC234", name: "Ben" },
  "lobby:resume": { code: "ABC234" },
  "lobby:leave": {},
  "lobby:update-settings": { rounds: 5 },
  "lobby:kick": { playerId: "p_1a2B3c" },
  "lobby:rename": { name: "Mia" },
  "lobby:transfer-host": { playerId: "p_1a2B3c" },
  "lobby:start": {},
  "game:pick": { categoryId: "rund-um-die-welt" },
  "game:answer": { questionId: "q7", choice: 2 },
  "game:review": {},
  "game:rematch": {},
  "game:continue": { phase: "reveal" },
  "game:end": {},
  "question:rate": { questionId: "q7", value: -1 },
  "question:report": { questionId: "q7", reason: "veraltet" },
  "dev:add-bot": {},
};

const eventCases = CLIENT_EVENT_NAMES.map((event) => [event] as const);

describe("Registry Client → Server (docs/05)", () => {
  it("enthält genau die Events aus docs/05", () => {
    expect([...CLIENT_EVENT_NAMES].sort()).toEqual(
      [
        "time:sync",
        "lobby:create",
        "lobby:join",
        "lobby:resume",
        "lobby:leave",
        "lobby:update-settings",
        "lobby:kick",
        "lobby:rename",
        "lobby:transfer-host",
        "lobby:start",
        "game:pick",
        "game:answer",
        "game:review",
        "game:rematch",
        "game:continue",
        "game:end",
        "question:rate",
        "question:report",
        "dev:add-bot",
      ].sort(),
    );
    expect(Object.keys(VALID_PAYLOADS).sort()).toEqual([...CLIENT_EVENT_NAMES].sort());
  });

  it("dokumentiert für jedes Event, wann es erlaubt ist", () => {
    for (const event of CLIENT_EVENT_NAMES) expect(CLIENT_EVENTS[event].allowed.length, event).toBeGreaterThan(3);
    expect(CLIENT_EVENTS["dev:add-bot"].devOnly).toBe(true);
    expect(CLIENT_EVENT_NAMES.filter((event) => CLIENT_EVENTS[event].devOnly)).toEqual(["dev:add-bot"]);
    expect(CLIENT_EVENTS["lobby:start"]).toMatchObject({ hostOnly: true, phases: ["lobby"] });
    expect(CLIENT_EVENTS["lobby:rename"]).toMatchObject({
      hostOnly: false,
      requiresMembership: true,
      phases: ["lobby"],
    });
    expect(CLIENT_EVENTS["lobby:create"].allowed).toContain("verlässt");
    expect(CLIENT_EVENTS["lobby:transfer-host"]).toMatchObject({ hostOnly: true, requiresMembership: true });
    expect(CLIENT_EVENTS["game:end"]).toMatchObject({
      hostOnly: true,
      phases: ["intro", "category_pick", "question", "reveal", "turn_summary", "round_board"],
    });
    expect(CLIENT_EVENTS["game:continue"]).toMatchObject({
      hostOnly: true,
      phases: ["question", "reveal", "turn_summary", "round_board"],
    });
    // „Auflösen“ bei „Zeit pro Frage: Host“ (ADR-049) – andere Phasen nicht.
    expect(CLIENT_EVENTS["game:continue"].payload.safeParse({ phase: "question" }).success).toBe(true);
    expect(CLIENT_EVENTS["game:continue"].payload.safeParse({ phase: "category_pick" }).success).toBe(false);
    expect(CLIENT_EVENTS["game:answer"]).toMatchObject({ hostOnly: false, phases: ["question"] });
  });

  it("erkennt Eventnamen", () => {
    expect(isClientEventName("game:answer")).toBe(true);
    expect(isClientEventName("game:cheat")).toBe(false);
    expect(isClientEventName(42)).toBe(false);
  });
});

describe("Payload-Validierung: strictObject und Längengrenzen (docs/06 Invariante 5)", () => {
  it.each(eventCases)("%s: gültiger Payload wird akzeptiert", (event) => {
    expect(CLIENT_EVENTS[event].payload.safeParse(VALID_PAYLOADS[event]).success).toBe(true);
  });

  it.each(eventCases)("%s: Zusatzfelder werden abgelehnt", (event) => {
    const payload = { ...VALID_PAYLOADS[event], extra: 1 };
    expect(CLIENT_EVENTS[event].payload.safeParse(payload).success).toBe(false);
    expect(CLIENT_EVENTS[event].payload.safeParse({ ...VALID_PAYLOADS[event], guestId: "x" }).success).toBe(false);
  });

  it.each(eventCases)("%s: Nicht-Objekte werden abgelehnt", (event) => {
    for (const payload of [null, undefined, "x", 42, [], true]) {
      expect(CLIENT_EVENTS[event].payload.safeParse(payload).success).toBe(false);
    }
  });

  it.each(eventCases)("%s: zu lange Strings und falsche Typen werden abgelehnt", (event) => {
    const valid: Record<string, unknown> = VALID_PAYLOADS[event];
    for (const [key, value] of Object.entries(valid)) {
      const schema = CLIENT_EVENTS[event].payload;
      if (typeof value === "string") {
        expect(schema.safeParse({ ...valid, [key]: "A".repeat(10_000) }).success, key).toBe(false);
        expect(schema.safeParse({ ...valid, [key]: 123 }).success, key).toBe(false);
      }
      if (typeof value === "number") {
        expect(schema.safeParse({ ...valid, [key]: String(value) }).success, key).toBe(false);
        expect(schema.safeParse({ ...valid, [key]: Number.NaN }).success, key).toBe(false);
      }
      expect(schema.safeParse({ ...valid, [key]: { nested: true } }).success, key).toBe(false);
      expect(schema.safeParse({ ...valid, [key]: null }).success, key).toBe(false);
    }
  });

  it("normalisiert Lobby-Codes und prüft Namen nur auf Typ und Länge", () => {
    const join = parseClientPayload("lobby:join", { code: " abc-234 ", name: "Mia" });
    expect(join.success && join.data).toEqual({ code: "ABC234", name: "Mia" });
    if (join.success) expectTypeOf(join.data).toEqualTypeOf<{ code: string; name: string }>();
    expect(parseClientPayload("lobby:join", { code: "ABCI23", name: "Mia" }).success).toBe(false);
    expect(parseClientPayload("lobby:join", { code: "ABC234", name: "" }).success).toBe(false);
    expect(parseClientPayload("lobby:join", { code: "ABC234", name: "x".repeat(65) }).success).toBe(false);
    expect(parseClientPayload("lobby:create", { name: "x".repeat(64) }).success).toBe(true);
  });

  it("prüft Antworten, Bewertungen und Meldungen", () => {
    expect(parseClientPayload("game:answer", { questionId: "q7", choice: 3 }).success).toBe(true);
    for (const payload of [
      { questionId: "q7", choice: 4 },
      { questionId: "q7", choice: -1 },
      { questionId: "q7", choice: 1.5 },
      { questionId: "q7", choice: "1" },
      { questionId: "q.7", choice: 1 },
      { questionId: "q".repeat(33), choice: 1 },
      { questionId: "", choice: 1 },
      { questionId: { $gt: "" }, choice: 1 },
    ]) {
      expect(parseClientPayload("game:answer", payload).success, JSON.stringify(payload)).toBe(false);
    }
    expect(parseClientPayload("question:rate", { questionId: "q7", value: 0 }).success).toBe(false);
    expect(parseClientPayload("question:rate", { questionId: "q7", value: 1 }).success).toBe(true);
    expect(parseClientPayload("question:report", { questionId: "q7", reason: "spam" }).success).toBe(false);
    expect(parseClientPayload("game:pick", { categoryId: "Rund um die Welt" }).success).toBe(false);
    expect(parseClientPayload("lobby:kick", { playerId: "p/../x" }).success).toBe(false);
  });

  it("lehnt ungültige Uhrzeiten bei time:sync ab", () => {
    for (const t0 of [-1, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseClientPayload("time:sync", { t0 }).success, String(t0)).toBe(false);
    }
  });
});

describe("Acks", () => {
  it("baut Erfolgs- und Fehler-Acks im Format aus docs/05", () => {
    expect(ackOk()).toEqual({ ok: true, data: null });
    expect(ackOk({ code: "ABC234" })).toEqual({ ok: true, data: { code: "ABC234" } });
    expect(ackError("RATE_LIMITED", "zu viele", 1_234.2)).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "zu viele", retryAfterMs: 1_235 },
    });
    expect(ackError("LOBBY_FULL")).toEqual({ ok: false, error: { code: "LOBBY_FULL", message: "LOBBY_FULL" } });
  });

  it("das Ack auf game:answer verrät nichts über Richtigkeit (Invariante 3)", () => {
    const ack = CLIENT_EVENTS["game:answer"].ack;
    expect(ack.safeParse({ accepted: true }).success).toBe(true);
    expect(ack.safeParse({ accepted: true, correct: true }).success).toBe(false);
    expect(ack.safeParse({ accepted: false }).success).toBe(false);
  });

  it("validiert Ack-Antworten je Event", () => {
    const schema = ackResponseSchema(CLIENT_EVENTS["lobby:create"].ack);
    expect(schema.safeParse(ackOk({ code: "ABC234" })).success).toBe(true);
    expect(schema.safeParse(ackError("NAME_REJECTED")).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: { code: "NOPE", message: "" } }).success).toBe(false);
    expect(schema.safeParse({ ok: true, data: { code: "ABC234", guestId: "g" } }).success).toBe(false);
  });

  it("kennt alle 24 Fehlercodes aus docs/05 mit HTTP-Status", () => {
    expect(ERROR_CODES).toHaveLength(24);
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    expect(isErrorCode("TURNSTILE_REQUIRED")).toBe(true);
    expect(isErrorCode("NOPE")).toBe(false);
    const error = new ProtocolError("RATE_LIMITED", "langsam", 500);
    expect(error).toBeInstanceOf(Error);
    expect([error.code, error.retryAfterMs, error.message]).toEqual(["RATE_LIMITED", 500, "langsam"]);
  });
});

describe("Registry Server → Client", () => {
  it("enthält lobby:state, lobby:self, notice und kicked", () => {
    expect([...SERVER_EVENT_NAMES].sort()).toEqual(["kicked", "lobby:self", "lobby:state", "notice"]);
  });
});
