import { randomUUID } from "node:crypto";
import type { LobbyDoc } from "@quizmaster/shared/documents";
import { RECENT_QUESTION_IDS_MAX } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleQuestion } from "../test-support.ts";
import { createTestDatabase, type TestDatabase } from "../testing/index.ts";
import { activeLobbyExpiresAt, createRepositories, playableStatuses, type Repositories, ratingDelta } from "./index.ts";

let t: TestDatabase;
let repos: Repositories;
const now = new Date("2026-09-30T18:00:00Z");

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  repos = createRepositories(t.client, t.collections);
});

afterAll(async () => {
  await t?.cleanup();
});

function lobby(overrides: Partial<LobbyDoc> = {}): LobbyDoc {
  const guestId = randomUUID();
  return {
    _id: `lobby_${randomUUID().slice(0, 8)}`,
    code: "ABC234",
    active: true,
    phase: "lobby",
    rev: 1,
    settings: { rounds: 3, questionsPerCategory: 3, maxPlayers: 8 },
    createdByGuestId: guestId,
    hostPlayerId: "p1",
    players: [
      {
        playerId: "p1",
        guestId,
        name: "Mia",
        color: "blue",
        isBot: false,
        joinedAt: now,
        status: "active",
        score: 0,
      },
    ],
    bannedGuestIds: [],
    game: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: activeLobbyExpiresAt(now),
    ...overrides,
  };
}

const qid = (n: number) => `rw-${String(n).padStart(8, "0")}`;

describe("guests", () => {
  it("legt Gäste an, erneuert die TTL und merkt sich höchstens 1.000 gesehene Fragen", async () => {
    const guestId = randomUUID();
    const created = await repos.guests.create(guestId, now, "Mia");
    expect(created.expiresAt.getTime() - now.getTime()).toBe(180 * 24 * 60 * 60 * 1_000);
    const later = new Date(now.getTime() + 60_000);
    expect(await repos.guests.touch(guestId, later, "Mia 2")).toBe(true);
    expect(await repos.guests.touch(randomUUID(), later)).toBe(false);
    const profile = await repos.guests.findProfile(guestId);
    expect(profile?.lastName).toBe("Mia 2");
    expect(profile).not.toHaveProperty("recentQuestionIds");

    const ids = Array.from({ length: 700 }, (_, index) => qid(index));
    const stats = { games: 1, wins: 1, draws: 0, answers: 9, correct: 7 };
    await repos.guests.recordGameResult({ guestId, questionIds: ids.slice(0, 400), stats }, later);
    await repos.guests.recordGameResult({ guestId, questionIds: ids.slice(0, 700), stats }, later);
    const recent = (await repos.guests.loadRecentQuestionIds([guestId, randomUUID()])).get(guestId) ?? [];
    expect(recent).toHaveLength(RECENT_QUESTION_IDS_MAX);
    expect(recent.at(-1)).toBe(qid(699));
    const doc = await t.collections.guests.findOne({ _id: guestId });
    expect(doc?.stats).toEqual({ games: 2, wins: 2, draws: 0, answers: 18, correct: 14 });
  });

  it("verweigert Operator-Objekte statt IDs (Injection)", async () => {
    await expect(repos.guests.findProfile({ $ne: null } as unknown as string)).rejects.toThrow();
    await expect(repos.guests.loadRecentQuestionIds(["nicht-uuid"])).rejects.toThrow();
  });
});

describe("lobbies", () => {
  it("Codes sind nur unter aktiven Lobbys eindeutig", async () => {
    const first = lobby({ code: "QWE234" });
    expect(await repos.lobbies.insert(first)).toEqual({ ok: true });
    expect(await repos.lobbies.insert(lobby({ code: "QWE234" }))).toEqual({ ok: false, reason: "code_taken" });
    expect(await repos.lobbies.isCodeTaken("QWE234")).toBe(true);
    expect((await repos.lobbies.findActiveByCode("QWE234"))?._id).toBe(first._id);
    expect(await repos.lobbies.close(first._id, now)).toBe(true);
    expect(await repos.lobbies.isCodeTaken("QWE234")).toBe(false);
    expect(await repos.lobbies.insert(lobby({ code: "QWE234" }))).toEqual({ ok: true });
  });

  it("Snapshots überschreiben nie einen neueren rev", async () => {
    const doc = lobby({ code: "ZXC345", rev: 5 });
    expect(await repos.lobbies.save(doc)).toBe("saved");
    expect(await repos.lobbies.save({ ...doc, rev: 7, phase: "intro" })).toBe("saved");
    expect(await repos.lobbies.save({ ...doc, rev: 6, phase: "lobby" })).toBe("stale");
    expect((await repos.lobbies.findById(doc._id))?.phase).toBe("intro");
    expect(await repos.lobbies.countActiveHostedBy(doc.createdByGuestId)).toBe(1);
    expect((await repos.lobbies.listActive()).map((l) => l._id)).toContain(doc._id);
  });
});

