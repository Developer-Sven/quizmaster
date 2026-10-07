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
import { Writable } from "node:stream";
import type { Repositories } from "@quizmaster/db";
import { createSeededRng, type TurnRef } from "@quizmaster/game-engine";
import { defaultAppConfig, type QuestionDoc } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger, createSilentLogger } from "../../src/logger.ts";
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

/** Logger, der die JSON-Zeilen mitschreibt (Stufe 50 = error, 30 = info). */
function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: createLogger({ level: "debug", destination }), lines };
}

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
      const aborted = await metricValue(server.app.services.metrics, "qm_games_aborted_total", {
        reason: "load_failed",
      });
      const host = await connectGuest(server, { guestDoc: true });
      const code = await createLobby(host, "Mia");
      const guest = await connectGuest(server, { guestDoc: true });
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
      // Technischer Abbruch: zählt nicht als Spiel/Unentschieden in der Gast-Statistik, aber in der Metrik.
      expect(await metricValue(server.app.services.metrics, "qm_games_aborted_total", { reason: "load_failed" })).toBe(
        aborted + 1,
      );
      // games-Dokument und Gast-Statistik entstehen in derselben Transaktion.
      for (const client of [host, guest]) {
        const profile = await server.db.repos.guests.findProfile(client.guestId);
        expect(profile?.stats).toEqual({ games: 0, wins: 0, draws: 0, answers: 0, correct: 0 });
      }
      host.close();
      guest.close();
    } finally {
      await categories.updateMany({}, { $set: { playable: true } });
      await eventually(() => service.playableCategories().length === 19);
    }
  });

  it("invalidierter Stream (Collection gelöscht) → Vollreload + Neustart-Metrik; leerer Stand ersetzt den Pool nicht", async () => {
    const runtime = runtimeOf(server);
    const { reloads, questions } = runtime.questions.stats();
    expect(questions).toBeGreaterThan(0);
    await server.db.collections.questions.drop();
    await eventually(() => runtime.questions.stats().reloads > reloads, 20_000);
    // Der unbrauchbare (leere) Stand wird abgelehnt und geloggt; gelöschte Fragen fallen beim Laden heraus.
    expect(runtime.questions.stats().rejectedReloads).toBeGreaterThanOrEqual(1);
    expect(runtime.questions.stats().questions).toBe(questions);
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

  interface SetupOptions {
    pool: () => Promise<PoolRow[]>;
    docs?: Map<string, PlayDoc>;
    categories?: string[] | (() => string[]);
    /** Ersetzt das Laden einzelner Volldokumente (Standard: aus `docs`) – der Spielbetrieb braucht es nicht mehr. */
    findForPlay?: (ids: readonly string[]) => Promise<PlayDoc[]>;
    metrics?: ReturnType<typeof createMetrics>;
    logger?: QuestionServiceDeps["logger"];
    requireUsableCatalog?: boolean;
  }

  function setup(options: SetupOptions) {
    const categoryIds = () =>
      typeof options.categories === "function"
        ? options.categories()
        : (options.categories ?? ["comics", "im-labor", "kinofilme", "tv-serien"]);
    const fromDocs = (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const doc = options.docs?.get(id);
        return doc === undefined ? [] : [doc];
      });
    // Wie die Datenbank: nur spielbare Fragen, mit Spielinhalt (Dokument aus `docs` oder ein erzeugtes).
    const playPool = async () =>
      (await options.pool())
        .map((row) => options.docs?.get(row._id) ?? questionDoc(row._id, row.category, row.difficulty))
        .filter((doc) => doc.status === "unverified" || doc.status === "approved");
    const repos = {
      questions: {
        loadPool: () => options.pool(),
        loadPlayPool: playPool,
        findForPlay: async (ids: readonly string[]) =>
          options.findForPlay === undefined ? fromDocs(ids) : options.findForPlay(ids),
      },
      categories: {
        listPlayable: async () =>
          categoryIds().map((id, index) => ({
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
      logger: options.logger ?? createSilentLogger(),
      metrics: options.metrics ?? createMetrics({ socketCount: () => 0 }),
      watch: false,
      ...(options.requireUsableCatalog === undefined ? {} : { requireUsableCatalog: options.requireUsableCatalog }),
    };
    return createQuestionService(deps);
  }

  /** ID-Kürzel der Test-Kategorien (QUESTION_ID_REGEX). */
  const PREFIX: Record<string, string> = { comics: "co", "im-labor": "il", kinofilme: "kf", "tv-serien": "tv" };

  /** Pool mit `perCategory` Fragen je Kategorie (IDs „<kürzel>-bbbbbbb<n>“). */
  function poolRows(categories: readonly string[], perCategory = 3): PoolRow[] {
    return categories.flatMap((category) =>
      Array.from({ length: perCategory }, (_unused, index) => ({
        _id: `${PREFIX[category] ?? "zz"}-bbbbbbb${index + 1}`,
        category,
        topic: "grundlagen",
        difficulty: ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5,
      })),
    );
  }

  function docsFor(rows: readonly PoolRow[]): Map<string, PlayDoc> {
    return new Map(rows.map((row) => [row._id, questionDoc(row._id, row.category, row.difficulty)]));
  }

  const FOUR = ["comics", "im-labor", "kinofilme", "tv-serien"];

  const turn = (questionsPerTurn: number): TurnRef => ({
    gameId: "g1",
    round: 1,
    turnNumber: 1,
    pickerId: "p1",
    questionsPerTurn,
    playedCategoryIds: [],
    usedQuestionIds: [],
    categoryIds: null,
    difficulty: { min: 1, max: 5 },
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

  it("loadQuestions hält den Schwierigkeitsbereich des Zuges ein (ADR-055)", async () => {
    const rows = poolRows(["comics"], 20);
    const service = setup({ pool: async () => rows, docs: docsFor(rows) });
    await service.reload("test");
    const loaded = await service.loadQuestions({
      categoryId: "comics",
      count: 4,
      excludeQuestionIds: [],
      seen: new Map(),
      difficulty: { min: 2, max: 3, basis: "question", order: "ascending", turnNumber: 1, turns: 1 },
    });
    expect(loaded.questions.map((question) => question.difficulty)).toEqual([2, 2, 3, 3]);
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

  it("loadQuestions braucht keine Datenbank: die Fragen liegen im Speicher (ADR-057)", async () => {
    const rows = poolRows(FOUR);
    let calls = 0;
    const service = setup({
      pool: async () => rows,
      docs: docsFor(rows),
      // Netzaussetzer: jeder Datenbank-Abruf schlägt fehl – ein Zugwechsel darf davon nichts merken.
      findForPlay: async () => {
        calls += 1;
        throw new Error("Datenbank weg");
      },
    });
    await service.reload("test");
    const started = Date.now();
    const loaded = await service.loadQuestions({
      categoryId: "comics",
      count: 3,
      excludeQuestionIds: [],
      seen: new Map(),
    });
    expect(loaded.questions).toHaveLength(3);
    expect(loaded.questions.every((question) => question.category === "comics")).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toBe(0);
  });

  it("Inhalte bleiben aktuell: geänderter Text aus dem Change Stream, gesperrte Frage fällt heraus (ADR-057)", async () => {
    const rows = poolRows(["comics"], 1);
    const service = setup({ pool: async () => rows, docs: docsFor(rows), categories: ["comics"] });
    await service.reload("test");
    const [row] = rows;
    if (!row) throw new Error("Fixture");
    service.syncQuestion(row._id, { ...questionDoc(row._id, "comics", row.difficulty), prompt: "Neu formuliert?" });
    const loaded = await service.loadQuestions({
      categoryId: "comics",
      count: 1,
      excludeQuestionIds: [],
      seen: new Map(),
    });
    expect(loaded.questions[0]?.prompt).toBe("Neu formuliert?");
    service.syncQuestion(row._id, questionDoc(row._id, "comics", row.difficulty, "retired"));
    expect(service.hasQuestion(row._id)).toBe(false);
    expect(
      (await service.loadQuestions({ categoryId: "comics", count: 1, excludeQuestionIds: [], seen: new Map() }))
        .questions,
    ).toEqual([]);
  });

  it("Katalog-Zustand: brauchbar erst ab vier Kategorien mit Fragen; Gauges zeigen den Stand", async () => {
    const metrics = createMetrics({ socketCount: () => 0 });
    const usable = setup({ pool: async () => poolRows(FOUR), metrics });
    await usable.start();
    expect(usable.catalog()).toEqual({ questions: 12, usableCategories: 4, usable: true });
    expect(await metricValue(metrics, "qm_catalog_questions")).toBe(12);
    expect(await metricValue(metrics, "qm_catalog_usable_categories")).toBe(4);
    expect(await metricValue(metrics, "qm_catalog_usable")).toBe(1);
    await usable.stop();
    // Drei Kategorien reichen nicht: im zweiten Zug ist die zuletzt gespielte ausgeschlossen.
    const three = setup({ pool: async () => poolRows(FOUR.slice(0, 3)) });
    await three.reload("test");
    expect(three.catalog()).toMatchObject({ usableCategories: 3, usable: false });
    // Kategorie ohne Fragen im Pool zählt nicht.
    const empty = setup({ pool: async () => [] });
    await empty.reload("test");
    expect(empty.catalog()).toEqual({ questions: 0, usableCategories: 0, usable: false });
  });

  it("unbrauchbarer Reload ersetzt einen brauchbaren Stand nicht (Fehlerlog), ein brauchbarer schon", async () => {
    let rows = poolRows(FOUR);
    const { logger, lines } = captureLogger();
    const service = setup({ pool: async () => rows, logger });
    await service.reload("start");
    expect(service.catalog().usable).toBe(true);
    rows = [];
    await service.reload("interval");
    expect(service.catalog()).toMatchObject({ questions: 12, usable: true });
    expect(service.stats()).toMatchObject({ reloads: 2, rejectedReloads: 1 });
    expect(lines.some((line) => line.level === 50 && String(line.msg).includes("unbrauchbar"))).toBe(true);
    rows = poolRows(FOUR, 2);
    await service.reload("interval");
    expect(service.catalog()).toMatchObject({ questions: 8, usable: true });
    expect(service.stats()).toMatchObject({ reloads: 3, rejectedReloads: 1 });
  });

  it("Start: unbrauchbarer Katalog wirft nur, wenn er verlangt ist (Produktion); sonst Fehlerlog", async () => {
    const strict = setup({ pool: async () => [], requireUsableCatalog: true });
    await expect(strict.start()).rejects.toThrow(/Fragenkatalog unbrauchbar/);
    const { logger, lines } = captureLogger();
    const lenient = setup({ pool: async () => [], logger });
    await lenient.start();
    expect(lenient.catalog().usable).toBe(false);
    expect(lines.some((line) => line.level === 50 && String(line.msg).includes("unbrauchbar"))).toBe(true);
    await lenient.stop();
  });

  it("Live-Änderungen, die den Katalog unbrauchbar machen, werden als Fehler geloggt (einmal je Wechsel)", async () => {
    const { logger, lines } = captureLogger();
    const service = setup({ pool: async () => poolRows(FOUR), logger });
    await service.reload("start");
    const errors = () => lines.filter((line) => line.level === 50 && String(line.msg).includes("unbrauchbar")).length;
    expect(errors()).toBe(0);
    service.removeCategory("comics");
    expect(service.catalog().usable).toBe(false);
    service.removeCategory("im-labor");
    expect(errors()).toBe(1);
    service.syncCategory("im-labor", {
      _id: "im-labor",
      name: "Im Labor",
      icon: "circle",
      color: "#3F9FF3",
      order: 2,
      playable: true,
    });
    service.syncCategory("comics", {
      _id: "comics",
      name: "Comics",
      icon: "circle",
      color: "#3F9FF3",
      order: 1,
      playable: true,
    });
    expect(service.catalog().usable).toBe(true);
    expect(lines.some((line) => line.level === 30 && String(line.msg).includes("wieder brauchbar"))).toBe(true);
  });
});
