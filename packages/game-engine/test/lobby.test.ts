import { getTimings, LOBBY_LIFETIME } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { createLobby, createSeededRng, type Effect, toPrivateState, toPublicState } from "../src/index.ts";
import { guestUuid } from "./support/fixtures.ts";
import { lobbyWith, Simulation } from "./support/simulation.ts";

const T = getTimings("normal");

function types(effects: readonly Effect[]): string[] {
  return effects.map((effect) => effect.type);
}

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe("Lobby erstellen", () => {
  it("Host ist erste Person (blau, Host, verbunden), Effects für Zustand, Snapshot und Leerlauf-Timer", () => {
    const result = createLobby(
      { code: "ABC234", guestId: guestUuid(1), name: "  Mia  ", timing: "normal" },
      { now: 1_000, rng: createSeededRng(1) },
    );
    if (!result.ok) throw new Error(result.error.code);
    const pub = toPublicState(result.state);
    expect(pub.rev).toBe(1);
    expect(pub.phase).toBe("lobby");
    expect(pub.phaseEndsAt).toBeNull();
    expect(pub.players).toEqual([
      expect.objectContaining({ name: "Mia", color: "blue", isHost: true, connected: true, isBot: false, score: 0 }),
    ]);
    expect(pub.settings).toEqual({ rounds: 3, questionsPerCategory: 3, maxPlayers: 8 });
    expect(types(result.effects)).toEqual(["broadcast", "sendPrivate", "scheduleTimer", "persist"]);
    expect(result.effects).toContainEqual({ type: "persist", reason: "created" });
    expect(result.effects).toContainEqual(
      expect.objectContaining({ type: "scheduleTimer", kind: "idle_close", at: 1_000 + LOBBY_LIFETIME.idleCloseMs }),
    );
  });

  it("lehnt ungültige Eingaben typisiert ab", () => {
    const ctx = { now: 1_000, rng: createSeededRng(1) };
    const base = { code: "ABC234", guestId: guestUuid(1), name: "Mia", timing: "normal" } as const;
    const code = (input: Parameters<typeof createLobby>[0]) => {
      const result = createLobby(input, ctx);
      return result.ok ? "ok" : result.error.code;
    };
    expect(code({ ...base, code: "abc" })).toBe("VALIDATION_FAILED");
    expect(code({ ...base, guestId: "keine-uuid" })).toBe("VALIDATION_FAILED");
    expect(code({ ...base, timing: "slow" as "normal" })).toBe("VALIDATION_FAILED");
    expect(code({ ...base, name: "M" })).toBe("NAME_REJECTED");
    expect(code({ ...base, name: "Mia 🙂" })).toBe("NAME_REJECTED");
  });
});

describe("Beitreten", () => {
  it("vergibt Farben in Reihenfolge und macht Namen eindeutig", () => {
    const sim = new Simulation();
    sim.join("Ben");
    sim.join("mia");
    sim.join("Lea");
    const pub = toPublicState(sim.state);
    expect(pub.players.map((player) => [player.name, player.color])).toEqual([
      ["Mia", "blue"],
      ["Ben", "sky"],
      ["mia 2", "cyan"],
      ["Lea", "yellow"],
    ]);
  });

  it("neue Person bekommt Zustand + privaten Zustand; alle anderen sehen den Beitritt", () => {
    const sim = new Simulation();
    const from = sim.effects.length;
    const guest = sim.join("Ben");
    const effects = sim.effects.slice(from);
    expect(effects).toContainEqual({ type: "broadcast" });
    expect(effects).toContainEqual({ type: "sendPrivate", playerId: sim.playerId(guest), guestId: guest });
    expect(toPrivateState(sim.state, sim.playerId(guest))).toEqual({
      playerId: sim.playerId(guest),
      isHost: false,
      canPick: false,
      myAnswer: null,
    });
  });

  it("volle Lobby → LOBBY_FULL; laufendes Spiel → GAME_IN_PROGRESS; ungültiger Name → NAME_REJECTED", () => {
    const sim = new Simulation();
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { maxPlayers: 2 } });
    sim.join("Ben");
    expect(errorCode(sim.dispatch({ type: "JOIN", guestId: guestUuid(50), name: "Lea" }))).toBe("LOBBY_FULL");
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { maxPlayers: 8 } });
    expect(errorCode(sim.dispatch({ type: "JOIN", guestId: guestUuid(51), name: "x" }))).toBe("NAME_REJECTED");
    sim.ok({ type: "START", guestId: sim.host });
    expect(errorCode(sim.dispatch({ type: "JOIN", guestId: guestUuid(52), name: "Lea" }))).toBe("GAME_IN_PROGRESS");
  });

  it("erneuter Beitritt derselben Person verbindet sie nur wieder (kein zweiter Platz)", () => {
    const sim = new Simulation();
    const ben = sim.join("Ben");
    const playerId = sim.playerId(ben);
    sim.ok({ type: "DISCONNECT", guestId: ben });
    sim.ok({ type: "JOIN", guestId: ben, name: "Benni" });
    expect(sim.state.players).toHaveLength(2);
    expect(sim.playerId(ben)).toBe(playerId);
    expect(toPublicState(sim.state).players[1]).toMatchObject({ name: "Ben", connected: true });
  });

  it("Farbe wird beim Verlassen frei", () => {
    const sim = new Simulation();
    const ben = sim.join("Ben");
    sim.join("Lea");
    sim.ok({ type: "LEAVE", guestId: ben });
    sim.join("Tom");
    expect(toPublicState(sim.state).players.map((player) => player.color)).toEqual(["blue", "cyan", "sky"]);
  });
});

