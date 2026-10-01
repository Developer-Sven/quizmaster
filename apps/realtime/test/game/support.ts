/**
 * Hilfen für die Lobby-/Spiel-Integrationstests (W2#3): Server im eigenen Port-Bereich 4140–4149 mit
 * `GAME_TIMING=fast`, Gäste mit guests-Dokument, Lobby erstellen/beitreten und ein automatischer Spieler,
 * der wie ein Client auf `lobby:state` reagiert (Kategorie wählen, zum `startsAt` antworten).
 *
 * Tests dürfen serverseitig in den Zustand schauen (`actorOf(server, code).state`) – etwa um „immer richtig“
 * zu antworten. Clients sehen davon nichts; genau das prüfen die Invarianten-Tests über `client.received`.
 */
import { randomUUID } from "node:crypto";
import { currentQuestion, type LobbyState } from "@quizmaster/game-engine";
import type { AnswerIndex, PrivatePlayerState, PublicLobbyState } from "@quizmaster/shared";
import type { LobbyActor } from "../../src/lobby/lobby-actor.ts";
import { type GameRuntime, gameRuntimeOf } from "../../src/lobby/module.ts";
import type { AppSocket } from "../../src/registry/types.ts";
import {
  eventually,
  type StartTestServerOptions,
  startTestServer,
  type TestClient,
  type TestConnectOptions,
  type TestServer,
} from "../helpers/index.ts";

/** Port-Bereich der Suite test/game (W2#2 nutzt 4130–4139). */
export const GAME_TEST_PORTS = { from: 4140, to: 4149 } as const;

export function startGameServer(options: StartTestServerOptions = {}): Promise<TestServer> {
  return startTestServer({ timing: "fast", ports: GAME_TEST_PORTS, ...options });
}

export function runtimeOf(server: TestServer): GameRuntime {
  const runtime = gameRuntimeOf(server.app);
  if (runtime === undefined) throw new Error("Lobby-Modul nicht gestartet");
  return runtime;
}

export function actorOf(server: TestServer, code: string): LobbyActor {
  const actor = runtimeOf(server).lobbies.get(code);
  if (actor === undefined) throw new Error(`Keine aktive Lobby ${code}`);
  return actor;
}

/** Server-Socket zu einem Test-Client (gleiche Socket-ID); wirft, wenn er nicht (mehr) verbunden ist. */
export function serverSocketOf(server: TestServer, client: TestClient): AppSocket {
  const socket = server.app.io.sockets.sockets.get(client.socket.id ?? "");
  if (socket === undefined) throw new Error("Server-Socket nicht gefunden");
  return socket;
}

/** Verbindet einen Gast; mit `guestDoc` wird vorher sein guests-Dokument angelegt (Statistik-Tests). */
export async function connectGuest(
  server: TestServer,
  options: TestConnectOptions & { guestDoc?: boolean } = {},
): Promise<TestClient> {
  const { guestDoc, ...connect } = options;
  const guestId = connect.guestId ?? randomUUID();
  if (guestDoc === true) await server.db.repos.guests.create(guestId, new Date());
  return server.connectClient({ ...connect, guestId });
}

/** Letzter empfangener Payload eines Events (oder `undefined`). */
export function lastPayload<T>(client: TestClient, event: string): T | undefined {
  for (let index = client.received.length - 1; index >= 0; index--) {
    const entry = client.received[index];
    if (entry?.event === event) return entry.payload as T;
  }
  return undefined;
}

export function lastState(client: TestClient): PublicLobbyState | undefined {
  return lastPayload<PublicLobbyState>(client, "lobby:state");
}

export function lastSelf(client: TestClient): PrivatePlayerState | undefined {
  return lastPayload<PrivatePlayerState>(client, "lobby:self");
}

/** Erstellt eine Lobby und liefert den Code (Ack ok, erster Zustand empfangen). */
export async function createLobby(client: TestClient, name = "Mia"): Promise<string> {
  const state = client.waitFor("lobby:state", (payload) => payload.phase === "lobby");
  const ack = await client.emit("lobby:create", { name });
  if (!ack.ok) throw new Error(`lobby:create abgelehnt: ${ack.error.code}`);
  await state;
  return ack.data.code;
}

/** Tritt bei und wartet auf den eigenen privaten Zustand. */
export async function joinLobby(client: TestClient, code: string, name: string): Promise<PrivatePlayerState> {
  const self = client.waitFor("lobby:self");
  const ack = await client.emit("lobby:join", { code, name });
  if (!ack.ok) throw new Error(`lobby:join abgelehnt: ${ack.error.code}`);
  return self;
}

