/**
 * Lobby-Abläufe über den echten Transport (docs/01 §Lobby, docs/05, docs/06 §Kontingente): Erstellen,
 * Beitreten, Fehlerfälle (unbekannter Code, Name, volle Lobby, zweite gehostete Lobby), Kick + Sperre,
 * Host-Übergabe beim Verlassen, Einstellungen, Kill-Switches, Turnstile-Notfallschalter, „ein Socket in
 * höchstens einer Lobby“ und „DISCONNECT erst beim letzten Socket“.
 */
import { randomUUID } from "node:crypto";
import type { PublicLobbyState } from "@quizmaster/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { countsAsResumeFailure } from "../../src/handlers/lobby.ts";
import { eventually, type TestServer } from "../helpers/index.ts";
import {
  actorOf,
  connectGuest,
  createLobby,
  joinLobby,
  lastSelf,
  lastState,
  runtimeOf,
  serverSocketOf,
  startGameServer,
} from "./support.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startGameServer();
});
afterAll(() => server?.cleanup());

function playerNamed(state: PublicLobbyState | undefined, name: string) {
  return state?.players.find((player) => player.name === name);
}

describe("Erstellen und Beitreten", () => {
  it("create → Ack mit Code, dann lobby:state + lobby:self; join per roher Code-Eingabe", async () => {
    const host = await connectGuest(server);
    const ack = await host.emit("lobby:create", { name: "  Mia  " });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    const code = ack.data.code;
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    await eventually(() => lastSelf(host) !== undefined);
    // Reihenfolge laut docs/02: erst das Ack (oben abgewartet), danach Zustand + privater Zustand.
    const events = host.received.map((entry) => entry.event);
    expect(events.slice(0, 2).sort()).toEqual(["lobby:self", "lobby:state"]);
    const state = lastState(host);
    expect(state?.code).toBe(code);
    expect(state?.players).toHaveLength(1);
    expect(state?.players[0]).toMatchObject({
      name: "Mia",
      isHost: true,
      isBot: false,
      connected: true,
      color: "blue",
    });
    expect(lastSelf(host)).toMatchObject({ isHost: true, canPick: false, myAnswer: null });
    expect(await server.db.repos.lobbies.isCodeTaken(code)).toBe(true);

    const guest = await connectGuest(server);
    const hostSees = host.waitFor("lobby:state", (next) => next.players.length === 2);
    const joined = await guest.emit("lobby:join", {
      code: `${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`,
      name: "Ben",
    });
    expect(joined).toEqual({ ok: true, data: { code } });
    const both = await hostSees;
    expect(playerNamed(both, "Ben")).toMatchObject({ isHost: false, color: "sky", connected: true, score: 0 });
    expect(host.contractViolations).toEqual([]);
    expect(guest.contractViolations).toEqual([]);
    host.close();
    guest.close();
  });

  it("unbekannter Code → LOBBY_NOT_FOUND; ungültige/reservierte/beleidigende Namen → NAME_REJECTED", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const guest = await connectGuest(server);
    const unknown = code === "ABCDEF" ? "ABCDEG" : "ABCDEF";
    expect(await guest.emit("lobby:join", { code: unknown, name: "Ben" })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_NOT_FOUND" },
    });
    for (const name of ["A", "Admin", "4dm1n", "Ben​", "Mia 🙂", "Arschloch"]) {
      const result = await guest.emit("lobby:join", { code, name });
      expect(result, name).toMatchObject({ ok: false, error: { code: "NAME_REJECTED" } });
      if (!result.ok) expect(result.error.message).not.toContain(name);
    }
    expect(await guest.emit("lobby:create", { name: "Hure" })).toMatchObject({
      ok: false,
      error: { code: "NAME_REJECTED" },
    });
    // Abgelehnte Beitritte hinterlassen keinen Socket im Raum der Lobby.
    expect(actorOf(server, code).hasSocket(serverSocketOf(server, guest))).toBe(false);
    expect(guest.received.filter((entry) => entry.event === "lobby:state")).toEqual([]);
    host.close();
    guest.close();
  });

  it("volle Lobby → LOBBY_FULL; maxPlayers unter der Personenzahl → INVALID_OPTION; nur der Host stellt ein", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const second = await connectGuest(server);
    await joinLobby(second, code, "Ben");
    expect(await second.emit("lobby:update-settings", { rounds: 5 })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    expect(await host.emit("lobby:update-settings", { maxPlayers: 2 })).toEqual({ ok: true, data: null });
    const third = await connectGuest(server);
    expect(await third.emit("lobby:join", { code, name: "Lea" })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_FULL" },
    });
    expect(await host.emit("lobby:update-settings", { maxPlayers: 3 })).toEqual({ ok: true, data: null });
    const three = host.waitFor("lobby:state", (next) => next.players.length === 3);
    await joinLobby(third, code, "Lea");
    await three;
    expect(await host.emit("lobby:update-settings", { maxPlayers: 2 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    expect(lastState(host)?.settings).toEqual({ rounds: 3, questionsPerCategory: 3, maxPlayers: 3 });
    for (const client of [host, second, third]) client.close();
  });

  it("Start: nur Host, mindestens 2 verbundene Personen", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    expect(await host.emit("lobby:start", {})).toMatchObject({ ok: false, error: { code: "NOT_ENOUGH_PLAYERS" } });
    const guest = await connectGuest(server);
    await joinLobby(guest, code, "Ben");
    expect(await guest.emit("lobby:start", {})).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    host.close();
    guest.close();
  });
});

