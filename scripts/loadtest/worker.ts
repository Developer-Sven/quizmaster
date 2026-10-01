// Lastgenerator-Prozess des Lasttests (docs/07 §Lasttest) – wird von scripts/loadtest/run.ts gestartet (IPC), nie
// direkt. Spielt seine Lobbys wie echte Clients mit echten socket.io-client-Verbindungen: Ticket je Verbindung
// (HS256 mit dem Test-Secret), Uhrenabgleich wie der Web-Client (5× time:sync, alle 60 s), Lobby erstellen,
// beitreten, starten, Kategorien wählen und antworten nach der Bot-Strategie der Engine, Revanche nach Spielende.
//
// Misst: Verbindungsaufbau, Ack-Latenzen je Event, Zeit bis zum passenden `lobby:state` nach einer Aktion,
// Broadcast-Latenz (Empfang − `phaseStartedAt`, mit Uhrenabgleich) und Fehler je Code.
import { randomBytes, randomUUID } from "node:crypto";
import {
  botAnswerDelayMs,
  botPickDelayMs,
  chooseBotAnswer,
  chooseBotCategory,
  createSeededRng,
} from "@quizmaster/game-engine";
import {
  type GameTimingMode,
  getTimings,
  PROTOCOL_VERSION,
  type PrivatePlayerState,
  type PublicLobbyState,
  REALTIME_TICKET,
  SOCKET_PATH,
} from "@quizmaster/shared";
import { SignJWT } from "jose";
import { io, type Socket } from "socket.io-client";
import { emptyStats, increment, record, type WorkerStats } from "./lib/stats.ts";

export interface WorkerConfig {
  worker: number;
  target: string;
  origin: string;
  ticketSecret: string;
  /** Je Lobby: Startzeit und guestIds der Plätze (Platz 0 = Host). */
  lobbies: Array<{ index: number; startAt: number; guests: string[] }>;
  players: number;
  rounds: number;
  questionsPerCategory: number;
  rematch: boolean;
  timing: GameTimingMode;
  endAt: number;
}

export type ToWorker = { type: "start"; config: WorkerConfig } | { type: "stop" };
export type FromWorker =
  | { type: "progress"; worker: number; connected: number; lobbies: number; answers: number; problems: number }
  | { type: "done"; worker: number; stats: WorkerStats };

const ACK_TIMEOUT_MS = 10_000;
const STATE_TIMEOUT_MS = 15_000;
const NAMES = ["Mia", "Ben", "Lea", "Tom", "Ida", "Max", "Zoe", "Kai"];

interface StateWaiter {
  metric: string;
  startedAt: number;
  predicate: (state: PublicLobbyState) => boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Bot {
  socket: Socket;
  guestId: string;
  self: PrivatePlayerState | null;
  lobby: PublicLobbyState | null;
  /** Serverzeit − Clientzeit (Median des Uhrenabgleichs). */
  offset: number;
  answered: Set<string>;
  picked: Set<number>;
  rematched: Set<number>;
  waiters: StateWaiter[];
}

const stats: WorkerStats = emptyStats();
const bots = new Set<Bot>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let stopping = false;
let ipCounter = 0;

function send(message: FromWorker): void {
  process.send?.(message);
}

function later(ms: number, task: () => void | Promise<void>): void {
  if (stopping) return;
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (stopping) return;
    Promise.resolve(task()).catch((error: unknown) => {
      increment(stats, `task_error:${error instanceof Error ? error.name : "unbekannt"}`);
    });
  }, ms);
  timers.add(timer);
}

function sleepUntil(at: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        resolve();
      },
      Math.max(0, at - Date.now()),
    );
    timers.add(timer);
  });
}

function mintTicket(secret: string, guestId: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    sub: guestId,
    aud: REALTIME_TICKET.audience,
    iss: REALTIME_TICKET.issuer,
    iat,
    exp: iat + REALTIME_TICKET.ttlSec,
    jti: randomBytes(16).toString("base64url"),
  })
    .setProtectedHeader({ alg: REALTIME_TICKET.algorithm, typ: "JWT" })
    .sign(new TextEncoder().encode(secret));
}