describe("Einstellungen", () => {
  it("nur Host, nur Phase lobby, gültige Werte, nicht unter die Personenzahl", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    expect(errorCode(sim.dispatch({ type: "UPDATE_SETTINGS", guestId: ben, update: { rounds: 5 } }))).toBe("NOT_HOST");
    expect(errorCode(sim.dispatch({ type: "UPDATE_SETTINGS", guestId: sim.host, update: {} }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(errorCode(sim.dispatch({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 11 } }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(errorCode(sim.dispatch({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { maxPlayers: 2 } }))).toBe(
      "INVALID_OPTION",
    );
    const from = sim.effects.length;
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 2 } });
    expect(toPublicState(sim.state).settings).toEqual({ rounds: 1, questionsPerCategory: 2, maxPlayers: 8 });
    expect(sim.effects.slice(from)).toContainEqual({ type: "persist", reason: "settings" });
    sim.ok({ type: "START", guestId: sim.host });
    expect(errorCode(sim.dispatch({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2 } }))).toBe(
      "INVALID_PHASE",
    );
  });
});

describe("Entfernen (Kick) + Lobby-Sperre", () => {
  it("nur Host, nicht sich selbst, nur Mitglieder", () => {
    const sim = lobbyWith(2);
    const ben = sim.guests[1] ?? "";
    const hostId = sim.playerId(sim.host);
    expect(errorCode(sim.dispatch({ type: "KICK", guestId: ben, targetPlayerId: hostId }))).toBe("NOT_HOST");
    expect(errorCode(sim.dispatch({ type: "KICK", guestId: sim.host, targetPlayerId: hostId }))).toBe("INVALID_OPTION");
    expect(errorCode(sim.dispatch({ type: "KICK", guestId: sim.host, targetPlayerId: "gibtsnicht" }))).toBe(
      "INVALID_OPTION",
    );
  });

  it("in der Lobby: entfernt, benachrichtigt, gesperrt (Beitritt und Resume → KICKED)", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const benId = sim.playerId(ben);
    const from = sim.effects.length;
    sim.ok({ type: "KICK", guestId: sim.host, targetPlayerId: benId });
    expect(sim.effects.slice(from)).toContainEqual({ type: "kick", playerId: benId, guestId: ben, reason: "host" });
    expect(sim.state.players.some((player) => player.guestId === ben)).toBe(false);
    expect(errorCode(sim.dispatch({ type: "JOIN", guestId: ben, name: "Ben" }))).toBe("KICKED");
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: ben }))).toBe("KICKED");
    // Das kick-Effect kommt vor dem Broadcast (Socket verlässt den Raum zuerst).
    const kinds = types(sim.effects.slice(from));
    expect(kinds.indexOf("kick")).toBeLessThan(kinds.indexOf("broadcast"));
  });

  it("im Spiel: wie Aufgegeben (Status resigned, Hinweis PLAYER_LEFT)", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    const ben = sim.guests[1] ?? "";
    const from = sim.effects.length;
    sim.ok({ type: "KICK", guestId: sim.host, targetPlayerId: sim.playerId(ben) });
    expect(sim.effects.slice(from)).toContainEqual({ type: "notice", code: "PLAYER_LEFT" });
    const player = toPublicState(sim.state).players.find((entry) => entry.id === sim.playerId(ben));
    expect(player).toMatchObject({ status: "resigned", connected: false });
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: ben }))).toBe("KICKED");
  });
});

