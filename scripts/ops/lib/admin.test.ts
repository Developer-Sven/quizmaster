import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appConfigPatchSchema } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";
import { defaultAppConfig } from "@quizmaster/shared/documents";
import { ipKey } from "@quizmaster/shared/ip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdminUsageError,
  assertWriteAllowed,
  banExpiry,
  banTarget,
  banTargetKind,
  describeBanLine,
  describeBlockedTerms,
  describeConfig,
  describePurge,
  findGuestInLobby,
  findGuestOfReport,
  maintenancePatch,
  parseConfigAssignments,
  parsePurgeSince,
  purgeGamesByCode,
  resolveBanTarget,
  shortId,
  turnstileWarning,
  updateBlockedTerms,
} from "./admin.ts";

const SECRET = "s".repeat(40);

describe("parseConfigAssignments", () => {
  it("Kill-Switches → Patch, den das Repository akzeptiert", () => {
    const patch = parseConfigAssignments(["lobbyCreationEnabled=false", "turnstileOnJoin=on", "maxActiveLobbies=500"]);
    expect(patch).toEqual({ lobbyCreationEnabled: false, turnstileOnJoin: true, maxActiveLobbies: 500 });
    expect(appConfigPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("Wartung mit Meldung; beim Ausschalten wird die Meldung entfernt", () => {
    expect(parseConfigAssignments(["maintenance=on", "maintenanceMessage= Kurze Wartung "])).toEqual({
      maintenance: { enabled: true, message: "Kurze Wartung" },
    });
    expect(parseConfigAssignments(["maintenance=off"])).toEqual({ maintenance: { enabled: false, message: null } });
  });

  it("lehnt Unbekanntes, falsche Typen und leere Aufrufe ab", () => {
    expect(() => parseConfigAssignments(["lobbyCreation=false"])).toThrow(/unbekannter Schlüssel/);
    expect(() => parseConfigAssignments(["maxActiveLobbies=-1"])).toThrow(/ganze Zahl/);
    expect(() => parseConfigAssignments(["turnstileOnJoin=vielleicht"])).toThrow(/true\/false/);
    expect(() => parseConfigAssignments(["maintenanceMessage=x"])).toThrow(/nur zusammen/);
    expect(() => parseConfigAssignments(["kein-gleich"])).toThrow(AdminUsageError);
    expect(() => parseConfigAssignments([])).toThrow(/mindestens eine/);
  });
});

describe("updateBlockedTerms", () => {
  it("ergänzt ohne Dubletten (Groß-/Kleinschreibung egal) und entfernt", () => {
    expect(updateBlockedTerms(["Troll"], "add", ["troll", "spam", "spam"])).toEqual(["Troll", "spam"]);
    expect(updateBlockedTerms(["Troll", "spam"], "remove", ["TROLL"])).toEqual(["spam"]);
    expect(() => updateBlockedTerms([], "add", [" "])).toThrow(/mindestens einen/);
    expect(() => updateBlockedTerms([], "clear", ["x"])).toThrow(/add, remove oder list/);
  });
});

describe("banTarget", () => {
  it("IP-Sperren speichern denselben HMAC-Schlüssel wie Web/Realtime, nie die IP", () => {
    const target = banTarget({ ip: "203.0.113.7" }, SECRET);
    expect(target).toMatchObject({ kind: "ip", value: ipKey("203.0.113.7", SECRET) });
    expect(target.value).not.toContain("203.0.113.7");
    // IPv6: ganzes /64 (Angreifer rotieren darin).
    expect(banTarget({ ip: "2001:db8:1:2::99" }, SECRET).value).toBe(
      banTarget({ ip: "2001:db8:1:2::1" }, SECRET).value,
    );
  });

  it("Gast per UUID, genau ein Ziel, gültige Werte", () => {
    const guest = "0d9c2b7e-1f0a-4c3b-9d2e-5a6b7c8d9e0f";
    expect(banTarget({ guest: guest.toUpperCase() }, SECRET)).toMatchObject({ kind: "guest", value: guest });
    expect(() => banTarget({}, SECRET)).toThrow(/genau eines/);
    expect(() => banTarget({ guest, ip: "1.2.3.4" }, SECRET)).toThrow(/genau eines/);
    expect(() => banTarget({ guest: "abc" }, SECRET)).toThrow(/UUID/);
    expect(() => banTarget({ ip: "999.1.1.1" }, SECRET)).toThrow(/keine gültige/);
  });
});

describe("parsePurgeSince (admin:game purge --since)", () => {
  it("nimmt ISO-Datum bzw. -Zeitpunkt und lehnt alles andere ab", () => {
    expect(parsePurgeSince(undefined)).toBeUndefined();
    expect(parsePurgeSince("2026-10-01")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(parsePurgeSince("2026-10-01T12:30:00Z")?.toISOString()).toBe("2026-10-01T12:30:00.000Z");
    expect(parsePurgeSince("2026-10-01T14:30:00+02:00")?.toISOString()).toBe("2026-10-01T12:30:00.000Z");
    for (const bad of ["", "gestern", "1.10.2026", "2026-13-01", "2026-02-30", "2026-10-01 12:00", "1759312200000"]) {
      expect(() => parsePurgeSince(bad), bad).toThrow(AdminUsageError);
    }
  });
});

describe("banExpiry, assertWriteAllowed, describeConfig", () => {
  it("Dauer in Stunden, Produktion nur mit Bestätigung, Zusammenfassung ohne Blockliste", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(banExpiry("24", now)?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(banExpiry(undefined, now)).toBeUndefined();
    expect(() => banExpiry("0", now)).toThrow(/1 bis 8784/);
    expect(() => assertWriteAllowed("quizmaster", false)).toThrow(/--confirm-prod/);
    expect(() => assertWriteAllowed("quizmaster", true)).not.toThrow();
    expect(() => assertWriteAllowed("quizmaster_dev", false)).not.toThrow();
    const lines = describeConfig({ ...defaultAppConfig(now), blockedTerms: ["geheimbegriff"] });
    expect(lines.join("\n")).toContain("blockedTerms          1 Begriffe");
    expect(lines.join("\n")).not.toContain("geheimbegriff");
  });
});

describe("admin.ts (CLI)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-admin-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, "prod.env");
  writeFileSync(
    env,
    [
      "MONGODB_URI=mongodb://user:geheimes-passwort@127.0.0.1:1/?tls=true",
      "MONGODB_DB=quizmaster",
      `SESSION_SECRET=${"a".repeat(40)}`,
      `REALTIME_TICKET_SECRET=${"b".repeat(40)}`,
      `IP_HASH_SECRET=${"c".repeat(40)}`,
      `METRICS_TOKEN=${"d".repeat(40)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const cli = (...args: string[]) =>
    new Promise<{ code: number; output: string }>((done) => {
      execFile(
        process.execPath,
        [resolve(import.meta.dirname, "..", "admin.ts"), ...args, "--env-file", env],
        { timeout: 30_000 },
        (error, stdout, stderr) =>
          done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: stdout + stderr }),
      );
    });

  it("bricht vor jeder Verbindung ab: ungültige Zuweisung, fehlende Bestätigung, fehlender Grund", async () => {
    const invalid = await cli("config", "set", "lobbyCreation=false", "--confirm-prod");
    expect(invalid).toMatchObject({ code: 2 });
    expect(invalid.output).toContain("unbekannter Schlüssel lobbyCreation");

    const unconfirmed = await cli("ban", "add", "--ip", "203.0.113.7", "--reason", "Flut");
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.output).toContain("nur mit --confirm-prod");

    const noReason = await cli("ban", "add", "--ip", "203.0.113.7", "--confirm-prod");
    expect(noReason.output).toContain("--reason fehlt");
    for (const result of [invalid, unconfirmed, noReason]) expect(result.output).not.toContain("geheimes-passwort");
  });
});

describe("Ausgabe ohne guestIds, Wartung, Turnstile-Warnung", () => {
  const guest = "0d9c2b7e-1f0a-4c3b-9d2e-5a6b7c8d9e0f";

  it("Ban-Ziele und Ban-Zeilen zeigen guestIds und IP-Schlüssel nur gekürzt", () => {
    const target = banTarget({ guest }, SECRET);
    expect(target.label).toBe("Gast 0d9c2b7e…");
    expect(target.label).not.toContain(guest);
    const line = describeBanLine({
      _id: "b1",
      kind: "guest",
      value: guest,
      reason: "Flut",
      createdAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(line).toContain("0d9c2b7e…");
    expect(line).not.toContain(guest);
    expect(line).toContain("dauerhaft");
    expect(shortId("kurz")).toBe("kurz");
  });

  it("banTargetKind: genau ein Ziel; --lobby nur mit --name", () => {
    expect(banTargetKind({ guest })).toBe("guest");
    expect(banTargetKind({ ip: "203.0.113.7" })).toBe("ip");
    expect(banTargetKind({ lobby: "abc-234", name: "Mia" })).toBe("lobby");
    expect(banTargetKind({ report: "r1" })).toBe("report");
    expect(() => banTargetKind({})).toThrow(/genau ein Ziel/);
    expect(() => banTargetKind({ guest, report: "r1" })).toThrow(/genau ein Ziel/);
    expect(() => banTargetKind({ lobby: "ABC234" })).toThrow(/--name/);
    expect(() => banTargetKind({ name: "Mia" })).toThrow(/--lobby/);
  });

  it('maintenance on "<text>" / off → Patch, den das Repository akzeptiert; Text höchstens 200 Zeichen', () => {
    const on = maintenancePatch("on", ["Kurze", "Wartung"]);
    expect(on).toEqual({ maintenance: { enabled: true, message: "Kurze Wartung" } });
    expect(appConfigPatchSchema.safeParse(on).success).toBe(true);
    expect(maintenancePatch("on", [])).toEqual({ maintenance: { enabled: true, message: null } });
    expect(maintenancePatch("off", [])).toEqual({ maintenance: { enabled: false, message: null } });
    expect(() => maintenancePatch("off", ["x"])).toThrow(/keinen Text/);
    expect(() => maintenancePatch("an", [])).toThrow(/on .*off/);
    expect(() => maintenancePatch("on", ["x".repeat(201)])).toThrow(/200 Zeichen/);
    expect(() => parseConfigAssignments(["maintenance=on", `maintenanceMessage=${"y".repeat(201)}`])).toThrow(
      /200 Zeichen/,
    );
  });

  it("turnstileOnJoin ohne Turnstile-Schlüssel in der Env → Warnung (ohne Werte)", () => {
    expect(turnstileWarning({ turnstileOnJoin: true }, {})).toMatch(/TURNSTILE_SITE_KEY/);
    expect(
      turnstileWarning({ turnstileOnJoin: true }, { TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "k" }),
    ).toBeNull();
    expect(turnstileWarning({ turnstileOnJoin: false }, {})).toBeNull();
    expect(turnstileWarning({ lobbyCreationEnabled: false }, {})).toBeNull();
  });

  it("Blockliste auflisten (sortiert) bzw. Hinweis bei leerer Liste", () => {
    expect(describeBlockedTerms(["zonk", "Affe"])).toEqual(["Affe", "zonk"]);
    expect(describeBlockedTerms([])).toEqual(["(keine Begriffe)"]);
  });
});

describe("Gast finden (Lobby-Snapshot, Meldung) – Test-DB", () => {
  let t: TestDatabase;
  const host = "11111111-1111-4111-8111-111111111111";
  const mia = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    t = await createTestDatabase({ ensureIndexes: true });
    const now = new Date();
    const player = (playerId: string, guestId: string, name: string, isBot = false) => ({
      playerId,
      guestId,
      name,
      color: "blue" as const,
      isBot,
      joinedAt: now,
      status: "active" as const,
      score: 0,
    });
    const lobby = (id: string, active: boolean, updatedAt: Date, players: ReturnType<typeof player>[]) => ({
      _id: id,
      code: "ABC234",
      active,
      phase: "lobby" as const,
      rev: 1,
      settings: { ...DEFAULT_LOBBY_SETTINGS, rounds: 3, questionsPerCategory: 3, maxPlayers: 8 },
      createdByGuestId: host,
      hostPlayerId: "p0",
      players,
      bannedGuestIds: [],
      game: null,
      createdAt: now,
      updatedAt,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    await t.collections.lobbies.insertMany([
      lobby("alt", false, new Date(now.getTime() - 60_000), [player("p0", host, "Alt")]),
      lobby("neu", true, now, [
        player("p0", host, "Rolf"),
        player("p1", mia, "Mia"),
        player("p2", "bot:1", "Bot 1", true),
      ]),
    ]);
    await t.collections.questionReports.insertOne({
      _id: "report-1",
      questionId: "co-purge001",
      reason: "falsch",
      guestId: mia,
      lobbyCode: "ABC234",
      status: "open",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it("--lobby <code> --name <name>: aktive Lobby zuerst, Name auch ohne Groß-/Kleinschreibung, Ausgabe gekürzt", async () => {
    const target = await findGuestInLobby(t.collections, "abc-234", "mia");
    expect(target).toMatchObject({ kind: "guest", value: mia });
    expect(target.label).toBe("Gast „Mia“ aus Lobby ABC 234 (22222222…)");
    expect(target.label).not.toContain(mia);
    await expect(findGuestInLobby(t.collections, "ABC234", "Alt")).rejects.toThrow(/vorhanden: „Rolf“, „Mia“/);
    await expect(findGuestInLobby(t.collections, "ABC234", "Bot 1")).rejects.toThrow(/Dev-Bot/);
    await expect(findGuestInLobby(t.collections, "ZZZ999", "Mia")).rejects.toThrow(/nicht gefunden/);
    await expect(findGuestInLobby(t.collections, "kein code!", "Mia")).rejects.toThrow(/ungültiger Lobby-Code/);
    await expect(findGuestInLobby(t.collections, "ABC234", "")).rejects.toThrow(/1–64/);
  });

  it("--report <id>: Gast der Meldung; unbekannte oder ungültige IDs → klare Meldung", async () => {
    const target = await resolveBanTarget({ report: "report-1" }, SECRET, t.collections);
    expect(target).toMatchObject({ kind: "guest", value: mia });
    expect(target.label).not.toContain(mia);
    await expect(findGuestOfReport(t.collections, "fehlt")).rejects.toThrow(/nicht gefunden/);
    await expect(findGuestOfReport(t.collections, "$where")).rejects.toThrow(/ungültige Meldungs-ID/);
    expect(await resolveBanTarget({ lobby: "ABC234", name: "Rolf" }, SECRET, t.collections)).toMatchObject({
      value: host,
    });
  });
});

describe("admin:game purge – handgebaute Spiele (Test-DB)", () => {
  let t: TestDatabase;
  const a = "33333333-3333-4333-8333-333333333333";
  const b = "44444444-4444-4444-8444-444444444444";
  const c = "55555555-5555-4555-8555-555555555555";
  const now = new Date("2026-10-01T10:00:00Z");

  const question = (
    id: string,
    stats: { shown: number; correct: number; likes: number; dislikes: number; reports: number },
  ) => ({
    _id: id,
    category: "comics",
    topic: "grundlagen",
    difficulty: 2 as const,
    prompt: `Testfrage ${id}?`,
    answers: ["Richtig", "Falsch A", "Falsch B", "Falsch C"] as [string, string, string, string],
    displayOrder: "shuffle" as const,
    explanation: null,
    media: null,
    volatile: false,
    asOf: null,
    source: null,
    status: "unverified" as const,
    autoRetired: null,
    lang: "de" as const,
    contentHash: "0".repeat(64),
    version: 1,
    stats,
    createdAt: now,
    updatedAt: now,
  });

  /** Spiel mit Mensch a (immer richtig), Mensch b (falsch) und einem Bot; 2 Fragen. */
  const game = (id: string, lobbyId: string, code: string, humans: Array<[string, string]>) => ({
    _id: id,
    lobbyId,
    code,
    startedAt: now,
    endedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    settings: { ...DEFAULT_LOBBY_SETTINGS, rounds: 1, questionsPerCategory: 2, maxPlayers: 8 },
    outcome: "win" as const,
    players: [
      ...humans.map(([playerId, guestId], index) => ({
        playerId,
        guestId,
        name: `P${index}`,
        color: "blue" as const,
        isBot: false,
        place: index + 1,
        score: index === 0 ? 2 : 0,
        status: "active" as const,
      })),
      {
        playerId: "bot",
        guestId: "bot:x",
        name: "Bot",
        color: "sky" as const,
        isBot: true,
        place: 2,
        score: 0,
        status: "active" as const,
      },
    ],
    turns: [
      {
        round: 1,
        pickerId: humans[0]?.[0] ?? "p",
        offered: ["comics", "sport", "musik"] as [string, string, string],
        categoryId: "comics",
        pickedBy: "player" as const,
        questions: ["co-purge001", "co-purge002"].map((questionId) => ({
          questionId,
          shownOrder: [0, 1, 2, 3] as [0, 1, 2, 3],
          answers: [
            ...humans.map(([playerId], index) => ({ playerId, choice: 0 as const, ms: 1_000, correct: index === 0 })),
            { playerId: "bot", choice: 1 as const, ms: 900, correct: true },
          ],
        })),
      },
    ],
  });

  beforeAll(async () => {
    t = await createTestDatabase({ ensureIndexes: true });
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it("nur Menschen, nie unter 0, Gäste mit weiteren Spielen unangetastet, laufende Lobbys übersprungen, idempotent", async () => {
    await t.collections.questions.insertMany([
      question("co-purge001", { shown: 5, correct: 3, likes: 1, dislikes: 1, reports: 1 }),
      question("co-purge002", { shown: 1, correct: 0, likes: 0, dislikes: 0, reports: 0 }),
    ]);
    const guestDoc = (id: string, games: number) => ({
      _id: id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      stats: { games, wins: 1, draws: 0, answers: 2 * games, correct: 2 },
      recentQuestionIds: ["co-purge009", "co-purge001", "co-purge002"],
    });
    await t.collections.guests.insertMany([guestDoc(a, 1), guestDoc(b, 2)]);
    await t.collections.games.insertMany([
      game("g-purge", "l-closed", "ABC234", [
        ["pa", a],
        ["pb", b],
      ]),
      game("g-other", "l-other", "XYZ789", [["pb2", b]]),
      game("g-running", "l-running", "ABC234", [["pc", c]]),
    ]);
    const lobbyDoc = (id: string, active: boolean) => ({
      _id: id,
      code: "ABC234",
      active,
      phase: "game_over" as const,
      rev: 9,
      settings: { ...DEFAULT_LOBBY_SETTINGS, rounds: 1, questionsPerCategory: 2, maxPlayers: 8 },
      createdByGuestId: a,
      hostPlayerId: "pa",
      players: [],
      bannedGuestIds: [],
      game: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    await t.collections.lobbies.insertMany([lobbyDoc("l-closed", false), lobbyDoc("l-running", true)]);
    await t.collections.questionRatings.insertMany([
      { _id: `co-purge001:${a}`, questionId: "co-purge001", value: 1, updatedAt: now, expiresAt: now },
      { _id: `co-purge001:${c}`, questionId: "co-purge001", value: -1, updatedAt: now, expiresAt: now },
    ]);
    await t.collections.questionReports.insertMany([
      {
        _id: "rep-a",
        questionId: "co-purge002",
        reason: "falsch",
        guestId: a,
        lobbyCode: "ABC234",
        status: "open",
        createdAt: now,
        expiresAt: now,
      },
      {
        _id: "rep-other",
        questionId: "co-purge001",
        reason: "veraltet",
        guestId: "66666666-6666-4666-8666-666666666666",
        lobbyCode: null,
        status: "open",
        createdAt: now,
        expiresAt: now,
      },
    ]);
    const client = t.client;

    const preview = await purgeGamesByCode(client, t.collections, "abc 234", { dryRun: true });
    expect(preview).toEqual({
      code: "ABC234",
      games: 1,
      skippedGames: 1,
      lobbies: 1,
      questions: 2,
      shown: 4,
      correct: 2,
      ratings: 1,
      reports: 1,
      guests: { participants: 2, rolledBack: 1, otherGames: 1, missing: 0 },
      since: null,
      // Je Spiel nur Zeitpunkte und Besetzung (Menschen/Bots) – ohne Namen und guestIds.
      gameList: [{ startedAt: now, endedAt: now, players: 2, bots: 1 }],
    });
    expect(await t.collections.games.countDocuments({})).toBe(3);
    // --since nach dem Spielende: nichts zu tun (ältere Spiele mit wiederverwendetem Code bleiben).
    expect(
      await purgeGamesByCode(client, t.collections, "ABC234", { dryRun: true, since: new Date(now.getTime() + 1) }),
    ).toMatchObject({ games: 0, skippedGames: 0, gameList: [] });

    expect(await purgeGamesByCode(client, t.collections, "ABC234", { dryRun: false })).toEqual(preview);
    expect((await t.collections.games.find({}).toArray()).map((doc) => doc._id).sort()).toEqual([
      "g-other",
      "g-running",
    ]);
    expect((await t.collections.lobbies.find({}).toArray()).map((doc) => doc._id)).toEqual(["l-running"]);
    const stats = new Map(
      (await t.collections.questions.find({}).toArray()).map((doc) => [doc._id, doc.stats] as const),
    );
    // shown/correct je Frage: 2 Menschen, a richtig; Bot zählt nicht. Bewertung von a (+1) und Meldung von a weg.
    expect(stats.get("co-purge001")).toEqual({ shown: 3, correct: 2, likes: 0, dislikes: 1, reports: 1 });
    expect(stats.get("co-purge002")).toEqual({ shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 });
    expect(await t.collections.questionRatings.countDocuments({})).toBe(1);
    expect((await t.collections.questionReports.find({}).toArray()).map((doc) => doc._id)).toEqual(["rep-other"]);
    const guestA = await t.collections.guests.findOne({ _id: a });
    expect(guestA?.stats).toEqual({ games: 0, wins: 0, draws: 0, answers: 0, correct: 0 });
    expect(guestA?.recentQuestionIds).toEqual(["co-purge009"]);
    const guestB = await t.collections.guests.findOne({ _id: b });
    expect(guestB?.stats).toEqual({ games: 2, wins: 1, draws: 0, answers: 4, correct: 2 });

    expect(await purgeGamesByCode(client, t.collections, "ABC234", { dryRun: false })).toMatchObject({
      games: 0,
      skippedGames: 1,
    });
    await expect(purgeGamesByCode(client, t.collections, "nicht gültig!", { dryRun: true })).rejects.toThrow(
      /ungültiger Lobby-Code/,
    );
    const text = describePurge(preview, true).join("\n");
    for (const secret of [a, b, c]) expect(text.includes(secret)).toBe(false);
  });
});

describe("admin.ts (CLI) – neue Befehle", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-admin-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, "prod.env");
  writeFileSync(
    env,
    [
      "MONGODB_URI=mongodb://user:geheimes-passwort@127.0.0.1:1/?tls=true",
      "MONGODB_DB=quizmaster",
      `SESSION_SECRET=${"a".repeat(40)}`,
      `REALTIME_TICKET_SECRET=${"b".repeat(40)}`,
      `IP_HASH_SECRET=${"c".repeat(40)}`,
      `METRICS_TOKEN=${"d".repeat(40)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const cli = (...args: string[]) =>
    new Promise<{ code: number; output: string }>((done) => {
      execFile(
        process.execPath,
        [resolve(import.meta.dirname, "..", "admin.ts"), ...args, "--env-file", env],
        { timeout: 30_000 },
        (error, stdout, stderr) =>
          done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: stdout + stderr }),
      );
    });

  it("prüft Argumente vor jeder Verbindung: Purge ohne Code/Bestätigung, mehrdeutige Ziele, Wartung", async () => {
    const results = await Promise.all([
      cli("game", "purge"),
      cli("game", "purge", "--code", "ABC234"),
      cli("ban", "add", "--lobby", "ABC234", "--reason", "x", "--confirm-prod"),
      cli("ban", "check", "--guest", "0d9c2b7e-1f0a-4c3b-9d2e-5a6b7c8d9e0f", "--report", "r1"),
      cli("config", "maintenance", "an"),
      cli("config", "maintenance", "on", "Wartung"),
      cli("game", "drop", "--code", "ABC234"),
      cli("game", "purge", "--code", "ABC234", "--since", "gestern", "--dry-run"),
    ]);
    const [noCode, unconfirmed, lobbyNoName, twoTargets, badMode, maintenanceUnconfirmed, unknown, badSince] = results;
    expect(badSince?.output).toContain("--since erwartet ein ISO-Datum");
    expect(noCode?.output).toContain("--code <CODE> fehlt");
    expect(unconfirmed?.output).toContain("nur mit --confirm-prod");
    expect(lobbyNoName?.output).toContain("--lobby braucht --name");
    expect(twoTargets?.output).toContain("genau ein Ziel");
    expect(badMode?.output).toContain("maintenance erwartet");
    expect(maintenanceUnconfirmed?.output).toContain("nur mit --confirm-prod");
    expect(unknown?.output).toContain("Aufruf:");
    for (const result of results) {
      expect(result.code).toBe(2);
      expect(result.output).not.toContain("geheimes-passwort");
    }
  });
});