type AckResult = { ok: true; data: unknown } | { ok: false; code: string };

function emitAck(bot: Bot, event: string, payload: unknown): Promise<AckResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    bot.socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (error: Error | null, response: unknown) => {
      const elapsed = performance.now() - started;
      if (error !== null) {
        increment(stats, `timeout:${event}`);
        resolve({ ok: false, code: "TIMEOUT" });
        return;
      }
      record(stats, `ack:${event}`, elapsed);
      const ack = response as { ok?: boolean; data?: unknown; error?: { code?: string } } | null;
      if (ack?.ok === true) {
        increment(stats, `ok:${event}`);
        resolve({ ok: true, data: ack.data });
        return;
      }
      const code = ack?.error?.code ?? "UNGUELTIG";
      increment(stats, `error:${event}:${code}`);
      resolve({ ok: false, code });
    });
  });
}

/** Misst die Zeit bis zum ersten `lobby:state`, der `predicate` erfüllt (vor der Aktion registrieren). */
function waitForState(bot: Bot, metric: string, predicate: (state: PublicLobbyState) => boolean): void {
  const waiter: StateWaiter = {
    metric,
    startedAt: performance.now(),
    predicate,
    timer: setTimeout(() => {
      bot.waiters = bot.waiters.filter((entry) => entry !== waiter);
      if (!stopping) increment(stats, `state_timeout:${metric}`);
    }, STATE_TIMEOUT_MS),
  };
  bot.waiters.push(waiter);
}

