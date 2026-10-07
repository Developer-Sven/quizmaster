/**
 * Lobby-Abläufe über den echten Transport (docs/01 §Lobby, docs/05, docs/06 §Kontingente): Erstellen,
 * Beitreten, Fehlerfälle (unbekannter Code, Name, volle Lobby, zweite gehostete Lobby), Kick + Sperre,
 * Host-Übergabe beim Verlassen, Einstellungen, Kill-Switches, Turnstile-Notfallschalter, „ein Socket in
 * höchstens einer Lobby“ und „DISCONNECT erst beim letzten Socket“.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_LOBBY_SETTINGS, type PublicLobbyState } from "@quizmaster/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { countsAsCodeGuess } from "../../src/handlers/lobby.ts";
import { eventually, metricValue, type TestServer } from "../helpers/index.ts";
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
  waitForPhase,
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
    expect(lastState(host)?.settings).toEqual({ ...DEFAULT_LOBBY_SETTINGS, maxPlayers: 3 });
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

  it("20 fehlgeschlagene Beitritte je IP in 5 min → RATE_LIMITED (5 min Sperre, ADR-042), auch für gültige Codes", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    const ip = server.nextIp();
    // Mehrere Sockets derselben IP (das Socket-Limit von 20 Beitritten je Minute greift sonst zuerst).
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
    if (!blocked.ok) {
      expect(blocked.error.retryAfterMs).toBeGreaterThan(4 * 60_000);
      expect(blocked.error.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
    }
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
    if (!blocked.ok) {
      expect(blocked.error.retryAfterMs).toBeGreaterThan(4 * 60_000);
      expect(blocked.error.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
    }
    // Beitreten zählt getrennt und ist von derselben IP weiter möglich.
    await joinLobby(last, code, "Rater");
    for (const client of [host, ...guessers]) client.close();
  });

  it("nur LOBBY_NOT_FOUND zählt bei lobby:join und lobby:resume als Fehlversuch (Code-Raten)", () => {
    expect(countsAsCodeGuess("LOBBY_NOT_FOUND")).toBe(true);
    for (const code of [
      "KICKED",
      "RESIGNED",
      "LOBBY_FULL",
      "GAME_IN_PROGRESS",
      "NAME_REJECTED",
      "TURNSTILE_REQUIRED",
      "INTERNAL",
      "SERVER_BUSY",
      "RATE_LIMITED",
    ] as const) {
      expect(countsAsCodeGuess(code), code).toBe(false);
    }
  });

  it("Ablehnungen existierender Codes (voll, Name, läuft) sperren die IP nicht – eine Klasse vor einer vollen Lobby", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host);
    expect((await host.emit("lobby:update-settings", { maxPlayers: 2 })).ok).toBe(true);
    const ip = server.nextIp();
    const classmates = await Promise.all([0, 1, 2].map(() => connectGuest(server, { ip })));
    const [first] = classmates;
    if (first === undefined) throw new Error("Client fehlt");
    await joinLobby(first, code, "Ben");
    let rejected = 0;
    for (const classmate of classmates.slice(1)) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const name = attempt % 2 === 0 ? "admin" : `Kind ${attempt}`;
        const result = await classmate.emit("lobby:join", { code, name });
        expect(result).toMatchObject({
          ok: false,
          error: { code: attempt % 2 === 0 ? "NAME_REJECTED" : "LOBBY_FULL" },
        });
        rejected += 1;
      }
    }
    expect(rejected).toBe(20);
    // 21. Ablehnung (laufendes Spiel) – danach tritt eine weitere Person derselben IP einer anderen Lobby bei.
    const opponent = await connectGuest(server);
    const other = await createLobby(opponent, "Olga");
    const late = await connectGuest(server, { ip });
    await joinLobby(late, other, "Lea");
    expect(await opponent.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    const third = await connectGuest(server, { ip });
    expect(await third.emit("lobby:join", { code: other, name: "Tim" })).toMatchObject({
      ok: false,
      error: { code: "GAME_IN_PROGRESS" },
    });
    const nora = await connectGuest(server);
    const ownCode = await createLobby(nora, "Nora");
    const newcomer = await connectGuest(server, { ip });
    await joinLobby(newcomer, ownCode, "Neu");
    for (const client of [host, ...classmates, opponent, late, third, nora, newcomer]) client.close();
  });

  it("IP-Sperre durch Code-Raten eines Mitnutzers: Mitglieder kommen per resume und join zurück, ohne Verstöße", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const ip = server.nextIp();
    const member = await connectGuest(server, { ip });
    await joinLobby(member, code, "Ben");
    // Mitnutzer derselben IP rät Codes über resume und join, bis beide Sperren greifen.
    const guessers = await Promise.all([0, 1, 2, 3, 4].map(() => connectGuest(server, { ip })));
    const wrong = code === "ZZZZZZ" ? "ZZZZZY" : "ZZZZZZ";
    for (let attempt = 0; attempt < 21; attempt++) {
      const guesser = guessers[Math.floor(attempt / 9)];
      if (guesser === undefined) throw new Error("Client fehlt");
      expect(await guesser.emit("lobby:resume", { code: wrong })).toMatchObject({ error: { code: "LOBBY_NOT_FOUND" } });
    }
    for (let attempt = 0; attempt < 21; attempt++) {
      const guesser = guessers[2 + Math.floor(attempt / 9)];
      if (guesser === undefined) throw new Error("Client fehlt");
      expect(await guesser.emit("lobby:join", { code: wrong, name: "Rater" })).toMatchObject({
        error: { code: "LOBBY_NOT_FOUND" },
      });
    }
    const stranger = await connectGuest(server, { ip });
    expect(await stranger.emit("lobby:resume", { code })).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(await stranger.emit("lobby:join", { code, name: "Fremd" })).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    const violationsBefore = await metricValue(server.app.services.metrics, "qm_violations_total", {
      reason: "rate_limit",
    });
    // Das Mitglied verbindet neu (gleicher Gast, gleiche IP) und kehrt zurück – per resume und per join (Link).
    const rejoined = await connectGuest(server, { ip, guestId: member.guestId });
    member.close();
    expect(await rejoined.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    expect(await rejoined.emit("lobby:join", { code, name: "Ben" })).toEqual({ ok: true, data: { code } });
    // Blockierte Versuche Unbeteiligter derselben IP sind keine Verstöße (keine Trennung, keine Sperre).
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await stranger.emit("lobby:resume", { code })).toMatchObject({ error: { code: "RATE_LIMITED" } });
    }
    expect(await metricValue(server.app.services.metrics, "qm_violations_total", { reason: "rate_limit" })).toBe(
      violationsBefore,
    );
    expect(stranger.socket.connected).toBe(true);
    for (const client of [host, rejoined, stranger, ...guessers]) client.close();
  });
});

describe("Kontingente und Kill-Switches", () => {
  afterEach(async () => {
    await server.app.services.appConfig.load();
  });

  it("zweite Lobby desselben Gasts: die erste wird vorher verlassen (ADR-042) – ohne Menschen geschlossen", async () => {
    const guestId = randomUUID();
    const first = await connectGuest(server, { guestId });
    const other = await connectGuest(server, { guestId });
    const code = await createLobby(first, "Mia");
    expect(runtimeOf(server).lobbies.hostsActiveLobby(guestId)).toBe(true);
    const created = await other.emit("lobby:create", { name: "Mia" });
    if (!created.ok) throw new Error(created.error.code);
    expect(created.data.code).not.toBe(code);
    // Die alte Lobby hatte nur diese Person: sie schließt sofort, der Code ist wieder frei.
    await eventually(() => runtimeOf(server).lobbies.get(code) === undefined);
    await eventually(async () => !(await server.db.repos.lobbies.isCodeTaken(code)));
    expect(
      runtimeOf(server)
        .lobbies.membershipsOf(guestId)
        .map((actor) => actor.code),
    ).toEqual([created.data.code]);
    first.close();
    other.close();
  });

  it("lobby:create als Mitglied einer anderen Lobby: verlässt sie zuerst, die anderen bleiben (ADR-042)", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const guestId = randomUUID();
    const member = await connectGuest(server, { guestId });
    await joinLobby(member, code, "Ben");
    // Zweites Gerät/Tab desselben Gasts ohne eigene Lobby-Zuordnung.
    const otherDevice = await connectGuest(server, { guestId });
    const left = host.waitFor("lobby:state", (state) => state.players.length === 1);
    const created = await otherDevice.emit("lobby:create", { name: "Ben" });
    if (!created.ok) throw new Error(created.error.code);
    expect((await left).players.map((player) => player.name)).toEqual(["Mia"]);
    // Weiterhin genau EINE Mitgliedschaft – die Zuordnung „einzige Lobby des Gasts“ bleibt eindeutig.
    expect(
      runtimeOf(server)
        .lobbies.membershipsOf(guestId)
        .map((actor) => actor.code),
    ).toEqual([created.data.code]);
    expect(actorOf(server, code).hasSocket(serverSocketOf(server, member))).toBe(false);
    // Der Lobby-Socket selbst darf ebenfalls neu erstellen: er verlässt die eben erstellte Lobby.
    const again = await member.emit("lobby:create", { name: "Ben" });
    if (!again.ok) throw new Error(again.error.code);
    expect(
      runtimeOf(server)
        .lobbies.membershipsOf(guestId)
        .map((actor) => actor.code),
    ).toEqual([again.data.code]);
    for (const client of [host, member, otherDevice]) client.close();
  });

  it("lobby:create, die abgelehnt wird, lässt die bisherige Lobby unberührt – auch mitten im Spiel (ADR-042)", async () => {
    const config = server.app.services.appConfig;
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const ben = await connectGuest(server);
    await joinLobby(ben, code, "Ben");
    const running = waitForPhase(ben, "intro");
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    await running;
    const membership = () => {
      const player = actorOf(server, code).state.players.find((entry) => entry.guestId === ben.guestId);
      return { left: player?.left, status: player?.status };
    };
    // Kill-Switch: abgelehnt, bevor jemand eine Lobby verlässt (im Spiel hieße das „Aufgegeben“).
    config.apply({ ...config.get(), lobbyCreationEnabled: false });
    try {
      expect(await ben.emit("lobby:create", { name: "Ben" })).toMatchObject({
        ok: false,
        error: { code: "LOBBY_CREATION_DISABLED" },
      });
    } finally {
      config.apply({ ...config.get(), lobbyCreationEnabled: true });
    }
    expect(membership()).toEqual({ left: false, status: "active" });
    // Datenbank nicht erreichbar (Netzaussetzer, ADR-057): ebenso – verlassen wird erst, wenn die neue Lobby steht.
    const insert = vi.spyOn(server.db.repos.lobbies, "insert").mockRejectedValueOnce(new Error("Netz weg"));
    try {
      expect(await ben.emit("lobby:create", { name: "Ben" })).toMatchObject({
        ok: false,
        error: { code: "SERVER_BUSY" },
      });
    } finally {
      insert.mockRestore();
    }
    expect(membership()).toEqual({ left: false, status: "active" });
    expect(
      runtimeOf(server)
        .lobbies.membershipsOf(ben.guestId)
        .map((actor) => actor.code),
    ).toEqual([code]);
    // Klappt die Erstellung, verlässt Ben das laufende Spiel wie gewohnt (Aufgeben).
    const created = await ben.emit("lobby:create", { name: "Ben" });
    if (!created.ok) throw new Error(created.error.code);
    expect(
      runtimeOf(server)
        .lobbies.membershipsOf(ben.guestId)
        .map((actor) => actor.code),
    ).toEqual([created.data.code]);
    host.close();
    ben.close();
  });

  it("lobbyCreationEnabled=false → LOBBY_CREATION_DISABLED; maxActiveLobbies erreicht → SERVER_BUSY", async () => {
    const config = server.app.services.appConfig;
    const client = await connectGuest(server);
    config.apply({ ...config.get(), lobbyCreationEnabled: false });
    expect(await client.emit("lobby:create", { name: "Mia" })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_CREATION_DISABLED" },
    });
    // Eine eigene Lobby bleibt offen – unabhängig davon, ob Lobbys früherer Tests gerade schließen.
    config.apply({ ...config.get(), lobbyCreationEnabled: true });
    const keeper = await connectGuest(server);
    await createLobby(keeper, "Lea");
    config.apply({ ...config.get(), maxActiveLobbies: 1 });
    expect(await client.emit("lobby:create", { name: "Mia" })).toMatchObject({
      ok: false,
      error: { code: "SERVER_BUSY" },
    });
    config.apply({ ...config.get(), maxActiveLobbies: 5_000 });
    for (const entry of [client, keeper]) entry.close();
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

describe("Namen ändern (ADR-041)", () => {
  it("lobby:rename: eigener Name in der Lobby, alle sehen ihn; moderiert; eindeutig", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const guest = await connectGuest(server);
    await joinLobby(guest, code, "Gast-123456");
    const renamed = host.waitFor("lobby:state", (state) => state.players.some((player) => player.name === "Ben"));
    expect(await guest.emit("lobby:rename", { name: "  Ben  " })).toEqual({ ok: true, data: null });
    expect((await renamed).players.map((player) => player.name)).toEqual(["Mia", "Ben"]);
    // Name der anderen Person → eindeutig; Beleidigung → NAME_REJECTED; zu kurz → NAME_REJECTED.
    expect(await guest.emit("lobby:rename", { name: "Mia" })).toEqual({ ok: true, data: null });
    await eventually(() => lastState(host)?.players[1]?.name === "Mia 2");
    expect(await guest.emit("lobby:rename", { name: "Arschloch" })).toMatchObject({
      ok: false,
      error: { code: "NAME_REJECTED" },
    });
    expect(await guest.emit("lobby:rename", { name: "x" })).toMatchObject({
      ok: false,
      error: { code: "NAME_REJECTED" },
    });
    expect(lastState(host)?.players[1]?.name).toBe("Mia 2");
    for (const client of [host, guest]) client.close();
  });

  it("lobby:rename nur für Mitglieder und nur in der Lobby", async () => {
    const outsider = await connectGuest(server);
    expect(await outsider.emit("lobby:rename", { name: "Lea" })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_NOT_FOUND" },
    });
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const guest = await connectGuest(server);
    await joinLobby(guest, code, "Ben");
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    expect(await guest.emit("lobby:rename", { name: "Benni" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
    for (const client of [outsider, host, guest]) client.close();
  });
});

describe("Host übertragen (ADR-047)", () => {
  it("lobby:transfer-host: Host gibt ab, alle erfahren es, der neue Host darf einstellen", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const guest = await connectGuest(server);
    await joinLobby(guest, code, "Ben");
    const benId = lastSelf(guest)?.playerId ?? "";
    const changed = guest.waitFor("notice", (notice) => notice.code === "HOST_CHANGED");
    expect(await guest.emit("lobby:transfer-host", { playerId: benId })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    expect(await host.emit("lobby:transfer-host", { playerId: benId })).toEqual({ ok: true, data: null });
    await changed;
    await eventually(() => lastSelf(guest)?.isHost === true);
    expect(await guest.emit("lobby:update-settings", { rounds: 2 })).toEqual({ ok: true, data: null });
    expect(await host.emit("lobby:update-settings", { rounds: 4 })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    expect(await guest.emit("lobby:transfer-host", { playerId: "p_unbekannt" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    for (const client of [host, guest]) client.close();
  });
});

describe("Kategorien begrenzen (ADR-048)", () => {
  it("nur Kategorien aus dem Katalog; null setzt auf alle zurück", async () => {
    const host = await connectGuest(server);
    await createLobby(host, "Mia");
    expect(await host.emit("lobby:update-settings", { categoryIds: ["gibt-es-nicht"] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    const playable = runtimeOf(server).questions.playableCategories();
    const first = playable[0]?.id ?? "";
    expect(await host.emit("lobby:update-settings", { categoryIds: [first] })).toEqual({ ok: true, data: null });
    await eventually(() => lastState(host)?.settings.categoryIds?.[0] === first);
    expect(await host.emit("lobby:update-settings", { categoryIds: null })).toEqual({ ok: true, data: null });
    await eventually(() => lastState(host)?.settings.categoryIds === null);
    host.close();
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
