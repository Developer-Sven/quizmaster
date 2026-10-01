/**
 * LobbyActor (docs/02 §Engine-Muster, ADR-003): hält den Zustand EINER Lobby und verarbeitet alle Commands
 * strikt nacheinander – Personen-Commands der Handler, fällige Timer, Antworten auf Shell-Anfragen und
 * Bot-Aktionen laufen durch dieselbe Warteschlange. Je Command: `reduce` → bei Erfolg Zustand übernehmen, Ack
 * senden (`onAccepted`), dann die Effects in der gelieferten Reihenfolge ausführen:
 *
 * | Effect | Ausführung |
 * |---|---|
 * | `kick` | `kicked { reason }` an die Sockets der Person in dieser Lobby, danach verlassen sie den Raum |
 * | `broadcast` | `lobby:state` = `toPublicState` einmal projiziert und einmal serialisiert an den Lobby-Raum |
 * | `sendPrivate` | `lobby:self` = `toPrivateState` an alle Sockets der Person in dieser Lobby |
 * | `notice` | `notice { code }` an den Lobby-Raum |
 * | `scheduleTimer` / `cancelTimer` | ein `setTimeout` je Token → `TIMEOUT { token }` in die Warteschlange |
 * | `offerCategories` | Fragen-Service → `OPTIONS_READY` (keine 3 Kategorien → `LOAD_FAILED`) |
 * | `loadQuestions` | ziehen + Volldokumente laden → `QUESTIONS_READY` (nichts → `LOAD_FAILED`) |
 * | `gameFinished` | finishGame-Transaktion im Hintergrund (Gast-/Fragen-Statistik, Bots ausgenommen) |
 * | `persist` | Snapshot entprellt (`SNAPSHOT_DEBOUNCE_MS`) |
 * | `closeLobby` | Timer löschen, Snapshot sofort, Sockets lösen, aus der Registry entfernen |
 *
 * Asynchrone Arbeit (Fragen laden, Spielabschluss, Snapshots) blockiert die Warteschlange nie: ihr Ergebnis
 * kommt als neuer Command zurück. Lehnt die Engine eine Antwort der Shell ab, folgt `LOAD_FAILED` – eine
 * offene Anfrage bleibt so nie bis zur Engine-Frist hängen.
 *
 * Fehler werden je Command und je Effect abgefangen und geloggt; die Engine ist rein, ein Fehler in `reduce`
 * lässt den letzten gültigen Zustand stehen (Ack `INTERNAL`). Weitere Pflichten der Shell:
 * - Ein neuer Socket kommt VOR JOIN/RECONNECT in den Raum (im selben Warteschlangen-Schritt – kein fremder
 *   Broadcast dazwischen) und verlässt ihn bei Ablehnung wieder.
 * - DISCONNECT erst, wenn der letzte Socket der Person in DIESER Lobby weg ist.
 * - Nach jedem Command mit neuem `phaseToken` plant der Bot-Treiber die Dev-Bots neu.
 * - Beim Spielstart (Phase `intro`) werden die gesehenen Fragen aller Menschen geladen.
 */
import type { Repositories } from "@quizmaster/db";
import {
  type Command,
  type Effect,
  findPlayerByGuestId,
  type GameStats,
  humanMembers,
  type LobbyState,
  type ReduceResult,
  type Rng,
  reduce,
  type SeenQuestions,
  type TurnRef,
  toLobbySnapshot,
  toPrivateState,
  toPublicState,
} from "@quizmaster/game-engine";
import { type ErrorCode, isProtocolError, type KickReason } from "@quizmaster/shared";
import type { GameDoc } from "@quizmaster/shared/documents";
import { createBotDriver } from "../bots/bot-driver.ts";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { roomForLobby } from "../registry/rooms.ts";
import type { AppServer, AppSocket, Clock } from "../registry/types.ts";
import type { QuestionService } from "../services/questions.ts";
import { finishGameInput, playedQuestionIds, recordFinishedGame } from "./game-finish.ts";
import { appendHistory, loadSeenQuestions } from "./seen-questions.ts";
import { createSnapshotWriter } from "./snapshots.ts";
import { createTimerSet } from "./timers.ts";