describe("Verlassen und Host-Übergabe", () => {
  it("Host verlässt die Lobby → sofort an die am längsten anwesende verbundene Person (keine Bots)", () => {
    const sim = lobbyWith(1, 2);
    const ben = sim.join("Ben");
    const lea = sim.join("Lea");
    sim.ok({ type: "DISCONNECT", guestId: ben });
    const from = sim.effects.length;
    sim.ok({ type: "LEAVE", guestId: sim.guests[0] ?? "" });
    expect(sim.state.hostPlayerId).toBe(sim.playerId(lea));
    expect(sim.effects.slice(from)).toContainEqual({ type: "notice", code: "HOST_CHANGED" });
    expect(toPrivateState(sim.state, sim.playerId(lea)).isHost).toBe(true);
  });

  it("Host 30 s getrennt → Übergabe; kehrt der Host vorher zurück, bleibt alles", () => {
    const sim = lobbyWith(3);
    const [host = "", ben = ""] = sim.guests;
    sim.ok({ type: "DISCONNECT", guestId: host });
    sim.advance(T.hostHandoverMs - 1);
    expect(sim.state.hostPlayerId).toBe(sim.playerId(host));
    sim.ok({ type: "RECONNECT", guestId: host });
    sim.advance(T.hostHandoverMs * 2);
    expect(sim.state.hostPlayerId).toBe(sim.playerId(host));

    sim.ok({ type: "DISCONNECT", guestId: host });
    sim.advance(T.hostHandoverMs);
    expect(sim.state.hostPlayerId).toBe(sim.playerId(ben));
  });

  it("im Spiel: Host-Übergabe nach 30 s, Host bleibt aktiv bis zur 90-s-Frist", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    const [host = "", ben = ""] = sim.guests;
    sim.ok({ type: "DISCONNECT", guestId: host });
    sim.advance(T.hostHandoverMs);
    expect(sim.state.hostPlayerId).toBe(sim.playerId(ben));
    const hostPlayer = sim.state.players.find((player) => player.guestId === host);
    expect(hostPlayer?.status).toBe("active");
  });

  it("Bots werden nie Host; ohne menschliche Mitglieder schließt die Lobby", () => {
    const sim = lobbyWith(1, 3);
    sim.ok({ type: "LEAVE", guestId: sim.host });
    expect(sim.state.closed).toEqual({ at: sim.now, reason: "empty" });
    expect(sim.effectsOf("closeLobby")).toEqual([{ type: "closeLobby", reason: "empty" }]);
  });
});

describe("Reconnect-Fristen", () => {
  it("Lobby: Rückkehr innerhalb von 30 s behält den Platz; danach ist die Person entfernt", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const before = sim.state.players.find((player) => player.guestId === ben);
    sim.ok({ type: "DISCONNECT", guestId: ben });
    expect(toPublicState(sim.state).players[1]?.connected).toBe(false);
    sim.advance(T.reconnectLobbyMs - 1);
    sim.ok({ type: "RECONNECT", guestId: ben });
    expect(sim.state.players.find((player) => player.guestId === ben)).toEqual(before);

    sim.ok({ type: "DISCONNECT", guestId: ben });
    sim.advance(T.reconnectLobbyMs);
    expect(sim.state.players.some((player) => player.guestId === ben)).toBe(false);
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: ben }))).toBe("LOBBY_NOT_FOUND");
  });

  it("Spiel: 90 s Frist, danach Aufgegeben (Resume → RESIGNED)", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    const ben = sim.guests[1] ?? "";
    sim.ok({ type: "DISCONNECT", guestId: ben });
    sim.advance(T.reconnectGameMs - 1);
    expect(sim.state.players.find((player) => player.guestId === ben)?.status).toBe("active");
    sim.advance(1);
    expect(sim.state.players.find((player) => player.guestId === ben)?.status).toBe("resigned");
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: ben }))).toBe("RESIGNED");
  });

  it("Trennung in der Lobby vor dem Start: im Spiel gilt die 90-s-Frist ab der Trennung", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    sim.ok({ type: "DISCONNECT", guestId: ben });
    const disconnectedAt = sim.now;
    sim.advance(1_000);
    sim.ok({ type: "START", guestId: sim.host });
    const timer = [...sim.timers.values()].find((entry) => entry.kind === "reconnect");
    expect(timer?.at).toBe(disconnectedAt + T.reconnectGameMs);
  });

  it("unbekannte Person: Resume → LOBBY_NOT_FOUND, Trennen → ohne Wirkung", () => {
    const sim = lobbyWith(2);
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: guestUuid(77) }))).toBe("LOBBY_NOT_FOUND");
    const before = sim.state;
    const result = sim.dispatch({ type: "DISCONNECT", guestId: guestUuid(77) });
    expect(result).toEqual({ ok: true, state: before, effects: [] });
  });
});

