/**
 * Timer einer Lobby (docs/07 §Realtime-Server: „ein setTimeout pro Lobby-Phase, kein globales Polling“).
 * Je Schlüssel (Engine-Token bzw. geplante Bot-Aktion) genau ein `setTimeout`; ein erneutes `set` mit
 * demselben Schlüssel ersetzt den alten Timer. Fällige Timer rufen nur ihren Rückruf auf – der LobbyActor
 * reiht darin den passenden Command in seine Warteschlange ein und ruft nie selbst `reduce` auf.
 *
 * Die Verzögerung rechnet mit der Uhr der App (`Clock`, in Tests ersetzbar). Timer sind `unref()`: ein
 * wartender Lobby-Timer hält den Prozess nicht am Leben (das tut der HTTP-Server).
 */
import type { Clock } from "../registry/types.ts";

/** Größte Verzögerung eines `setTimeout` in Node (2^31 − 1 ms); spätere Fälligkeiten werden neu gestellt. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export interface TimerSet<K> {
  /** Stellt einen Timer auf den Zeitpunkt `at` (Uhr der App); ersetzt einen bestehenden mit gleichem Schlüssel. */
  set(key: K, at: number, run: () => void): void;
  /** Löscht einen Timer; `false`, wenn es ihn nicht (mehr) gab. */
  cancel(key: K): boolean;
  /** Löscht alle Timer. */
  clear(): void;
  has(key: K): boolean;
  readonly size: number;
}

export function createTimerSet<K>(clock: Clock): TimerSet<K> {
  const timers = new Map<K, ReturnType<typeof setTimeout>>();

  const arm = (key: K, at: number, run: () => void): void => {
    const delay = Math.max(0, at - clock.now());
    const handle = setTimeout(
      () => {
        if (timers.get(key) !== handle) return;
        if (delay > MAX_TIMEOUT_MS) {
          arm(key, at, run);
          return;
        }
        timers.delete(key);
        run();
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
    handle.unref();
    timers.set(key, handle);
  };

  return {
    set(key, at, run) {
      const existing = timers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      arm(key, at, run);
    },
    cancel(key) {
      const existing = timers.get(key);
      if (existing === undefined) return false;
      clearTimeout(existing);
      timers.delete(key);
      return true;
    },
    clear() {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    },
    has: (key) => timers.has(key),
    get size() {
      return timers.size;
    },
  };
}
