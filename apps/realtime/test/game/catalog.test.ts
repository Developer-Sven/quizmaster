/**
 * Fragen-Service und Katalog-Watcher (docs/04 §Fragenauswahl, §Change-Stream-Watcher):
 * - Integration (echte Change Streams der Test-DB): neue, geänderte, gesperrte und gelöschte Fragen sowie
 *   Kategorie-Änderungen kommen live im Pool an; reine Statistik-Updates (Spielabschluss, Bewertungen,
 *   Zähler) werden per `$match` gar nicht erst ausgeliefert; ein invalidierter Stream führt zum Vollreload
 *   und zählt als Neustart-Metrik.
 * - Einheit (ohne Streams): Änderungen während eines Reloads gehen nicht verloren; nicht mehr spielbare
 *   Fragen werden beim Laden verworfen und nachgezogen; ohne drei Kategorien kein Angebot.
 */
import { randomInt } from "node:crypto";
import type { Repositories } from "@quizmaster/db";
import { createSeededRng, type TurnRef } from "@quizmaster/game-engine";
import { defaultAppConfig, type QuestionDoc } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../src/logger.ts";
import { createMetrics } from "../../src/metrics.ts";
import { createQuestionService, type QuestionServiceDeps } from "../../src/services/questions.ts";
import { eventually, metricValue, type TestServer } from "../helpers/index.ts";
import {
  actorOf,
  connectGuest,
  createLobby,
  joinLobby,
  runtimeOf,
  startGameServer,
  waitForGameDoc,
  waitForPhase,
} from "./support.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function newQuestionId(prefix: string): string {
  let id = `${prefix}-`;
  for (let index = 0; index < 8; index++) id += ID_CHARS[randomInt(ID_CHARS.length)];
  return id;
}

