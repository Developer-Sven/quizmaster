/**
 * Wiederaufnahme nach Neustart (docs/07 Checkliste Phase 6: „Integrationstest: Neustart während einer Frage“):
 * Zwei App-Instanzen nacheinander auf derselben Test-DB. Instanz 1 sichert beim Stoppen die Snapshots, Instanz 2
 * übernimmt sie beim Start; die Clients kommen mit derselben guestId über `lobby:resume` zurück.
 */
import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { toLobbySnapshot } from "@quizmaster/game-engine";
import type { AnswerIndex, PublicLobbyState } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REALTIME_MODULES } from "../../src/registry/modules.ts";
import { createResumeModule, type ResumeReport } from "../../src/resume/index.ts";
import {
  autoPlay,
  createLobby,
  joinLobby,
  lastState,
  runtimeOf,
  waitForGameDoc,
  waitForPhase,
} from "../game/support.ts";
import { metricValue, startTestServer, type TestServer } from "../helpers/index.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

/** Port-Bereich dieser Suite (Wiederaufnahme nach Neustart). */
const RESUME_TEST_PORTS = { from: 4520, to: 4529 } as const;

let database: TestDatabase;
const reports: ResumeReport[] = [];
const modules = [...REALTIME_MODULES, createResumeModule({ onResumed: (report) => reports.push(report) })];

function startServer(seed: boolean): Promise<TestServer> {
  return startTestServer({ database, seed, timing: "fast", ports: RESUME_TEST_PORTS, modules });
}

beforeAll(async () => {
  database = await createTestDatabase({ ensureIndexes: true });
});

afterAll(async () => {
  await database?.cleanup();
});

function scoreOf(state: PublicLobbyState, name: string): number {
  return state.players.find((player) => player.name === name)?.score ?? -1;
}