describe("questions", () => {
  beforeAll(async () => {
    await t.collections.questions.insertMany([
      sampleQuestion("co-pool0001", { difficulty: 1 }),
      sampleQuestion("co-pool0002", { status: "approved", source: "https://example.org", difficulty: 3 }),
      sampleQuestion("co-pool0003", { status: "retired" }),
    ]);
  });

  it("lädt den Pool mit schmaler Projektion je QUESTION_POOL", async () => {
    const all = await repos.questions.loadPool("all");
    expect(all.map((q) => q._id).sort()).toEqual(["co-pool0001", "co-pool0002"]);
    expect(Object.keys(all[0] ?? {}).sort()).toEqual(["_id", "category", "difficulty", "topic"]);
    expect((await repos.questions.loadPool("approved")).map((q) => q._id)).toEqual(["co-pool0002"]);
    expect(playableStatuses("all")).toEqual(["unverified", "approved"]);
  });

  it("lädt gezogene Fragen per $in ohne Statistik und zählt Statistik per bulkWrite", async () => {
    const found = await repos.questions.findForPlay(["co-pool0001", "co-pool0002", "co-pool0001", "co-missing1"]);
    expect(found).toHaveLength(2);
    expect(found[0]).not.toHaveProperty("stats");
    expect(found[0]).not.toHaveProperty("contentHash");
    const modified = await repos.questions.incrementStats([
      { questionId: "co-pool0001", shown: 2, correct: 1 },
      { questionId: "co-pool0001", shown: 1, correct: 1 },
      { questionId: "co-pool0002", shown: 1, correct: 0 },
    ]);
    expect(modified).toBe(2);
    expect((await repos.questions.findById("co-pool0001"))?.stats).toMatchObject({ shown: 3, correct: 2 });
  });

  it("Schutzautomatik nimmt Fragen sofort aus dem Pool", async () => {
    const at = new Date(now.getTime() + 1_000);
    expect(await repos.questions.autoRetire("co-pool0001", "reports", at)).toBe(true);
    expect(await repos.questions.autoRetire("co-pool0001", "reports", at)).toBe(false);
    const doc = await repos.questions.findById("co-pool0001");
    expect(doc?.status).toBe("retired");
    expect(doc?.autoRetired).toEqual({ reason: "reports", at });
    const changed = await repos.questions.findChangedSince(now);
    expect(changed.map((q) => q._id)).toContain("co-pool0001");
  });
});

describe("questionReports + questionRatings", () => {
  it("zählt verschiedene meldende Gäste im Zeitfenster und liefert die Prüf-Queue", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await repos.reports.create({ questionId: "co-pool0002", reason: "falsch", guestId: a, lobbyCode: "ABC234" }, now);
    await repos.reports.create({ questionId: "co-pool0002", reason: "veraltet", guestId: a, lobbyCode: null }, now);
    await repos.reports.create({ questionId: "co-pool0002", reason: "tippfehler", guestId: b, lobbyCode: null }, now);
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
    expect(await repos.reports.countDistinctReporters("co-pool0002", since)).toBe(1);
    expect(await repos.reports.countDistinctReporters("co-pool0002", since, ["tippfehler", "falsch"])).toBe(2);
    const open = await repos.reports.listOpen(10);
    expect(open).toHaveLength(3);
    expect(await repos.reports.setStatus(open[0]?._id ?? "", "resolved")).toBe(true);
    expect(await repos.reports.listOpen(10)).toHaveLength(2);
    expect(await repos.reports.findReportedQuestionIds(a, ["co-pool0002", "co-pool0001"])).toEqual(
      new Set(["co-pool0002"]),
    );
  });

  it("eine Bewertung je Gast und Frage, Zähler folgen Änderungen", async () => {
    const guest = randomUUID();
    expect(ratingDelta(null, 1)).toEqual({ likes: 1, dislikes: 0 });
    expect(ratingDelta(1, -1)).toEqual({ likes: -1, dislikes: 1 });
    expect((await repos.ratings.rate("co-pool0002", guest, 1, now)).previous).toBeNull();
    expect((await repos.ratings.rate("co-pool0002", guest, -1, now)).previous).toBe(1);
    await repos.ratings.rate("co-pool0002", randomUUID(), -1, now);
    expect(await repos.ratings.summary("co-pool0002")).toEqual({ likes: 0, dislikes: 2 });
    expect((await repos.questions.findById("co-pool0002"))?.stats).toMatchObject({ likes: 0, dislikes: 2 });
    expect((await repos.ratings.findByGuest(guest, ["co-pool0002"])).get("co-pool0002")).toBe(-1);
  });
});