describe("Change Streams (Test-DB)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startGameServer();
  });
  afterAll(() => server?.cleanup());

  it("Fragen: Einfügen, relevante Updates, Sperren und Löschen kommen an – Statistik-Updates nicht", async () => {
    const service = runtimeOf(server).questions;
    const questions = server.db.collections.questions;
    const template = await questions.findOne({ category: "comics", status: "unverified" });
    if (template === null) throw new Error("Fixture-Frage fehlt");
    const id = newQuestionId("co");
    const now = new Date();
    await questions.insertOne({
      ...template,
      _id: id,
      stats: { shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 },
      createdAt: now,
      updatedAt: now,
    });
    await eventually(() => service.hasQuestion(id));
    const comics = service.poolSize("comics");

    const applied = service.stats().changesApplied;
    await questions.updateOne({ _id: id }, { $inc: { "stats.shown": 3, "stats.correct": 1 } });
    await questions.updateOne({ _id: id }, { $inc: { "stats.likes": 1, "stats.reports": 1 } });
    await questions.updateOne({ _id: id }, { $set: { difficulty: 5, updatedAt: new Date() } });
    // Nur das Schwierigkeits-Update wird ausgeliefert (die Statistik-Updates davor filtert der $match).
    await eventually(() => service.stats().changesApplied === applied + 1);

    await questions.updateOne({ _id: id }, { $set: { status: "retired", updatedAt: new Date() } });
    await eventually(() => !service.hasQuestion(id));
    expect(service.poolSize("comics")).toBe(comics - 1);
    expect(service.stats().changesApplied).toBe(applied + 2);

    await questions.updateOne({ _id: id }, { $set: { status: "approved", updatedAt: new Date() } });
    await eventually(() => service.hasQuestion(id));
    await questions.updateOne({ _id: id }, { $set: { category: "im-labor", updatedAt: new Date() } });
    await eventually(() => service.poolSize("comics") === comics - 1);
    expect(service.hasQuestion(id)).toBe(true);
    await questions.deleteOne({ _id: id });
    await eventually(() => !service.hasQuestion(id));
  });

  it("Kategorien: playable/Anzeigedaten kommen an, reine Zähler-Updates nicht", async () => {
    const service = runtimeOf(server).questions;
    const categories = server.db.collections.categories;
    const ids = () => service.playableCategories().map((category) => category.id);
    expect(ids()).toContain("comics");
    await categories.updateOne({ _id: "comics" }, { $set: { playable: false } });
    await eventually(() => !ids().includes("comics"));
    await categories.updateOne({ _id: "comics" }, { $set: { playable: true, name: "Comics & Manga" } });
    await eventually(
      () => service.playableCategories().find((category) => category.id === "comics")?.name === "Comics & Manga",
    );
    const applied = service.stats().changesApplied;
    await categories.updateOne({ _id: "comics" }, { $set: { playableCount: 999, approvedCount: 5 } });
    await categories.updateOne({ _id: "comics" }, { $set: { name: "Comics" } });
    await eventually(
      () => service.playableCategories().find((category) => category.id === "comics")?.name === "Comics",
    );
    expect(service.stats().changesApplied).toBe(applied + 1);
    // Anzeigereihenfolge nach `order`.
    const orders = await categories.find({ playable: true }).sort({ order: 1 }).toArray();
    expect(ids()).toEqual(orders.map((category) => category._id));
  });

  it("weniger als drei spielbare Kategorien → LOAD_FAILED: das Spiel endet sofort mit Ergebnis", async () => {
    const service = runtimeOf(server).questions;
    const categories = server.db.collections.categories;
    const keep = ["comics", "im-labor"];
    await categories.updateMany({ _id: { $nin: keep } }, { $set: { playable: false } });
    await eventually(() => service.playableCategories().length === 2);
    try {
      const host = await connectGuest(server);
      const code = await createLobby(host, "Mia");
      const guest = await connectGuest(server);
      await joinLobby(guest, code, "Ben");
      const over = waitForPhase(host, "game_over", 20_000);
      const started = Date.now();
      expect((await host.emit("lobby:start", {})).ok).toBe(true);
      const final = await over;
      // Direkt nach dem Intro (fast: 300 ms), nicht erst nach der Engine-Frist von 20 s.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(final.board).toEqual([]);
      expect(final.results?.outcome).toBe("draw");
      expect(actorOf(server, code).state.game?.endReason).toBe("load_failed");
      await waitForGameDoc(server, actorOf(server, code).lobbyId);
      host.close();
      guest.close();
    } finally {
      await categories.updateMany({}, { $set: { playable: true } });
      await eventually(() => service.playableCategories().length === 19);
    }
  });

  it("invalidierter Stream (Collection gelöscht) → Vollreload + Neustart-Metrik", async () => {
    const runtime = runtimeOf(server);
    const reloads = runtime.questions.stats().reloads;
    expect(runtime.questions.stats().questions).toBeGreaterThan(0);
    await server.db.collections.questions.drop();
    await eventually(() => runtime.questions.stats().reloads > reloads, 20_000);
    expect(runtime.questions.stats().questions).toBe(0);
    expect(
      await metricValue(server.app.services.metrics, "qm_change_stream_restarts_total", {
        stream: "questions",
        reason: "invalidated",
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});

/** Unit-Tests ohne Change Streams: kontrollierbare Repos. */
describe("Fragen-Service (ohne Change Streams)", () => {
  type PoolRow = Pick<QuestionDoc, "_id" | "category" | "topic" | "difficulty">;

  interface PlayDoc {
    _id: string;
    category: string;
    topic: string;
    difficulty: 1 | 2 | 3 | 4 | 5;
    status: string;
    prompt: string;
    answers: [string, string, string, string];
    displayOrder: "shuffle";
    explanation: string | null;
    media: null;
    source: string | null;
  }

  function questionDoc(id: string, category: string, difficulty: 1 | 2 | 3 | 4 | 5, status = "unverified"): PlayDoc {
    return {
      _id: id,
      category,
      topic: "grundlagen",
      difficulty,
      status,
      prompt: `Testfrage ${id}?`,
      answers: [`Richtig ${id}`, `Falsch A ${id}`, `Falsch B ${id}`, `Falsch C ${id}`],
      displayOrder: "shuffle",
      explanation: null,
      media: null,
      source: null,
    };
  }

  function setup(options: { pool: () => Promise<PoolRow[]>; docs?: Map<string, PlayDoc>; categories?: string[] }) {
    const categoryIds = options.categories ?? ["comics", "im-labor", "kinofilme", "tv-serien"];
    const repos = {
      questions: {
        loadPool: () => options.pool(),
        findForPlay: async (ids: readonly string[]) =>
          ids.flatMap((id) => {
            const doc = options.docs?.get(id);
            return doc === undefined ? [] : [doc];
          }),
      },
      categories: {
        listPlayable: async () =>
          categoryIds.map((id, index) => ({
            _id: id,
            name: `Kategorie ${id}`,
            icon: "circle",
            color: "#3F9FF3",
            order: index + 1,
            playable: true,
          })),
      },
    } as unknown as Pick<Repositories, "questions" | "categories">;
    const deps: QuestionServiceDeps = {
      repos,
      collections: {} as QuestionServiceDeps["collections"],
      pool: "all",
      appConfig: { get: () => defaultAppConfig(new Date()) },
      rng: createSeededRng("fragen-service"),
      clock: { now: () => Date.now() },
      logger: createSilentLogger(),
      metrics: createMetrics({ socketCount: () => 0 }),
      watch: false,
    };
    return createQuestionService(deps);
  }

  const turn = (questionsPerTurn: number): TurnRef => ({
    gameId: "g1",
    round: 1,
    turnNumber: 1,
    pickerId: "p1",
    questionsPerTurn,
    playedCategoryIds: [],
    usedQuestionIds: [],
  });

  it("Änderungen während eines Reloads werden nach dem Tausch erneut angewendet", async () => {
    let release: (rows: PoolRow[]) => void = () => undefined;
    const pending = new Promise<PoolRow[]>((resolve) => {
      release = resolve;
    });
    const service = setup({ pool: () => pending });
    const reload = service.reload("test");
    // Während des Reloads: neue Frage hinzu, eine (im Reload-Stand noch enthaltene) gesperrt.
    service.syncQuestion("co-neu00001", { ...questionDoc("co-neu00001", "comics", 2), status: "approved" });
    service.syncQuestion("co-alt00001", { ...questionDoc("co-alt00001", "comics", 1), status: "retired" });
    release([
      { _id: "co-alt00001", category: "comics", topic: "grundlagen", difficulty: 1 },
      { _id: "co-alt00002", category: "comics", topic: "grundlagen", difficulty: 3 },
    ]);
    await reload;
    expect(service.hasQuestion("co-neu00001")).toBe(true);
    expect(service.hasQuestion("co-alt00001")).toBe(false);
    expect(service.hasQuestion("co-alt00002")).toBe(true);
    expect(service.stats()).toMatchObject({ questions: 2, categories: 4, reloads: 1 });
    // Ungültige Dokumente aus dem Stream (z. B. falsche Schwierigkeit) verlassen den Pool statt ihn zu stören.
    service.syncQuestion("co-alt00002", { ...questionDoc("co-alt00002", "comics", 3), difficulty: 9 });
    expect(service.hasQuestion("co-alt00002")).toBe(false);
  });

  it("loadQuestions verwirft nicht mehr spielbare Fragen (auch aus dem Pool) und liefert Engine-Eingaben", async () => {
    const rows: PoolRow[] = [
      { _id: "co-aaaaaaa1", category: "comics", topic: "grundlagen", difficulty: 1 },
      { _id: "co-aaaaaaa2", category: "comics", topic: "grundlagen", difficulty: 2 },
      { _id: "co-aaaaaaa3", category: "comics", topic: "grundlagen", difficulty: 3 },
    ];
    const docs = new Map<string, PlayDoc>([
      ["co-aaaaaaa1", questionDoc("co-aaaaaaa1", "comics", 1)],
      ["co-aaaaaaa2", questionDoc("co-aaaaaaa2", "comics", 2, "retired")],
      ["co-aaaaaaa3", { ...questionDoc("co-aaaaaaa3", "comics", 3), source: "https://example.org/beleg" }],
    ]);
    const service = setup({ pool: async () => rows, docs });
    await service.reload("test");
    const loaded = await service.loadQuestions({
      categoryId: "comics",
      count: 3,
      excludeQuestionIds: [],
      seen: new Map(),
    });
    expect(loaded.questions.map((question) => question._id).sort()).toEqual(["co-aaaaaaa1", "co-aaaaaaa3"]);
    expect(loaded.refilledSeen).toBe(0);
    expect(service.hasQuestion("co-aaaaaaa2")).toBe(false);
    // Engine-Eingabe ohne Beleg/Statistik (die Engine verwirft sie ohnehin – hier schon vorher).
    for (const question of loaded.questions) expect(Object.keys(question)).not.toContain("source");
    const seen = new Map([["co-aaaaaaa1", 0]]);
    const refill = await service.loadQuestions({ categoryId: "comics", count: 2, excludeQuestionIds: [], seen });
    expect(refill.questions).toHaveLength(2);
    expect(refill.refilledSeen).toBe(1);
  });

  it("ohne drei spielbare Kategorien gibt es kein Angebot; sonst drei verschiedene", async () => {
    const rows: PoolRow[] = ["comics", "im-labor", "kinofilme", "tv-serien"].flatMap((category, index) =>
      [1, 2, 3].map((n) => ({
        _id: `${["co", "il", "kf", "tv"][index]}-bbbbbbb${n}`,
        category,
        topic: "grundlagen",
        difficulty: n as 1 | 2 | 3,
      })),
    );
    const service = setup({ pool: async () => rows });
    await service.reload("test");
    const offer = service.offerCategories(turn(2), new Map());
    expect(offer).not.toBeNull();
    expect(new Set(offer?.map((option) => option.id)).size).toBe(3);
    const few = setup({ pool: async () => rows, categories: ["comics", "im-labor"] });
    await few.reload("test");
    expect(few.offerCategories(turn(2), new Map())).toBeNull();
  });
});