describe("Wiederaufnahme nach Neustart", () => {
  it("setzt eine laufende Frage zurück: das Spiel läuft weiter, Punkte bleiben erhalten", async () => {
    const first = await startServer(true);
    const ids = { alice: randomUUID(), bob: randomUUID(), carol: randomUUID(), dave: randomUUID() };
    let code = "";
    let waitingCode = "";
    let questionId = "";
    let lobbyId = "";
    try {
      expect(reports.at(-1)?.found).toBe(0);
      const alice = await first.connectClient({ guestId: ids.alice });
      const bob = await first.connectClient({ guestId: ids.bob });
      code = await createLobby(alice, "Alice");
      await joinLobby(bob, code, "Bob");
      expect((await alice.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 3 })).ok).toBe(true);
      // Nur Frage 1 beantworten: Alice richtig, Bob falsch – Frage 2 bleibt beim Neustart offen.
      const onlyFirst =
        (wrong: boolean) =>
        (question: { index: number }, correct: AnswerIndex): AnswerIndex | null =>
          question.index !== 1 ? null : wrong ? (((correct + 1) % 4) as AnswerIndex) : correct;
      const players = [
        autoPlay(first, alice, code, { answer: onlyFirst(false) }),
        autoPlay(first, bob, code, { answer: onlyFirst(true) }),
      ];
      const secondQuestion = alice.waitFor(
        "lobby:state",
        (state) => state.phase === "question" && state.question?.index === 2,
      );
      expect((await alice.emit("lobby:start", {})).ok).toBe(true);
      const running = await secondQuestion;
      for (const player of players) player.stop();
      questionId = running.question?.id ?? "";
      expect(scoreOf(running, "Alice")).toBe(1);
      expect(scoreOf(running, "Bob")).toBe(0);
      lobbyId = runtimeOf(first).lobbies.get(code)?.lobbyId ?? "";

      // Zweite Lobby wartet noch auf den Start (Phase lobby).
      const carol = await first.connectClient({ guestId: ids.carol });
      const dave = await first.connectClient({ guestId: ids.dave });
      waitingCode = await createLobby(carol, "Carol");
      await joinLobby(dave, waitingCode, "Dave");
    } finally {
      // Stoppen wie bei SIGTERM: Lobbys einfrieren, Snapshots schreiben, Verbindungen schließen.
      await first.cleanup();
    }

    const stored = await database.collections.lobbies.findOne({ code, active: true });
    expect(stored?.phase).toBe("question");

    const restartAt = Date.now();
    const second = await startServer(false);
    try {
      expect(reports.at(-1)).toMatchObject({ found: 2, resumed: 2, closed: 0, failed: 0 });
      expect(reports.at(-1)?.resets).toEqual({ question_restarted: 1, none: 1 });
      expect(await metricValue(second.app.services.metrics, "qm_lobbies_resumed_total", { outcome: "resumed" })).toBe(
        2,
      );
      expect(await metricValue(second.app.services.metrics, "qm_lobbies_active")).toBe(2);

      // Alle kommen sofort zurück (GAME_TIMING=fast: „niemand verbunden“ schließt nach 2 s).
      const alice = await second.connectClient({ guestId: ids.alice });
      const bob = await second.connectClient({ guestId: ids.bob });
      const carol = await second.connectClient({ guestId: ids.carol });
      const dave = await second.connectClient({ guestId: ids.dave });
      const resumedState = alice.waitFor("lobby:state", (state) => state.phase === "question");
      const waitingState = carol.waitFor("lobby:state", (state) => state.code === waitingCode);
      expect(await alice.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
      expect((await bob.emit("lobby:resume", { code })).ok).toBe(true);
      expect((await carol.emit("lobby:resume", { code: waitingCode })).ok).toBe(true);
      expect((await dave.emit("lobby:resume", { code: waitingCode })).ok).toBe(true);
      const state = await resumedState;
      // Anfang derselben Frage: gleiche Instanz, neue Zeitstempel, keine Antworten, Punkte erhalten.
      expect(state.question?.id).toBe(questionId);
      expect(state.question?.index).toBe(2);
      expect(state.question?.answeredBy).toEqual([]);
      expect(state.question?.startsAt ?? 0).toBeGreaterThanOrEqual(restartAt);
      expect(state.phaseStartedAt).toBeGreaterThanOrEqual(restartAt);
      expect(scoreOf(state, "Alice")).toBe(1);
      expect(scoreOf(state, "Bob")).toBe(0);
      expect(alice.contractViolations).toEqual([]);

      const players = [autoPlay(second, alice, code), autoPlay(second, bob, code)];
      const over = await waitForPhase(alice, "game_over", 60_000);
      for (const player of players) player.stop();
      // 2 Züge × 3 Fragen: Alice alle richtig (6), Bob alle außer Frage 1 (5).
      expect(over.results?.ranking.map((entry) => entry.score).sort()).toEqual([5, 6]);
      expect(scoreOf(over, "Alice")).toBe(6);
      expect(scoreOf(over, "Bob")).toBe(5);
      const [game] = await waitForGameDoc(second, lobbyId);
      expect(game?.turns.flatMap((turn) => turn.questions)).toHaveLength(6);

      // Die wartende Lobby ist mit beiden Personen da und startbar.
      const waiting = await waitingState;
      expect(waiting.phase).toBe("lobby");
      expect(waiting.players.map((player) => player.name)).toEqual(["Carol", "Dave"]);
      expect(lastState(dave)?.players.every((player) => player.connected)).toBe(true);
      const intro = carol.waitFor("lobby:state", (next) => next.phase === "intro");
      expect((await carol.emit("lobby:start", {})).ok).toBe(true);
      await intro;
    } finally {
      await second.cleanup();
    }
  });

  it("schließt nicht wiederherstellbare Snapshots und gibt ihre Codes frei", async () => {
    // Gültiger Snapshot als Vorlage, dann gezielt beschädigt.
    const template = await startServer(false);
    let base: ReturnType<typeof toLobbySnapshot>;
    try {
      const host = await template.connectClient();
      const guest = await template.connectClient();
      const code = await createLobby(host, "Hanna");
      await joinLobby(guest, code, "Gero");
      expect((await host.emit("lobby:start", {})).ok).toBe(true);
      await waitForPhase(host, "category_pick");
      base = toLobbySnapshot(runtimeOf(template).lobbies.get(code)?.state ?? fail("Lobby fehlt"));
    } finally {
      await template.cleanup();
    }
    await database.collections.lobbies.deleteMany({});
    const broken = [
      { ...base, _id: "kaputt-version-00001", code: "KPT234", game: { ...base.game, snapshotVersion: 99 } },
      { ...base, _id: "kaputt-host-0000001", code: "KPT235", hostPlayerId: "zzzzzzzzzzzzzzzz" },
      { _id: "kaputt-form-0000001", code: "KPT236", active: true, phase: "question", rev: 3 },
    ];
    await database.collections.lobbies.insertMany(broken as never[]);

    const server = await startServer(false);
    try {
      expect(reports.at(-1)).toMatchObject({ found: 3, resumed: 0, closed: 3, failed: 0 });
      expect(await metricValue(server.app.services.metrics, "qm_lobbies_resumed_total", { outcome: "closed" })).toBe(3);
      expect(await database.collections.lobbies.countDocuments({ active: true })).toBe(0);
      expect(runtimeOf(server).lobbies.size).toBe(0);
      expect(await server.db.repos.lobbies.isCodeTaken("KPT234")).toBe(false);
      // Wer zurückkommen will, bekommt „Lobby nicht gefunden“ (Client → Startseite mit Hinweis).
      const client = await server.connectClient();
      const ack = await client.emit("lobby:resume", { code: "KPT234" });
      expect(ack.ok ? null : ack.error.code).toBe("LOBBY_NOT_FOUND");
    } finally {
      await server.cleanup();
    }
  });
});

function fail(message: string): never {
  throw new Error(message);
}