describe("bans", () => {
  it("Upsert je kind+value, Ablauf wird geprüft, dauerhaft ohne expiresAt", async () => {
    const guestId = randomUUID();
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    const ban = await repos.bans.upsert({ kind: "guest", value: guestId, reason: "Verstöße", expiresAt }, now);
    expect(ban.expiresAt).toEqual(expiresAt);
    expect(await repos.bans.findActive("guest", guestId, now)).not.toBeNull();
    expect(await repos.bans.findActive("guest", guestId, new Date(expiresAt.getTime() + 1))).toBeNull();
    const permanent = await repos.bans.upsert({ kind: "guest", value: guestId, reason: "dauerhaft" }, now);
    expect(permanent._id).toBe(ban._id);
    expect(permanent).not.toHaveProperty("expiresAt");
    expect(await t.collections.bans.countDocuments({ value: guestId })).toBe(1);
    expect((await repos.bans.findActiveFor({ ipKey: "ffff", guestId }, now))?.reason).toBe("dauerhaft");
    expect(await repos.bans.findActiveFor({}, now)).toBeNull();
    expect(await repos.bans.remove("guest", guestId)).toBe(true);
    expect(await repos.bans.findActiveFor({ guestId }, now)).toBeNull();
  });
});

describe("appConfig + categories", () => {
  it("liest Startwerte, ändert nur explizite Felder und setzt den Katalog", async () => {
    const initial = await repos.appConfig.get();
    expect(initial.maintenance.enabled).toBe(false);
    const updated = await repos.appConfig.update(
      { lobbyCreationEnabled: false, blockedTerms: ["beispielwort"] },
      new Date(now.getTime() + 5_000),
    );
    expect(updated.lobbyCreationEnabled).toBe(false);
    expect(updated.turnstileOnJoin).toBe(false);
    expect(updated.blockedTerms).toEqual(["beispielwort"]);
    await expect(repos.appConfig.update({}, now)).rejects.toThrow();
    await expect(
      repos.appConfig.update({ ["$where" as "turnstileOnJoin"]: true } as unknown as { turnstileOnJoin: boolean }, now),
    ).rejects.toThrow();
    await repos.appConfig.setCatalog(
      { minPlayable: 3, difficultyMix: { "1": 0.2, "2": 0.3, "3": 0.25, "4": 0.15, "5": 0.1 } },
      now,
    );
    expect((await repos.appConfig.get()).catalog.minPlayable).toBe(3);
  });

  it("listet spielbare Kategorien nach order und setzt Zähler", async () => {
    const base = {
      icon: "book-open",
      color: "#EBB447",
      description: "d",
      scope: "s",
      notScope: "n",
      active: true,
      playableCount: 0,
      approvedCount: 0,
      topics: [],
      updatedAt: now,
    };
    await t.collections.categories.insertMany([
      { ...base, _id: "comics", name: "Comics", order: 2, playable: true },
      { ...base, _id: "buecher-woerter", name: "Bücher & Wörter", order: 1, playable: true },
      { ...base, _id: "kinofilme", name: "Kinofilme", order: 3, playable: false },
    ]);
    expect((await repos.categories.listPlayable()).map((c) => c._id)).toEqual(["buecher-woerter", "comics"]);
    expect(
      await repos.categories.updateCounts("kinofilme", { playableCount: 150, approvedCount: 0, playable: true }, now),
    ).toBe(true);
    expect((await repos.categories.listPlayable()).map((c) => c._id)).toEqual([
      "buecher-woerter",
      "comics",
      "kinofilme",
    ]);
    expect((await repos.categories.listAll()).map((c) => c.order)).toEqual([1, 2, 3]);
  });
});
