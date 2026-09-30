/**
 * Test-Shell: spielt die Rolle des Realtime-LobbyActors. Führt Effects aus (Timer, Kategorien anbieten,
 * Fragen ziehen und laden), dispatcht Commands strikt nacheinander und prüft nach jedem Schritt optional
 * Invarianten (Hook). Zeit ist simuliert (`now`), Zufall kommt aus einem Seed.
 */
import type { AnswerIndex, GameTimingMode } from "@quizmaster/shared";
import { DEFAULT_DIFFICULTY_MIX, type DifficultyMix } from "@quizmaster/shared/content";
import {
  type BotMove,
  type Command,
  createLobby,
  createSeededRng,
  currentQuestion,
  drawQuestions,
  type Effect,
  findPlayerByGuestId,
  type LobbyState,
  offerCategories,
  planBotMoves,
  type ReduceResult,
  type Rng,
  reduce,
  type SeenQuestions,
  type TimerKind,
} from "../../src/index.ts";
import { type Catalog, deepFreeze, guestUuid, makeCatalog } from "./fixtures.ts";

export interface SimulationOptions {
  seed?: number | string;
  timing?: GameTimingMode;
  catalog?: Catalog;
  seen?: SeenQuestions;
  difficultyMix?: DifficultyMix;
  /** Shell beantwortet offerCategories/loadQuestions automatisch (Standard: true). */
  autoRespond?: boolean;
  /** Eingabezustände vor jedem reduce tief einfrieren (Reinheit prüfen). */
  freeze?: boolean;
  /** Startzeit. */
  startAt?: number;
  hostName?: string;
  /** Wird nach jedem Command aufgerufen (auch bei Ablehnung). */
  onStep?: (step: SimulationStep) => void;
}

export interface SimulationStep {
  command: Command;
  before: LobbyState;
  result: ReduceResult;
  now: number;
}

export interface ScheduledTimer {
  at: number;
  kind: TimerKind;
  playerId: string | null;
}

type ShellRequest =
  | { kind: "options"; effect: Extract<Effect, { type: "offerCategories" }> }
  | { kind: "questions"; effect: Extract<Effect, { type: "loadQuestions" }> };

export class Simulation {
  state: LobbyState;
  now: number;
  readonly rng: Rng;
  readonly catalog: Catalog;
  readonly timers = new Map<number, ScheduledTimer>();
  /** Alle ausgeführten Effects (chronologisch). */
  readonly effects: Effect[] = [];
  readonly steps: SimulationStep[] = [];
  /** Unbeantwortete Anfragen (nur bei `autoRespond: false`). */
  readonly requests: ShellRequest[] = [];
  /** Geplante Bot-Aktionen der laufenden Phase (wie im Realtime-Server via `planBotMoves`). */
  botMoves: BotMove[] = [];
  /** guestIds der menschlichen Personen in Beitrittsreihenfolge (Index 0 = Host). */
  readonly guests: string[] = [];
  lastBroadcastRev = 0;
  private readonly options: SimulationOptions;
  private guestCounter = 0;
  private readonly queue: Command[] = [];
  private draining = false;

  constructor(options: SimulationOptions = {}) {
    this.options = options;
    this.rng = createSeededRng(options.seed ?? 1);
    this.catalog = options.catalog ?? makeCatalog();
    this.now = options.startAt ?? 1_700_000_000_000;
    const hostGuest = this.nextGuestId();
    const created = createLobby(
      { code: "ABC234", guestId: hostGuest, name: options.hostName ?? "Mia", timing: options.timing ?? "normal" },
      { now: this.now, rng: this.rng },
    );
    if (!created.ok) throw new Error(`createLobby: ${created.error.code}`);
    this.guests.push(hostGuest);
    this.state = created.state;
    this.applyEffects(created.effects);
  }

  get seen(): SeenQuestions {
    return this.options.seen ?? new Map();
  }