/** Höchstens so lange wartet das Laden der gesehenen Fragen auf den Abschluss des Vorgängerspiels. */
export const FINISH_WAIT_MS = 5_000;
/** Höchstens so lange wartet der Shutdown auf laufende Commands der Lobby. */
export const QUEUE_DRAIN_TIMEOUT_MS = 1_000;

/** Command oder Fabrik, die ihn aus dem aktuellen Zustand baut (läuft IN der Warteschlange). */
export type CommandInput = Command | ((state: LobbyState) => Command);

export interface DispatchOptions {
  /**
   * Socket, der im selben Schritt VOR dem Command in den Lobby-Raum kommt (Erstellen, JOIN, RECONNECT);
   * bei Ablehnung verlässt er ihn wieder.
   */
  attach?: AppSocket;
  /** Nach erfolgreichem `reduce`, vor den Effects – hier senden Handler ihr Ack. */
  onAccepted?: (state: LobbyState) => void;
}

export interface DispatchRejection {
  code: ErrorCode;
  message: string;
}

export type DispatchResult =
  | { ok: true; state: LobbyState }
  | { ok: false; state: LobbyState; error: DispatchRejection };

/**
 * Wie ein Socket die Lobby verlässt: `disconnect` (Verbindung weg) und `moved` (Socket ist jetzt in einer
 * anderen Lobby) senden DISCONNECT, sobald die Person hier keinen Socket mehr hat; `left` (Verlassen,
 * Entfernen, Schließen) nicht – die Person ist dann ohnehin kein Mitglied mehr.
 */
export type DetachMode = "disconnect" | "moved" | "left";

/** Rückmeldungen an die Registry (Socket-Zuordnung, Mitgliedschaften, Entfernen geschlossener Lobbys). */
export interface LobbyActorHooks {
  /** Socket gehört jetzt zu dieser Lobby (nach erfolgreichem Erstellen/JOIN/RECONNECT). */
  onSocketAttached(actor: LobbyActor, socket: AppSocket): void;
  /** Menschliche Mitglieder haben sich geändert (guestIds; bei Schließen verlassen alle). */
  onMembershipChanged(actor: LobbyActor, joined: readonly string[], left: readonly string[]): void;
  /** Socket gehört nicht mehr zu dieser Lobby. */
  onSocketDetached(actor: LobbyActor, socket: AppSocket): void;
  /** Lobby ist geschlossen (Effect `closeLobby`). */
  onClosed(actor: LobbyActor): void;
}

export interface LobbyActorDeps {
  io: AppServer;
  clock: Clock;
  rng: Rng;
  logger: Logger;
  metrics: RealtimeMetrics;
  questions: Pick<QuestionService, "offerCategories" | "loadQuestions">;
  repos: Pick<Repositories, "lobbies" | "guests" | "finishGame">;
  hooks: LobbyActorHooks;
  snapshotDebounceMs?: number;
}

export interface LobbyActor {
  readonly code: string;
  readonly lobbyId: string;
  /** Socket.IO-Raum der Lobby (`lobby:<CODE>`). */
  readonly room: string;
  /** Aktueller Zustand (unveränderlich; jede Änderung liefert ein neues Objekt). */
  readonly state: LobbyState;
  /** true nach dem Effect `closeLobby`. */
  readonly closed: boolean;
  /** Reiht einen Command ein; das Ergebnis kommt nach `reduce` und den Effects. */
  dispatch(input: CommandInput, options?: DispatchOptions): Promise<DispatchResult>;
  /** Führt die Effects von `createLobby` aus (Socket in den Raum, Ack, Zustand senden, Timer, Snapshot). */
  start(effects: readonly Effect[], options?: DispatchOptions): Promise<void>;
  /**
   * Wiederaufnahme (W4): stellt alle Timer aus `state.timers` neu, plant die Bots und lädt die gesehenen
   * Fragen, falls ein Spiel läuft. Nur für Zustände, die nicht über `createLobby` entstanden sind.
   */
  resume(): Promise<void>;
  /** Person ist Mitglied (nicht verlassen/entfernt) und die Lobby offen. */
  isMember(guestId: string): boolean;
  /** Sockets der Person in dieser Lobby. */
  socketsOf(guestId: string): AppSocket[];
  hasSocket(socket: AppSocket): boolean;
  /** Anzahl Sockets in der Lobby. */
  socketCount(): number;
  detachSocket(socket: AppSocket, mode: DetachMode): void;
  /** Alle Sockets einer Person lösen (ohne DISCONNECT, z. B. nach LEAVE). */
  detachGuest(guestId: string): void;
  /** Gesehene Fragen der laufenden Partie (leer vor dem ersten Spielstart). */
  seenQuestions(): Promise<SeenQuestions>;
  /** Gesehene Fragen neu laden (Spielstart; Wiederaufnahme). */
  refreshSeenQuestions(): void;
  /** Wartet, bis alle bis jetzt eingereihten Commands verarbeitet sind. */
  whenIdle(): Promise<void>;
  /** Ende des laufenden Spielabschlusses (wirft nie). */
  pendingFinish(): Promise<void>;
  /** Snapshot sofort schreiben (wirft nie). */
  flushSnapshot(): Promise<void>;
  /** Shutdown: keine Commands mehr (SERVER_BUSY), Timer stoppen, laufende Commands abwarten, Snapshot schreiben. */
  shutdown(): Promise<void>;
}