describe("Lobby schließen", () => {
  it("im Spiel: niemand verbunden (60 s, Bots zählen nicht) → geschlossen; danach LOBBY_NOT_FOUND", () => {
    const sim = lobbyWith(2, 1);
    sim.ok({ type: "START", guestId: sim.host });
    const [host = "", ben = ""] = sim.guests;
    sim.ok({ type: "DISCONNECT", guestId: host });
    sim.ok({ type: "DISCONNECT", guestId: ben });
    sim.advance(T.emptyLobbyCloseMs - 1);
    expect(sim.state.closed).toBeNull();
    // Kurz zurück → die 60 s beginnen neu.
    sim.ok({ type: "RECONNECT", guestId: ben });
    sim.ok({ type: "DISCONNECT", guestId: ben });
    sim.advance(T.emptyLobbyCloseMs - 1);
    expect(sim.state.closed).toBeNull();
    sim.advance(1);
    expect(sim.state.closed?.reason).toBe("empty");
    expect(sim.timers.size).toBe(0);
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: ben }))).toBe("LOBBY_NOT_FOUND");
    expect(sim.dispatch({ type: "TIMEOUT", token: sim.state.seq })).toEqual({
      ok: true,
      state: sim.state,
      effects: [],
    });
  });

  it("in der Lobby: alle getrennt → nach der 30-s-Frist entfernt → geschlossen", () => {
    const sim = lobbyWith(2, 1);
    const [host = "", ben = ""] = sim.guests;
    sim.ok({ type: "DISCONNECT", guestId: host });
    sim.ok({ type: "DISCONNECT", guestId: ben });
    sim.advance(T.reconnectLobbyMs);
    expect(sim.state.closed?.reason).toBe("empty");
  });

  it("30 min ohne Aktivität → geschlossen, Verbundene bekommen kicked { inactive }", () => {
    const sim = lobbyWith(2);
    sim.advance(10 * 60_000);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2 } });
    sim.advance(LOBBY_LIFETIME.idleCloseMs - 1);
    expect(sim.state.closed).toBeNull();
    const from = sim.effects.length;
    sim.advance(1);
    expect(sim.state.closed?.reason).toBe("idle");
    expect(sim.effectsOf("kick", from).map((effect) => effect.reason)).toEqual(["inactive", "inactive"]);
    expect(sim.effectsOf("closeLobby", from)).toEqual([{ type: "closeLobby", reason: "idle" }]);
  });

  it("2 h nach Spielende → geschlossen", () => {
    const sim = lobbyWith(2, 0, { timing: "fast" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    sim.playToEnd();
    const endedAt = sim.state.game?.endedAt ?? 0;
    sim.advance(endedAt + LOBBY_LIFETIME.afterGameCloseMs - sim.now - 1);
    expect(sim.state.closed).toBeNull();
    sim.advance(1);
    expect(sim.state.closed?.reason).toBe("after_game");
  });
});

describe("Dev-Bots", () => {
  it("nur Host, nur Lobby; Namen „Bot n“; höchstens 7; Bots sind immer verbunden", () => {
    const sim = lobbyWith(2);
    const ben = sim.guests[1] ?? "";
    expect(errorCode(sim.dispatch({ type: "ADD_BOT", guestId: ben }))).toBe("NOT_HOST");
    for (let i = 0; i < 6; i++) sim.addBot();
    expect(errorCode(sim.dispatch({ type: "ADD_BOT", guestId: sim.host }))).toBe("LOBBY_FULL");
    const bots = toPublicState(sim.state).players.filter((player) => player.isBot);
    expect(bots.map((bot) => bot.name)).toEqual(["Bot 1", "Bot 2", "Bot 3", "Bot 4", "Bot 5", "Bot 6"]);
    expect(bots.every((bot) => bot.connected && !bot.isHost)).toBe(true);
    // Bots haben synthetische guestIds, keine sendPrivate-Effects.
    expect(sim.state.players.filter((player) => player.isBot).every((bot) => bot.guestId.startsWith("bot:"))).toBe(
      true,
    );
    expect(sim.effectsOf("sendPrivate").some((effect) => effect.guestId.startsWith("bot:"))).toBe(false);
  });

  it("maximal 7 Bots, auch wenn Plätze frei wären", () => {
    const sim = lobbyWith(1);
    for (let i = 0; i < 7; i++) sim.addBot();
    expect(sim.state.players).toHaveLength(8);
    expect(errorCode(sim.dispatch({ type: "ADD_BOT", guestId: sim.host }))).toBe("LOBBY_FULL");
  });
});

describe("Start", () => {
  it("nur Host, nur Lobby, ≥ 2 verbundene Personen (Bots zählen, Getrennte nicht)", () => {
    const sim = lobbyWith(2);
    const ben = sim.guests[1] ?? "";
    expect(errorCode(sim.dispatch({ type: "START", guestId: ben }))).toBe("NOT_HOST");
    sim.ok({ type: "DISCONNECT", guestId: ben });
    expect(errorCode(sim.dispatch({ type: "START", guestId: sim.host }))).toBe("NOT_ENOUGH_PLAYERS");
    sim.addBot();
    sim.ok({ type: "START", guestId: sim.host });
    expect(sim.state.phase).toBe("intro");
    expect(errorCode(sim.dispatch({ type: "START", guestId: sim.host }))).toBe("INVALID_PHASE");
  });
});