describe("Code-Raten", () => {
  it("resume verrät nicht, ob ein Code existiert (identische Antwort wie für unbekannte Codes)", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const stranger = await connectGuest(server);
    const unknown = code === "ZZZZZZ" ? "ZZZZZY" : "ZZZZZZ";
    const known = await stranger.emit("lobby:resume", { code });
    const missing = await stranger.emit("lobby:resume", { code: unknown });
    expect(known).toMatchObject({ ok: false, error: { code: "LOBBY_NOT_FOUND" } });
    expect(known).toEqual(missing);
    expect(await stranger.emit("lobby:leave", {})).toEqual(missing);
    expect(stranger.received.filter((entry) => entry.event === "lobby:state")).toEqual([]);
    host.close();
    stranger.close();
  });

  it("20 fehlgeschlagene Beitritte je IP in 5 min → RATE_LIMITED (15 min Sperre), auch für gültige Codes", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const ip = server.nextIp();
    // Mehrere Sockets derselben IP (das Socket-Limit von 10 Beitritten je Minute greift sonst zuerst).
    const guessers = await Promise.all([0, 1, 2].map(() => connectGuest(server, { ip })));
    let failures = 0;
    for (const guesser of guessers) {
      for (let attempt = 0; attempt < 7 && failures < 20; attempt++) {
        const wrong = code === "ZZZZZZ" ? "ZZZZZY" : "ZZZZZZ";
        const result = await guesser.emit("lobby:join", { code: wrong, name: "Rater" });
        expect(result).toMatchObject({ ok: false, error: { code: "LOBBY_NOT_FOUND" } });
        failures += 1;
      }
    }
    const last = guessers[2];
    if (last === undefined) throw new Error("Client fehlt");
    expect(await last.emit("lobby:join", { code: "ZZZZZX", name: "Rater" })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_NOT_FOUND" },
    });
    // Der Kern verbucht den Fehlversuch VOR dem Ack: Der direkt folgende Versuch ist schon gesperrt.
    const blocked = await last.emit("lobby:join", { code, name: "Rater" });
    expect(blocked).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (!blocked.ok) expect(blocked.error.retryAfterMs).toBeGreaterThan(14 * 60_000);
    // Eine andere IP ist nicht betroffen.
    const other = await connectGuest(server);
    await joinLobby(other, code, "Ben");
    for (const client of [host, ...guessers, other]) client.close();
  });

  it("20 fehlgeschlagene Wiederaufnahmen je IP in 5 min → RATE_LIMITED (eigene Regel, Join bleibt frei)", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const ip = server.nextIp();
    const guessers = await Promise.all([0, 1, 2].map(() => connectGuest(server, { ip })));
    const wrong = code === "ZZZZZZ" ? "ZZZZZY" : "ZZZZZZ";
    for (let attempt = 0; attempt < 21; attempt++) {
      const guesser = guessers[Math.floor(attempt / 9)];
      if (guesser === undefined) throw new Error("Client fehlt");
      expect(await guesser.emit("lobby:resume", { code: wrong })).toMatchObject({
        ok: false,
        error: { code: "LOBBY_NOT_FOUND" },
      });
    }
    const last = guessers[2];
    if (last === undefined) throw new Error("Client fehlt");
    const blocked = await last.emit("lobby:resume", { code });
    expect(blocked).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (!blocked.ok) expect(blocked.error.retryAfterMs).toBeGreaterThan(14 * 60_000);
    // Beitreten zählt getrennt und ist von derselben IP weiter möglich.
    await joinLobby(last, code, "Rater");
    for (const client of [host, ...guessers]) client.close();
  });

  it("nur LOBBY_NOT_FOUND zählt bei lobby:resume als Fehlversuch", () => {
    expect(countsAsResumeFailure("LOBBY_NOT_FOUND")).toBe(true);
    for (const code of ["KICKED", "RESIGNED", "INTERNAL", "SERVER_BUSY", "RATE_LIMITED"] as const) {
      expect(countsAsResumeFailure(code), code).toBe(false);
    }
  });
});