const EMPTY_SEEN: SeenQuestions = new Map();

/** guestIds der menschlichen Mitglieder (nicht verlassen/entfernt); geschlossene Lobby: keine. */
export function memberGuestIds(state: LobbyState): Set<string> {
  const ids = new Set<string>();
  if (state.closed !== null) return ids;
  for (const player of state.players) {
    if (!player.left && !player.isBot) ids.add(player.guestId);
  }
  return ids;
}

function membershipDiff(before: LobbyState, after: LobbyState): { joined: string[]; left: string[] } | null {
  if (before.players === after.players && (before.closed === null) === (after.closed === null)) return null;
  const previous = memberGuestIds(before);
  const current = memberGuestIds(after);
  const joined = [...current].filter((guestId) => !previous.has(guestId));
  const left = [...previous].filter((guestId) => !current.has(guestId));
  return joined.length === 0 && left.length === 0 ? null : { joined, left };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Wartet auf `promise`, höchstens aber `ms` (Fehler zählen als erledigt). */
function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([promise.then(noop, noop), sleep(ms)]);
}

function noop(): void {}

export function createLobbyActor(deps: LobbyActorDeps, initial: LobbyState): LobbyActor {
  const code = initial.code;
  const room = roomForLobby(code);
  const log = deps.logger.child({ lobby: code });
  let state = initial;
  let closed = initial.closed !== null;
  let frozen = false;
  let tail: Promise<unknown> = Promise.resolve();
  const sockets = new Map<string, Set<AppSocket>>();
  const timers = createTimerSet<number>(deps.clock);
  /** Fragen früherer Spiele dieser Lobby (älteste vorne) – für gesehene Fragen bei Revanchen. */
  const history: string[] = [];
  let seen: Promise<SeenQuestions> | null = null;
  let finishing: Promise<unknown> = Promise.resolve();

  const snapshots = createSnapshotWriter({
    snapshot: () => toLobbySnapshot(state),
    save: (doc) => deps.repos.lobbies.save(doc),
    logger: log,
    metrics: deps.metrics,
    ...(deps.snapshotDebounceMs === undefined ? {} : { debounceMs: deps.snapshotDebounceMs }),
  });

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    // Die Warteschlange läuft nach einem Fehler weiter; der Fehler selbst geht über `run` an den Aufrufer.
    tail = run.catch(noop);
    return run;
  };

  const rejection = (code: ErrorCode, message: string): DispatchResult => ({
    ok: false,
    state,
    error: { code, message },
  });

  // --- Sockets ---------------------------------------------------------------------------------------------

  const hasSocket = (socket: AppSocket) => sockets.get(socket.data.guestId)?.has(socket) ?? false;

  /** In den Index und den Raum aufnehmen (vor dem Command, damit der erste Zustand ankommt). */
  const addSocket = async (socket: AppSocket) => {
    const guestId = socket.data.guestId;
    let set = sockets.get(guestId);
    if (set === undefined) {
      set = new Set();
      sockets.set(guestId, set);
    }
    set.add(socket);
    try {
      await socket.join(room);
    } catch (error) {
      log.error({ err: error }, "Socket nicht in den Lobby-Raum aufgenommen");
    }
  };

  /** Aus Index und Raum entfernen; `true`, wenn der Socket dabei war. */
  const removeSocket = (socket: AppSocket): boolean => {
    const guestId = socket.data.guestId;
    const set = sockets.get(guestId);
    if (set === undefined || !set.delete(socket)) return false;
    if (set.size === 0) sockets.delete(guestId);
    Promise.resolve(socket.leave(room)).catch((error: unknown) => {
      log.warn({ err: error }, "Socket hat den Lobby-Raum nicht verlassen");
    });
    return true;
  };

  const detachSocket = (socket: AppSocket, mode: DetachMode) => {
    if (!removeSocket(socket)) return;
    deps.hooks.onSocketDetached(actor, socket);
    const guestId = socket.data.guestId;
    if (mode !== "left" && !sockets.has(guestId) && !closed) {
      dispatch({ type: "DISCONNECT", guestId }).catch((error: unknown) => {
        log.error({ err: error }, "DISCONNECT fehlgeschlagen");
      });
    }
  };

  const detachGuest = (guestId: string) => {
    for (const socket of [...(sockets.get(guestId) ?? [])]) detachSocket(socket, "left");
  };

  // --- Effects ---------------------------------------------------------------------------------------------

  const sendPrivate = (playerId: string, guestId: string) => {
    const targets = sockets.get(guestId);
    if (targets === undefined || targets.size === 0) return;
    const payload = toPrivateState(state, playerId);
    for (const socket of targets) socket.emit("lobby:self", payload);
  };

  const kickGuest = (guestId: string, reason: KickReason) => {
    for (const socket of [...(sockets.get(guestId) ?? [])]) {
      socket.emit("kicked", { reason });
      detachSocket(socket, "left");
    }
  };

  /** Antwort auf eine Shell-Anfrage einreihen; lehnt die Engine sie als ungültig ab, folgt LOAD_FAILED. */
  const respond = async (command: Command & { token: number }) => {
    const result = await dispatch(command);
    if (result.ok) return;
    if (command.type === "LOAD_FAILED" || result.error.code !== "VALIDATION_FAILED") {
      // Geschlossen oder eingefroren (Shutdown): die Antwort wird nicht mehr gebraucht.
      log.debug({ command: command.type, code: result.error.code }, "Antwort der Shell nicht mehr angenommen");
      return;
    }
    log.error(
      { command: command.type, code: result.error.code, detail: result.error.message },
      "Engine lehnte die Antwort der Shell ab – Spiel endet mit LOAD_FAILED",
    );
    await dispatch({ type: "LOAD_FAILED", token: command.token, reason: `Antwort abgelehnt: ${result.error.code}` });
  };

  const answerOffer = async (token: number, turn: TurnRef) => {
    let command: Command & { token: number };
    try {
      const options = deps.questions.offerCategories(turn, await seenQuestions());
      if (options === null) {
        log.warn({ turn: turn.turnNumber }, "Keine drei spielbaren Kategorien – Spiel endet");
        command = { type: "LOAD_FAILED", token, reason: "Keine drei spielbaren Kategorien" };
      } else {
        command = { type: "OPTIONS_READY", token, options };
      }
    } catch (error) {
      log.error({ err: error }, "Kategorien anbieten fehlgeschlagen");
      command = { type: "LOAD_FAILED", token, reason: "Kategorien anbieten fehlgeschlagen" };
    }
    await respond(command);
  };

  const answerLoad = async (effect: Extract<Effect, { type: "loadQuestions" }>) => {
    let command: Command & { token: number };
    try {
      const loaded = await deps.questions.loadQuestions({
        categoryId: effect.categoryId,
        count: effect.count,
        excludeQuestionIds: effect.excludeQuestionIds,
        seen: await seenQuestions(),
      });
      if (loaded.refilledSeen > 0) {
        log.info(
          { category: effect.categoryId, refilled: loaded.refilledSeen },
          "Zu wenig ungesehene Fragen – mit gesehenen aufgefüllt (älteste zuerst)",
        );
      }
      if (loaded.questions.length === 0) {
        log.warn({ category: effect.categoryId }, "Keine Fragen in der gewählten Kategorie – Spiel endet");
        command = { type: "LOAD_FAILED", token: effect.token, reason: "Keine Fragen in der Kategorie" };
      } else {
        command = { type: "QUESTIONS_READY", token: effect.token, questions: loaded.questions };
      }
    } catch (error) {
      log.error({ err: error, category: effect.categoryId }, "Fragen laden fehlgeschlagen – Spiel endet");
      command = { type: "LOAD_FAILED", token: effect.token, reason: "Fragen laden fehlgeschlagen" };
    }
    await respond(command);
  };

  const recordGame = (game: GameDoc, stats: GameStats) => {
    appendHistory(history, playedQuestionIds(game));
    const input = finishGameInput(game, stats, toLobbySnapshot(state));
    const previous = finishing;
    finishing = previous.then(() =>
      recordFinishedGame({ repos: deps.repos, logger: log, metrics: deps.metrics }, input, () => deps.clock.now()),
    );
  };

  const close = (reason: string) => {
    closed = true;
    timers.clear();
    bots.stop();
    for (const set of [...sockets.values()]) {
      for (const socket of [...set]) detachSocket(socket, "left");
    }
    snapshots
      .flush()
      .then(() => snapshots.stop())
      .catch((error: unknown) => {
        log.error({ err: error }, "Abschluss-Snapshot fehlgeschlagen");
      });
    deps.hooks.onClosed(actor);
    log.info({ reason }, "Lobby geschlossen");
  };

  const runEffect = (effect: Effect) => {
    switch (effect.type) {
      case "kick":
        kickGuest(effect.guestId, effect.reason);
        return;
      case "broadcast":
        // Einmal projiziert; der Adapter serialisiert das Paket einmal für alle Sockets des Raums.
        deps.io.to(room).emit("lobby:state", toPublicState(state));
        return;
      case "sendPrivate":
        sendPrivate(effect.playerId, effect.guestId);
        return;
      case "notice":
        deps.io.to(room).emit("notice", { code: effect.code });
        return;
      case "cancelTimer":
        timers.cancel(effect.token);
        return;
      case "scheduleTimer": {
        const token = effect.token;
        timers.set(token, effect.at, () => {
          dispatch({ type: "TIMEOUT", token }).catch((error: unknown) => {
            log.error({ err: error }, "TIMEOUT fehlgeschlagen");
          });
        });
        return;
      }
      case "offerCategories":
        void answerOffer(effect.token, effect.turn);
        return;
      case "loadQuestions":
        void answerLoad(effect);
        return;
      case "gameFinished":
        recordGame(effect.game, effect.stats);
        return;
      case "persist":
        snapshots.request();
        return;
      case "closeLobby":
        close(effect.reason);
        return;
    }
  };

  const runEffects = (effects: readonly Effect[]) => {
    for (const effect of effects) {
      try {
        runEffect(effect);
      } catch (error) {
        log.error({ err: error, effect: effect.type }, "Effect fehlgeschlagen");
      }
    }
  };

  // --- Gesehene Fragen -------------------------------------------------------------------------------------

  const seenQuestions = (): Promise<SeenQuestions> => seen ?? Promise.resolve(EMPTY_SEEN);

  const refreshSeenQuestions = () => {
    const guestIds = humanMembers(state).map((player) => player.guestId);
    const lobbyHistory = [...history];
    const previousGame = finishing;
    seen = (async () => {
      // Erst den Abschluss des Vorgängerspiels abwarten (Revanche), damit dessen Fragen in guests stehen.
      await waitAtMost(previousGame, FINISH_WAIT_MS);
      return loadSeenQuestions(
        { guests: deps.repos.guests, logger: log, metrics: deps.metrics },
        guestIds,
        lobbyHistory,
      );
    })();
  };

  // --- Commands --------------------------------------------------------------------------------------------

  const afterCommand = (before: LobbyState, after: LobbyState) => {
    if (after.phase === "intro" && before.phase !== "intro") refreshSeenQuestions();
    // Nach Spielende nicht mehr nötig (bis zu 8 × 1.000 Einträge); eine Revanche lädt sie neu.
    if (after.phase === "game_over" && before.phase !== "game_over") seen = null;
    bots.afterCommand(before, after);
  };

  const process = async (input: CommandInput, options: DispatchOptions): Promise<DispatchResult> => {
    if (closed) return rejection("LOBBY_NOT_FOUND", "Lobby ist geschlossen");
    if (frozen) return rejection("SERVER_BUSY", "Server startet neu");
    const before = state;
    let command: Command;
    try {
      command = typeof input === "function" ? input(before) : input;
    } catch (error) {
      if (isProtocolError(error)) return rejection(error.code, error.message);
      log.error({ err: error }, "Command nicht erzeugbar");
      return rejection("INTERNAL", "Interner Fehler");
    }
    const socket = options.attach;
    const newlyAttached = socket !== undefined && !hasSocket(socket);
    if (socket !== undefined && newlyAttached) await addSocket(socket);
    if (closed || frozen) {
      if (socket !== undefined && newlyAttached) removeSocket(socket);
      return closed
        ? rejection("LOBBY_NOT_FOUND", "Lobby ist geschlossen")
        : rejection("SERVER_BUSY", "Server startet neu");
    }
    let result: ReduceResult;
    try {
      result = reduce(state, command, { now: deps.clock.now(), rng: deps.rng });
    } catch (error) {
      log.error({ err: error, command: command.type }, "reduce fehlgeschlagen – Zustand unverändert");
      if (socket !== undefined && newlyAttached) removeSocket(socket);
      return rejection("INTERNAL", "Interner Fehler");
    }
    if (!result.ok) {
      if (socket !== undefined && newlyAttached) removeSocket(socket);
      return { ok: false, state, error: result.error };
    }
    const previous = state;
    state = result.state;
    const membership = membershipDiff(previous, state);
    if (membership !== null) deps.hooks.onMembershipChanged(actor, membership.joined, membership.left);
    if (socket !== undefined) deps.hooks.onSocketAttached(actor, socket);
    if (options.onAccepted !== undefined) {
      try {
        options.onAccepted(state);
      } catch (error) {
        log.error({ err: error }, "Ack fehlgeschlagen");
      }
    }
    runEffects(result.effects);
    try {
      afterCommand(previous, state);
    } catch (error) {
      log.error({ err: error, command: command.type }, "Nachbearbeitung des Commands fehlgeschlagen");
    }
    return { ok: true, state };
  };

  const dispatch = (input: CommandInput, options: DispatchOptions = {}): Promise<DispatchResult> =>
    enqueue(() =>
      process(input, options).catch((error: unknown) => {
        log.error({ err: error }, "Command fehlgeschlagen");
        return rejection("INTERNAL", "Interner Fehler");
      }),
    );

  const bots = createBotDriver({
    clock: deps.clock,
    rng: deps.rng,
    logger: log,
    dispatch: (command) => dispatch(command),
  });

  const actor: LobbyActor = {
    code,
    lobbyId: initial.lobbyId,
    room,
    get state() {
      return state;
    },
    get closed() {
      return closed;
    },
    dispatch,

    start(effects, options = {}) {
      return enqueue(async () => {
        const socket = options.attach;
        if (socket !== undefined) {
          await addSocket(socket);
          deps.hooks.onSocketAttached(actor, socket);
        }
        if (options.onAccepted !== undefined) {
          try {
            options.onAccepted(state);
          } catch (error) {
            log.error({ err: error }, "Ack fehlgeschlagen");
          }
        }
        runEffects(effects);
      });
    },

    resume() {
      return enqueue(async () => {
        if (closed) return;
        for (const timer of state.timers) {
          const token = timer.token;
          timers.set(token, timer.at, () => {
            dispatch({ type: "TIMEOUT", token }).catch((error: unknown) => {
              log.error({ err: error }, "TIMEOUT fehlgeschlagen");
            });
          });
        }
        if (state.game !== null && state.phase !== "lobby" && state.phase !== "game_over") refreshSeenQuestions();
        bots.replan(state);
      });
    },

    isMember(guestId) {
      if (closed || state.closed !== null) return false;
      const player = findPlayerByGuestId(state, guestId);
      return player !== undefined && !player.left;
    },
    socketsOf: (guestId) => [...(sockets.get(guestId) ?? [])],
    hasSocket,
    socketCount() {
      let count = 0;
      for (const set of sockets.values()) count += set.size;
      return count;
    },
    detachSocket,
    detachGuest,
    seenQuestions,
    refreshSeenQuestions,
    whenIdle: () => tail.then(noop),
    pendingFinish: () => finishing.then(noop, noop),
    flushSnapshot: () => snapshots.flush(),

    async shutdown() {
      frozen = true;
      timers.clear();
      bots.stop();
      await waitAtMost(tail, QUEUE_DRAIN_TIMEOUT_MS);
      await snapshots.flush();
      snapshots.stop();
    },
  };

  return actor;
}