async function syncClock(bot: Bot): Promise<void> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < 5 && !stopping && bot.socket.connected; attempt++) {
    const t0 = Date.now();
    const result = await emitAck(bot, "time:sync", { t0 });
    const t1 = Date.now();
    if (result.ok) {
      const serverNow = (result.data as { serverNow?: number } | null)?.serverNow;
      if (typeof serverNow === "number") samples.push(serverNow - (t0 + (t1 - t0) / 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (samples.length > 0) {
    samples.sort((a, b) => a - b);
    bot.offset = samples[Math.floor(samples.length / 2)] ?? 0;
  }
}

function nextIp(worker: number): string {
  ipCounter += 1;
  return `10.${100 + worker}.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

/** Wie der Web-Client: abgelehnte Verbindungen erneut versuchen (Backoff 1 s, 2 s, 4 s), erst dann aufgeben. */
const CONNECT_RETRIES_MS = [1_000, 2_000, 4_000];

async function connectBot(config: WorkerConfig, guestId: string = randomUUID()): Promise<Bot | null> {
  for (let attempt = 0; ; attempt++) {
    const result = await connectOnce(config, guestId);
    if (result.bot !== null) return result.bot;
    const delay = CONNECT_RETRIES_MS[attempt];
    if (delay === undefined || stopping) {
      increment(stats, `connect_error:${result.code}`);
      return null;
    }
    increment(stats, `connect_retry:${result.code}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function connectOnce(config: WorkerConfig, guestId: string): Promise<{ bot: Bot | null; code: string }> {
  const started = performance.now();
  const socket = io(config.target, {
    path: SOCKET_PATH,
    transports: ["websocket"],
    reconnection: false,
    timeout: 20_000,
    extraHeaders: { origin: config.origin, "x-qm-test-ip": nextIp(config.worker) },
    auth: (callback: (data: object) => void) => {
      mintTicket(config.ticketSecret, guestId).then(
        (ticket) => callback({ ticket, protocolVersion: PROTOCOL_VERSION }),
        (error: unknown) => {
          increment(stats, `ticket_error:${error instanceof Error ? error.name : "unbekannt"}`);
          callback({});
        },
      );
    },
  });
  const bot: Bot = {
    socket,
    guestId,
    self: null,
    lobby: null,
    offset: 0,
    answered: new Set(),
    picked: new Set(),
    rematched: new Set(),
    waiters: [],
  };
  return new Promise((resolve) => {
    socket.once("connect", () => {
      record(stats, "connect", performance.now() - started);
      increment(stats, "sockets");
      bots.add(bot);
      attach(bot, config);
      resolve({ bot, code: "OK" });
    });
    socket.once("connect_error", (error: Error & { data?: { code?: string } }) => {
      socket.close();
      resolve({ bot: null, code: error.data?.code ?? error.message.slice(0, 40) });
    });
  });
}

function attach(bot: Bot, config: WorkerConfig): void {
  const timings = getTimings(config.timing);
  const rng = createSeededRng(`${config.worker}:${bot.guestId}`);

  const react = () => {
    const state = bot.lobby;
    const self = bot.self;
    if (stopping || state === null || self === null) return;
    const turn = state.turn;
    if (state.phase === "category_pick" && turn !== null && turn.categoryId === null && self.canPick) {
      const key = state.phaseStartedAt;
      if (bot.picked.has(key)) return;
      bot.picked.add(key);
      later(botPickDelayMs(timings, rng), async () => {
        const current = bot.lobby;
        if (current?.phase !== "category_pick" || current.phaseStartedAt !== key || current.turn === null) return;
        const option = chooseBotCategory(current.turn.options, rng);
        waitForState(
          bot,
          "state:game:pick",
          (next) => next.turn?.categoryId === option.id || next.phase !== "category_pick",
        );
        const result = await emitAck(bot, "game:pick", { categoryId: option.id });
        if (result.ok) increment(stats, "picks");
      });
      return;
    }
    const question = state.question;
    if (state.phase === "question" && question !== null && !bot.answered.has(question.id)) {
      const me = state.players.find((player) => player.id === self.playerId);
      if (me === undefined || me.status !== "active") return;
      bot.answered.add(question.id);
      const startsInMs = question.startsAt - (Date.now() + bot.offset);
      later(Math.max(0, startsInMs) + botAnswerDelayMs(timings, rng), async () => {
        const current = bot.lobby;
        if (current?.phase !== "question" || current.question?.id !== question.id) return;
        waitForState(
          bot,
          "state:game:answer",
          (next) =>
            next.phase !== "question" ||
            next.question?.id !== question.id ||
            next.question.answeredBy.includes(self.playerId),
        );
        const choice = chooseBotAnswer({ correct: null, difficulty: null }, rng);
        const result = await emitAck(bot, "game:answer", { questionId: question.id, choice });
        if (result.ok) increment(stats, "answers");
      });
      return;
    }
    if (state.phase === "game_over" && self.isHost && !bot.rematched.has(state.phaseStartedAt)) {
      bot.rematched.add(state.phaseStartedAt);
      increment(stats, "games_completed");
      if (!config.rematch || Date.now() + 15_000 > config.endAt) return;
      later(3_000, async () => {
        waitForState(bot, "state:game:rematch", (next) => next.phase === "intro");
        const result = await emitAck(bot, "game:rematch", {});
        if (result.ok) increment(stats, "rematches");
      });
    }
  };

  bot.socket.on("lobby:state", (state: PublicLobbyState) => {
    const now = performance.now();
    const previous = bot.lobby;
    bot.lobby = state;
    if (previous !== null && (previous.phaseStartedAt !== state.phaseStartedAt || previous.phase !== state.phase)) {
      // Broadcast bis Client: Empfang (in Serverzeit) − Beginn der Phase auf dem Server.
      const latency = Date.now() + bot.offset - state.phaseStartedAt;
      record(stats, "broadcast", latency);
      record(stats, `broadcast:${state.phase}`, latency);
    }
    if (bot.waiters.length > 0) {
      bot.waiters = bot.waiters.filter((waiter) => {
        if (!waiter.predicate(state)) return true;
        clearTimeout(waiter.timer);
        record(stats, waiter.metric, now - waiter.startedAt);
        return false;
      });
    }
    react();
  });
  bot.socket.on("lobby:self", (self: PrivatePlayerState) => {
    bot.self = self;
    react();
  });
  bot.socket.on("kicked", (payload: { reason?: string }) => increment(stats, `kicked:${payload.reason ?? "?"}`));
  bot.socket.on("notice", (payload: { code?: string }) => increment(stats, `notice:${payload.code ?? "?"}`));
  bot.socket.on("disconnect", (reason: string) => {
    bots.delete(bot);
    for (const waiter of bot.waiters) clearTimeout(waiter.timer);
    bot.waiters = [];
    if (!stopping) increment(stats, `disconnect:${reason}`);
  });
  void syncClock(bot);
  const resync = setInterval(() => {
    if (stopping || !bot.socket.connected) {
      clearInterval(resync);
      return;
    }
    void syncClock(bot);
  }, 60_000);
  resync.unref();
}

async function runLobby(config: WorkerConfig, spec: WorkerConfig["lobbies"][number]): Promise<void> {
  await sleepUntil(spec.startAt);
  if (stopping) return;
  const host = await connectBot(config, spec.guests[0]);
  if (host === null) {
    increment(stats, "lobby_failed");
    return;
  }
  waitForState(host, "state:lobby:create", (state) => state.phase === "lobby");
  const created = await emitAck(host, "lobby:create", { name: NAMES[0] });
  if (!created.ok) {
    increment(stats, "lobby_failed");
    return;
  }
  const code = (created.data as { code: string }).code;
  increment(stats, "lobbies");
  await emitAck(host, "lobby:update-settings", {
    rounds: config.rounds,
    questionsPerCategory: config.questionsPerCategory,
    maxPlayers: Math.max(2, config.players),
  });
  for (let seat = 1; seat < config.players && !stopping; seat++) {
    const bot = await connectBot(config, spec.guests[seat]);
    if (bot === null) continue;
    waitForState(bot, "state:lobby:join", (state) => state.code === code);
    const joined = await emitAck(bot, "lobby:join", { code, name: NAMES[seat] ?? `Gast ${seat}` });
    if (!joined.ok) increment(stats, "join_failed");
  }
  if (stopping) return;
  waitForState(host, "state:lobby:start", (state) => state.phase === "intro");
  const started = await emitAck(host, "lobby:start", {});
  if (started.ok) increment(stats, "games_started");
}

function problems(): number {
  return Object.entries(stats.counters)
    .filter(([name]) => /^(error|timeout|connect_error|disconnect|state_timeout|task_error|ticket_error):/.test(name))
    .reduce((sum, [, value]) => sum + value, 0);
}

function stop(config: WorkerConfig | null): void {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const bot of bots) {
    for (const waiter of bot.waiters) clearTimeout(waiter.timer);
    bot.socket.disconnect();
  }
  bots.clear();
  send({ type: "done", worker: config?.worker ?? -1, stats });
  // IPC-Nachricht zustellen lassen, dann beenden.
  setTimeout(() => process.exit(0), 500).unref();
}

let active: WorkerConfig | null = null;
process.on("message", (message: ToWorker) => {
  if (message.type === "start" && active === null) {
    const config = message.config;
    active = config;
    const progress = setInterval(() => {
      send({
        type: "progress",
        worker: config.worker,
        connected: bots.size,
        lobbies: stats.counters.lobbies ?? 0,
        answers: stats.counters.answers ?? 0,
        problems: problems(),
      });
    }, 5_000);
    progress.unref();
    for (const spec of config.lobbies) {
      runLobby(config, spec).catch((error: unknown) => {
        increment(stats, `lobby_error:${error instanceof Error ? error.name : "unbekannt"}`);
      });
    }
    later(Math.max(0, config.endAt - Date.now()), () => stop(config));
  } else if (message.type === "stop") {
    stop(active);
  }
});
process.on("disconnect", () => stop(active));