  nextGuestId(): string {
    this.guestCounter++;
    return guestUuid(this.guestCounter);
  }

  /** Dispatcht einen Command (inkl. Folge-Commands der Shell) und liefert das Ergebnis dieses Commands. */
  dispatch(command: Command): ReduceResult {
    const before = this.options.freeze ? deepFreeze(this.state) : this.state;
    const result = reduce(before, command, { now: this.now, rng: this.rng });
    const step = { command, before, result, now: this.now };
    this.steps.push(step);
    if (result.ok) {
      this.state = result.state;
      if (result.state.phaseToken !== before.phaseToken) this.botMoves = planBotMoves(result.state, this.rng);
      this.applyEffects(result.effects);
    }
    this.options.onStep?.(step);
    this.drain();
    return result;
  }

  /** Dispatcht und erwartet Erfolg. */
  ok(command: Command): ReduceResult & { ok: true } {
    const result = this.dispatch(command);
    if (!result.ok) throw new Error(`${command.type} abgelehnt: ${result.error.code} (${result.error.message})`);
    return result;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let command = this.queue.shift(); command !== undefined; command = this.queue.shift()) {
        this.dispatch(command);
      }
    } finally {
      this.draining = false;
    }
  }

  private applyEffects(effects: readonly Effect[]): void {
    for (const effect of effects) {
      this.effects.push(effect);
      switch (effect.type) {
        case "scheduleTimer":
          this.timers.set(effect.token, { at: effect.at, kind: effect.kind, playerId: effect.playerId });
          break;
        case "cancelTimer":
          this.timers.delete(effect.token);
          break;
        case "broadcast":
          if (this.state.rev < this.lastBroadcastRev) throw new Error("rev ist gesunken");
          this.lastBroadcastRev = this.state.rev;
          break;
        case "offerCategories":
          if (this.options.autoRespond === false) this.requests.push({ kind: "options", effect });
          else this.queue.push(this.answerOptions(effect));
          break;
        case "loadQuestions":
          if (this.options.autoRespond === false) this.requests.push({ kind: "questions", effect });
          else this.queue.push(this.answerQuestions(effect));
          break;
        case "closeLobby":
          this.timers.clear();
          break;
        default:
          break;
      }
    }
  }

  /** Antwort der Shell auf `offerCategories` (wie im Realtime-Server). */
  answerOptions(effect: Extract<Effect, { type: "offerCategories" }>): Command {
    const options = offerCategories({
      categories: this.catalog.categories,
      pool: this.catalog.pool,
      seen: this.seen,
      turn: effect.turn,
      rng: this.rng,
    });
    return options
      ? { type: "OPTIONS_READY", token: effect.token, options }
      : { type: "LOAD_FAILED", token: effect.token, reason: "keine 3 Kategorien" };
  }

  /** Antwort der Shell auf `loadQuestions`: ziehen, „Volldokumente laden“ (in beliebiger Reihenfolge). */
  answerQuestions(effect: Extract<Effect, { type: "loadQuestions" }>): Command {
    const drawn = drawQuestions({
      categoryId: effect.categoryId,
      count: effect.count,
      pool: this.catalog.pool,
      seen: this.seen,
      usedQuestionIds: effect.excludeQuestionIds,
      difficultyMix: this.options.difficultyMix ?? DEFAULT_DIFFICULTY_MIX,
      rng: this.rng,
    });
    if (drawn.length === 0) return { type: "LOAD_FAILED", token: effect.token, reason: "keine Fragen" };
    // `$in` liefert keine feste Reihenfolge – die Engine sortiert selbst nach Schwierigkeit.
    const docs = [...drawn].reverse().map((entry) => {
      const doc = this.catalog.docs.get(entry.id);
      if (!doc) throw new Error(`Frage ${entry.id} fehlt`);
      return { ...doc };
    });
    return { type: "QUESTIONS_READY", token: effect.token, questions: docs };
  }

  /** Beantwortet eine offene Anfrage manuell (bei `autoRespond: false`). */
  respond(index = 0): ReduceResult {
    const request = this.requests.splice(index, 1)[0];
    if (!request) throw new Error("Keine offene Anfrage");
    return this.dispatch(
      request.kind === "options" ? this.answerOptions(request.effect) : this.answerQuestions(request.effect),
    );
  }

  /** Nächster fälliger Timer (frühester Zeitpunkt, bei Gleichstand kleinstes Token). */
  nextTimer(): [number, ScheduledTimer] | undefined {
    let best: [number, ScheduledTimer] | undefined;
    for (const entry of this.timers) {
      if (!best || entry[1].at < best[1].at || (entry[1].at === best[1].at && entry[0] < best[0])) best = entry;
    }
    return best;
  }

  /** Zeitpunkt des nächsten Ereignisses (Timer oder Bot-Aktion). */
  private nextEventAt(): number | undefined {
    const timer = this.nextTimer();
    const bot = this.botMoves.reduce<number | undefined>(
      (min, move) => (min === undefined || move.at < min ? move.at : min),
      undefined,
    );
    if (timer === undefined) return bot;
    if (bot === undefined) return timer[1].at;
    return Math.min(timer[1].at, bot);
  }

  /** Springt zum nächsten Ereignis (Bot-Aktion vor Timer bei Gleichstand) und führt es aus; `false`, wenn keins ansteht. */
  fireNext(): boolean {
    const at = this.nextEventAt();
    if (at === undefined) return false;
    this.now = Math.max(this.now, at);
    const botIndex = this.botMoves.findIndex((move) => move.at === at);
    if (botIndex >= 0) {
      const [move] = this.botMoves.splice(botIndex, 1);
      if (move) this.dispatch(move.command);
      return true;
    }
    const next = this.nextTimer();
    if (!next) return false;
    const [token] = next;
    this.timers.delete(token);
    this.dispatch({ type: "TIMEOUT", token });
    return true;
  }

  /** Lässt `ms` Zeit vergehen und führt alle bis dahin fälligen Ereignisse aus. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (let at = this.nextEventAt(); at !== undefined && at <= target; at = this.nextEventAt()) {
      this.fireNext();
    }
    this.now = Math.max(this.now, target);
  }

  /** Bis zum Beginn der laufenden Frage vorspulen (fällige Ereignisse dazwischen werden ausgeführt). */
  toQuestionStart(): void {
    const question = currentQuestion(this.state.game);
    if (this.state.phase !== "question" || !question?.startsAt)
      throw new Error(`Keine Frage (Phase ${this.state.phase})`);
    if (this.now < question.startsAt) this.advance(question.startsAt - this.now);
  }

  /** Instanz-ID der laufenden Frage. */
  get questionId(): string {
    const question = currentQuestion(this.state.game);
    if (!question) throw new Error("Keine Frage");
    return question.instanceId;
  }

  /** Richtige Position der laufenden Frage (nur Test – Server-Geheimnis). */
  get correct(): AnswerIndex {
    const question = currentQuestion(this.state.game);
    if (!question) throw new Error("Keine Frage");
    return question.correct;
  }

  /** Antwort einer Person auf die laufende Frage (zur aktuellen Zeit). */
  answer(guestId: string, choice: AnswerIndex): ReduceResult {
    return this.dispatch({ type: "ANSWER", guestId, questionId: this.questionId, choice });
  }

  /**
   * Spielt bis `game_over` bzw. zur geschlossenen Lobby: In jeder Frage antworten alle aktiven, verbundenen
   * Menschen zum Fragebeginn nach `choose` (`null` = keine Antwort); Kategorien wählt der Timeout
   * (bzw. `pick`), Bots handeln über `planBotMoves`.
   */
  playToEnd(
    choose: (guestId: string, sim: Simulation) => AnswerIndex | null = (_guest, sim) => sim.correct,
    pick?: (guestId: string, sim: Simulation) => string | null,
    maxSteps = 50_000,
  ): void {
    let answeredQuestion: string | null = null;
    let pickedTurn: number | null = null;
    for (let step = 0; step < maxSteps; step++) {
      const state = this.state;
      if (state.closed !== null || state.phase === "game_over") return;
      const turn = state.game?.turns.at(-1);
      if (pick && state.phase === "category_pick" && turn && turn.categoryId === null && pickedTurn !== turn.number) {
        pickedTurn = turn.number;
        const picker = state.players.find((player) => player.playerId === turn.pickerId);
        const categoryId = picker && !picker.isBot ? pick(picker.guestId, this) : null;
        if (picker && categoryId !== null) this.dispatch({ type: "PICK", guestId: picker.guestId, categoryId });
        continue;
      }
      const question = currentQuestion(state.game);
      if (state.phase === "question" && question && answeredQuestion !== question.instanceId) {
        answeredQuestion = question.instanceId;
        this.toQuestionStart();
        if (this.state.phase !== "question") continue;
        const participants = this.state.game?.turns.at(-1)?.participantIds ?? [];
        for (const player of this.state.players) {
          if (player.isBot || player.left || !player.connected || player.status !== "active") continue;
          if (!participants.includes(player.playerId)) continue;
          const choice = choose(player.guestId, this);
          if (choice !== null) this.answer(player.guestId, choice);
        }
        continue;
      }
      if (!this.fireNext()) return;
    }
    throw new Error("playToEnd: maxSteps überschritten");
  }

  /** Löst Timer aus, bis `predicate` gilt (höchstens `maxSteps`). */
  runUntil(predicate: (state: LobbyState) => boolean, maxSteps = 20_000): void {
    for (let i = 0; i < maxSteps; i++) {
      if (predicate(this.state)) return;
      if (!this.fireNext()) break;
    }
    if (!predicate(this.state)) throw new Error(`Bedingung nicht erreicht (Phase ${this.state.phase})`);
  }

  /** Neue menschliche Person tritt bei; liefert ihre guestId. */
  join(name: string): string {
    const guestId = this.nextGuestId();
    this.ok({ type: "JOIN", guestId, name });
    this.guests.push(guestId);
    return guestId;
  }

  /** Host fügt einen Bot hinzu; liefert dessen guestId. */
  addBot(): string {
    this.ok({ type: "ADD_BOT", guestId: this.host });
    const bot = this.state.players.at(-1);
    if (!bot?.isBot) throw new Error("Bot fehlt");
    return bot.guestId;
  }

  get host(): string {
    const host = this.state.players.find((player) => player.playerId === this.state.hostPlayerId);
    if (!host) throw new Error("Kein Host");
    return host.guestId;
  }

  playerId(guestId: string): string {
    const player = findPlayerByGuestId(this.state, guestId);
    if (!player) throw new Error(`Unbekannter Gast ${guestId}`);
    return player.playerId;
  }

  guestOf(playerId: string): string {
    const player = this.state.players.find((entry) => entry.playerId === playerId);
    if (!player) throw new Error(`Unbekannte Person ${playerId}`);
    return player.guestId;
  }

  /** Effects eines Typs seit Index `from` in `effects`. */
  effectsOf<T extends Effect["type"]>(type: T, from = 0): Array<Extract<Effect, { type: T }>> {
    return this.effects.slice(from).filter((effect): effect is Extract<Effect, { type: T }> => effect.type === type);
  }
}

/** Lobby mit `humans` Menschen (inkl. Host) und `bots` Bots. */
export function lobbyWith(humans: number, bots = 0, options: SimulationOptions = {}): Simulation {
  const sim = new Simulation(options);
  const names = ["Ben", "Lea", "Tom", "Ida", "Max", "Zoe", "Kai"];
  for (let i = 1; i < humans; i++) sim.join(names[i - 1] ?? `Gast ${i}`);
  for (let i = 0; i < bots; i++) sim.addBot();
  return sim;
}
