/**
 * Dev-Bots im Server-Prozess (docs/05 §Dev-Bots, nur mit `DEV_BOTS_ENABLED=true` hinzufügbar): Nach jedem
 * Command, der `state.phaseToken` ändert, plant `planBotMoves` die Aktionen der Bots für die neue Phase
 * (Kategoriewahl nach 10–40 % der Wahlzeit, Antworten nach 10–60 % der Antwortzeit mit sinkender
 * Trefferquote). Die bisher geplanten Bot-Timer werden dabei verworfen; die neuen Commands werden zum
 * Zeitpunkt `at` in die Warteschlange der Lobby eingereiht – wie jede andere Aktion, also strikt seriell.
 *
 * Ablehnungen sind normal (z. B. `TOO_LATE`, wenn alle Menschen schon geantwortet haben und die Frage früh
 * aufgelöst wurde) und werden nur auf Debug-Level geloggt.
 */
import { type Command, type LobbyState, planBotMoves, type Rng } from "@quizmaster/game-engine";
import type { ErrorCode } from "@quizmaster/shared";
import { createTimerSet } from "../lobby/timers.ts";
import type { Logger } from "../logger.ts";
import type { Clock } from "../registry/types.ts";

export interface BotDispatchResult {
  ok: boolean;
  error?: { code: ErrorCode; message: string };
}

export interface BotDriverDeps {
  clock: Clock;
  rng: Rng;
  logger: Logger;
  /** Reiht einen Bot-Command in die Warteschlange der Lobby ein. */
  dispatch(command: Command): Promise<BotDispatchResult>;
}

export interface BotDriver {
  /** Nach einem erfolgreichen Command: bei geändertem `phaseToken` die Bot-Aktionen neu planen. */
  afterCommand(before: LobbyState, after: LobbyState): void;
  /** Plant die Bot-Aktionen der aktuellen Phase neu (z. B. nach einer Wiederaufnahme). */
  replan(state: LobbyState): void;
  /** Verwirft alle geplanten Bot-Aktionen. */
  stop(): void;
  /** Anzahl geplanter Bot-Aktionen. */
  readonly planned: number;
}

export function createBotDriver(deps: BotDriverDeps): BotDriver {
  const timers = createTimerSet<number>(deps.clock);

  const run = (command: Command) => {
    deps
      .dispatch(command)
      .then((result) => {
        if (!result.ok) {
          deps.logger.debug({ command: command.type, code: result.error?.code }, "Bot-Aktion abgelehnt");
        }
      })
      .catch((error: unknown) => {
        deps.logger.error({ err: error, command: command.type }, "Bot-Aktion fehlgeschlagen");
      });
  };

  const replan = (state: LobbyState) => {
    timers.clear();
    if (state.closed !== null) return;
    const moves = planBotMoves(state, deps.rng);
    moves.forEach((move, index) => {
      timers.set(index, move.at, () => run(move.command));
    });
  };

  return {
    afterCommand(before, after) {
      if (after.phaseToken !== before.phaseToken || after.closed !== null) replan(after);
    },
    replan,
    stop: () => timers.clear(),
    get planned() {
      return timers.size;
    },
  };
}