describe("Kontingente und Kill-Switches", () => {
  afterEach(async () => {
    await server.app.services.appConfig.load();
  });

  it("zweite gehostete Lobby → RATE_LIMITED; nach dem Verlassen der ersten wieder erlaubt", async () => {
    const guestId = randomUUID();
    const first = await connectGuest(server, { guestId });
    const other = await connectGuest(server, { guestId });
    const code = await createLobby(first, "Mia");
    expect(runtimeOf(server).lobbies.hostsActiveLobby(guestId)).toBe(true);
    expect(await other.emit("lobby:create", { name: "Mia" })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
    expect(await first.emit("lobby:leave", {})).toEqual({ ok: true, data: null });
    // Ohne Menschen schließt die Lobby sofort; der Code ist wieder frei.
    await eventually(() => runtimeOf(server).lobbies.get(code) === undefined);
    await eventually(async () => !(await server.db.repos.lobbies.isCodeTaken(code)));
    expect((await other.emit("lobby:create", { name: "Mia" })).ok).toBe(true);
    first.close();
    other.close();
  });

  it("lobby:create nur ohne aktive Lobby-Mitgliedschaft (docs/05): Mitglied woanders → RATE_LIMITED", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const guestId = randomUUID();
    const member = await connectGuest(server, { guestId });
    await joinLobby(member, code, "Ben");
    // Zweites Gerät/Tab desselben Gasts ohne eigene Lobby-Zuordnung – und der Lobby-Socket selbst.
    const otherDevice = await connectGuest(server, { guestId });
    expect(await otherDevice.emit("lobby:create", { name: "Ben" })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
    expect(await member.emit("lobby:create", { name: "Ben" })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
    // Weiterhin genau EINE Mitgliedschaft – die Zuordnung „einzige Lobby des Gasts“ bleibt eindeutig.
    expect(
      runtimeOf(server)
        .lobbies.membershipsOf(guestId)
        .map((actor) => actor.code),
    ).toEqual([code]);
    expect(actorOf(server, code).hasSocket(serverSocketOf(server, member))).toBe(true);
    // Nach dem Verlassen ist die Erstellung erlaubt.
    expect(await member.emit("lobby:leave", {})).toEqual({ ok: true, data: null });
    expect((await otherDevice.emit("lobby:create", { name: "Ben" })).ok).toBe(true);
    for (const client of [host, member, otherDevice]) client.close();
  });

  it("lobbyCreationEnabled=false → LOBBY_CREATION_DISABLED; maxActiveLobbies erreicht → SERVER_BUSY", async () => {
    const config = server.app.services.appConfig;
    const client = await connectGuest(server);
    config.apply({ ...config.get(), lobbyCreationEnabled: false });
    expect(await client.emit("lobby:create", { name: "Mia" })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_CREATION_DISABLED" },
    });
    config.apply({ ...config.get(), lobbyCreationEnabled: true, maxActiveLobbies: runtimeOf(server).lobbies.size });
    expect(await client.emit("lobby:create", { name: "Mia" })).toMatchObject({
      ok: false,
      error: { code: "SERVER_BUSY" },
    });
    client.close();
  });

  it("turnstileOnJoin: create/join nur mit frischem tsv im Ticket, resume/Wiederbeitritt ohne", async () => {
    const config = server.app.services.appConfig;
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const member = await connectGuest(server);
    await joinLobby(member, code, "Ben");
    config.apply({ ...config.get(), turnstileOnJoin: true });

    const plain = await connectGuest(server);
    expect(await plain.emit("lobby:create", { name: "Lea" })).toMatchObject({
      ok: false,
      error: { code: "TURNSTILE_REQUIRED" },
    });
    expect(await plain.emit("lobby:join", { code, name: "Lea" })).toMatchObject({
      ok: false,
      error: { code: "TURNSTILE_REQUIRED" },
    });
    // Auch unbekannte Codes: ohne Turnstile ist nicht erkennbar, ob ein Code existiert.
    const unknown = code === "ZZZZZZ" ? "ZZZZZY" : "ZZZZZZ";
    expect(await plain.emit("lobby:join", { code: unknown, name: "Lea" })).toMatchObject({
      ok: false,
      error: { code: "TURNSTILE_REQUIRED" },
    });
    const stale = await connectGuest(server, { ticketOptions: { tsv: Date.now() - 10 * 60_000 } });
    expect(await stale.emit("lobby:join", { code, name: "Lea" })).toMatchObject({
      ok: false,
      error: { code: "TURNSTILE_REQUIRED" },
    });
    const verified = await connectGuest(server, { ticketOptions: { tsv: Date.now() } });
    expect(await verified.emit("lobby:join", { code, name: "Lea" })).toEqual({ ok: true, data: { code } });
    // Mitglieder brauchen kein neues Turnstile (JOIN wirkt wie RECONNECT, resume ist immer frei).
    const memberAgain = await connectGuest(server, { guestId: member.guestId });
    expect(await memberAgain.emit("lobby:join", { code, name: "egal" })).toEqual({ ok: true, data: { code } });
    expect(await memberAgain.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    for (const client of [host, member, plain, stale, verified, memberAgain]) client.close();
  });
});

describe("Kick, Verlassen, Host-Übergabe", () => {
  it("Kick: kicked { host }, Person weg, Wiederbeitritt und resume → KICKED; Host kann sich nicht selbst entfernen", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const guest = await connectGuest(server);
    const guestSelf = await joinLobby(guest, code, "Ben");
    const other = await connectGuest(server);
    await joinLobby(other, code, "Lea");

    expect(await other.emit("lobby:kick", { playerId: guestSelf.playerId })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    const hostSelf = lastSelf(host);
    expect(await host.emit("lobby:kick", { playerId: hostSelf?.playerId ?? "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    const kicked = guest.waitFor("kicked");
    const hostSees = host.waitFor("lobby:state", (state) => state.players.length === 2);
    expect(await host.emit("lobby:kick", { playerId: guestSelf.playerId })).toEqual({ ok: true, data: null });
    expect(await kicked).toEqual({ reason: "host" });
    expect(playerNamed(await hostSees, "Ben")).toBeUndefined();
    expect(actorOf(server, code).hasSocket(serverSocketOf(server, guest))).toBe(false);

    expect(await guest.emit("lobby:join", { code, name: "Ben" })).toMatchObject({
      ok: false,
      error: { code: "KICKED" },
    });
    expect(await guest.emit("lobby:resume", { code })).toMatchObject({ ok: false, error: { code: "KICKED" } });
    const fresh = await connectGuest(server, { guestId: guest.guestId });
    expect(await fresh.emit("lobby:join", { code, name: "Benno" })).toMatchObject({
      ok: false,
      error: { code: "KICKED" },
    });
    // Nach dem Kick bekommt die entfernte Person keine Zustände dieser Lobby mehr.
    const statesBefore = guest.received.length;
    const updated = host.waitFor("lobby:state", (state) => state.settings.rounds === 4);
    expect(await host.emit("lobby:update-settings", { rounds: 4 })).toEqual({ ok: true, data: null });
    await updated;
    expect(guest.received.length).toBe(statesBefore);
    for (const client of [host, guest, other, fresh]) client.close();
  });

  it("Host verlässt die Lobby → die am längsten anwesende Person wird Host (notice HOST_CHANGED)", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const ben = await connectGuest(server);
    await joinLobby(ben, code, "Ben");
    const lea = await connectGuest(server);
    await joinLobby(lea, code, "Lea");

    const notice = ben.waitFor("notice");
    const benSelf = ben.waitFor("lobby:self", (self) => self.isHost);
    const state = lea.waitFor("lobby:state", (next) => next.players.length === 2);
    expect(await host.emit("lobby:leave", {})).toEqual({ ok: true, data: null });
    expect(await notice).toEqual({ code: "HOST_CHANGED" });
    expect((await benSelf).isHost).toBe(true);
    const after = await state;
    expect(playerNamed(after, "Ben")?.isHost).toBe(true);
    expect(playerNamed(after, "Mia")).toBeUndefined();
    // Die Farbe der gegangenen Person ist wieder frei.
    const next = await connectGuest(server);
    await joinLobby(next, code, "Ida");
    expect(playerNamed(lastState(next), "Ida")?.color).toBe("blue");
    // Wer gegangen ist, bekommt nichts mehr aus dieser Lobby und ist kein Mitglied.
    expect(await host.emit("lobby:leave", {})).toMatchObject({ ok: false, error: { code: "LOBBY_NOT_FOUND" } });
    for (const client of [host, ben, lea, next]) client.close();
  });
});

describe("Sockets", () => {
  it("DISCONNECT erst, wenn der letzte Socket der Person in der Lobby weg ist", async () => {
    const guestId = randomUUID();
    const host = await connectGuest(server, { guestId });
    const code = await createLobby(host);
    const secondTab = await connectGuest(server, { guestId });
    expect(await secondTab.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    const watcher = await connectGuest(server);
    await joinLobby(watcher, code, "Ben");
    expect(actorOf(server, code).socketsOf(guestId)).toHaveLength(2);

    host.close();
    await eventually(() => actorOf(server, code).socketsOf(guestId).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(playerNamed(lastState(watcher), "Mia")?.connected).toBe(true);

    const disconnected = watcher.waitFor("lobby:state", (state) => playerNamed(state, "Mia")?.connected === false);
    secondTab.close();
    await disconnected;
    // Wiederverbinden innerhalb der Frist: gleicher Platz.
    const back = await connectGuest(server, { guestId });
    const self = back.waitFor("lobby:self");
    expect(await back.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    expect((await self).isHost).toBe(true);
    await watcher.waitFor("lobby:state", (state) => playerNamed(state, "Mia")?.connected === true);
    back.close();
    watcher.close();
  });

  it("ein Socket gehört zu höchstens einer Lobby: Beitritt woanders löst ihn aus der alten (dort getrennt)", async () => {
    const hostA = await connectGuest(server);
    const codeA = await createLobby(hostA, "Mia");
    const hostB = await connectGuest(server);
    const codeB = await createLobby(hostB, "Tom");
    const wanderer = await connectGuest(server);
    await joinLobby(wanderer, codeA, "Ben");

    const leftA = hostA.waitFor("lobby:state", (state) => playerNamed(state, "Ben")?.connected === false);
    await joinLobby(wanderer, codeB, "Ben");
    await leftA;
    const wandererSocket = serverSocketOf(server, wanderer);
    expect(runtimeOf(server).lobbies.actorOfSocket(wandererSocket)?.code).toBe(codeB);
    expect(actorOf(server, codeA).hasSocket(wandererSocket)).toBe(false);
    // In A ist Ben noch Mitglied (getrennt) – nach der Reconnect-Frist der Lobby (fast: 2 s) entfernt.
    await hostA.waitFor("lobby:state", (state) => playerNamed(state, "Ben") === undefined, 10_000);
    for (const client of [hostA, hostB, wanderer]) client.close();
  });

  it("Lobby ohne verbundene Menschen schließt nach der Frist (fast: 2 s) und gibt den Code frei", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const actor = actorOf(server, code);
    host.close();
    await eventually(() => runtimeOf(server).lobbies.get(code) === undefined, 10_000);
    expect(actor.closed).toBe(true);
    await eventually(async () => (await server.db.repos.lobbies.findById(actor.lobbyId))?.active === false);
    expect(await server.db.repos.lobbies.isCodeTaken(code)).toBe(false);
  });
});