/** Wartet, bis der Client einen Zustand mit dieser Phase gesehen hat (auch rückwirkend). */
export async function waitForPhase(
  client: TestClient,
  phase: PublicLobbyState["phase"],
  timeoutMs = 20_000,
): Promise<PublicLobbyState> {
  const seen = lastState(client);
  if (seen?.phase === phase) return seen;
  return client.waitFor("lobby:state", (state) => state.phase === phase, timeoutMs);
}

export type AnswerStrategy =
  | "correct"
  | "wrong"
  | "none"
  | ((question: NonNullable<PublicLobbyState["question"]>, correct: AnswerIndex) => AnswerIndex | null);

export interface AutoPlayerOptions {
  /** Antworten (Standard „correct“). */
  answer?: AnswerStrategy;
  /** Kategorie wählen, wenn man dran ist (Standard true; false = Zeit ablaufen lassen). */
  pick?: boolean;
}

export interface AutoPlayer {
  readonly picks: number;
  readonly answers: number;
  /** Acks auf `game:answer` (für Invariante 3). */
  readonly answerAcks: unknown[];
  /** Abgelehnte Aktionen (Code je Event). */
  readonly rejected: string[];
  stop(): void;
}

function serverCorrect(state: LobbyState, instanceId: string): AnswerIndex | null {
  const question = currentQuestion(state.game);
  return question !== undefined && question.instanceId === instanceId ? question.correct : null;
}

/**
 * Spielt für einen Client: wählt als wählende Person die erste Option (oder gar nicht) und beantwortet jede
 * Frage zum `startsAt` nach der Strategie. Die richtige Antwort liest er serverseitig aus dem Actor.
 */
export function autoPlay(
  server: TestServer,
  client: TestClient,
  code: string,
  options: AutoPlayerOptions = {},
): AutoPlayer {
  const strategy = options.answer ?? "correct";
  const answered = new Set<string>();
  const pickedTurns = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const answerAcks: unknown[] = [];
  const rejected: string[] = [];
  let playerId = lastSelf(client)?.playerId ?? null;
  let picks = 0;
  let answers = 0;
  let stopped = false;

  const onSelf = (self: PrivatePlayerState) => {
    playerId = self.playerId;
  };

  const onState = (state: PublicLobbyState) => {
    if (stopped || playerId === null) return;
    if (state.phase === "category_pick" && state.turn !== null && state.turn.categoryId === null) {
      const key = `${state.phaseStartedAt}:${state.turn.pickerId}`;
      if (state.turn.pickerId !== playerId || pickedTurns.has(key) || options.pick === false) return;
      pickedTurns.add(key);
      const categoryId = state.turn.options[0].id;
      void client.emit("game:pick", { categoryId }).then((ack) => {
        if (ack.ok) picks += 1;
        else rejected.push(`game:pick:${ack.error.code}`);
      });
      return;
    }
    const question = state.question;
    if (state.phase !== "question" || question === null || answered.has(question.id)) return;
    const me = state.players.find((player) => player.id === playerId);
    if (me === undefined || me.status !== "active") return;
    answered.add(question.id);
    const delay = Math.max(0, question.startsAt - Date.now()) + 15;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      const actor = runtimeOf(server).lobbies.get(code);
      const correct = actor === undefined ? null : serverCorrect(actor.state, question.id);
      if (correct === null) return;
      let choice: AnswerIndex | null;
      if (strategy === "correct") choice = correct;
      else if (strategy === "wrong") choice = ((correct + 1) % 4) as AnswerIndex;
      else if (strategy === "none") choice = null;
      else choice = strategy(question, correct);
      if (choice === null) return;
      void client.emit("game:answer", { questionId: question.id, choice }).then((ack) => {
        answerAcks.push(ack);
        if (ack.ok) answers += 1;
        else rejected.push(`game:answer:${ack.error.code}`);
      });
    }, delay);
    timers.add(timer);
  };

  client.socket.on("lobby:self", onSelf);
  client.socket.on("lobby:state", onState);
  const current = lastState(client);
  if (current !== undefined) onState(current);

  return {
    get picks() {
      return picks;
    },
    get answers() {
      return answers;
    },
    answerAcks,
    rejected,
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      client.socket.off("lobby:self", onSelf);
      client.socket.off("lobby:state", onState);
    },
  };
}

/** Wartet, bis das games-Dokument der Lobby geschrieben ist. */
export async function waitForGameDoc(server: TestServer, lobbyId: string, count = 1, timeoutMs = 20_000) {
  await eventually(async () => (await server.db.collections.games.countDocuments({ lobbyId })) >= count, timeoutMs);
  return server.db.collections.games.find({ lobbyId }).sort({ endedAt: 1 }).toArray();
}

/** Alle `lobby:state`-Payloads eines Clients in Empfangsreihenfolge. */
export function receivedStates(client: TestClient): PublicLobbyState[] {
  return client.received
    .filter((entry) => entry.event === "lobby:state")
    .map((entry) => entry.payload as PublicLobbyState);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
