/**
 * Timer-Verwaltung (docs/02 „Timer mit Token“). Geplante Timer stehen im Zustand (`timers`); die Effects
 * `scheduleTimer`/`cancelTimer` leitet `reduce` aus dem Unterschied alter/neuer Zustand ab. Jeder Timer
 * bekommt ein neues, eindeutiges Token – ein `TIMEOUT` mit unbekanntem Token ist veraltet und wird ignoriert.
 */
import { allocateToken } from "./state.ts";
import type { LobbyState, PendingTimer, TimerKind } from "./types.ts";

export function findTimer(
  state: LobbyState,
  kind: TimerKind,
  playerId: string | null = null,
): PendingTimer | undefined {
  return state.timers.find((timer) => timer.kind === kind && timer.playerId === playerId);
}

export function findTimerByToken(state: LobbyState, token: number): PendingTimer | undefined {
  return state.timers.find((timer) => timer.token === token);
}

/** Plant einen Timer mit neuem Token. */
export function addTimer(state: LobbyState, kind: TimerKind, at: number, playerId: string | null = null): LobbyState {
  const [next, token] = allocateToken(state);
  return { ...next, timers: [...next.timers, { token, kind, at, playerId }] };
}

/** Entfernt Timer (z. B. hinfällige Fristen). */
export function removeTimers(state: LobbyState, predicate: (timer: PendingTimer) => boolean): LobbyState {
  if (!state.timers.some(predicate)) return state;
  return { ...state, timers: state.timers.filter((timer) => !predicate(timer)) };
}

/**
 * Gleicht einen Timer (Art + Person) mit dem Sollzustand ab: `desiredAt = null` → entfernen; gleicher
 * Zeitpunkt → behalten; sonst durch einen neuen Timer (neues Token) ersetzen.
 */
export function syncTimer(
  state: LobbyState,
  kind: TimerKind,
  playerId: string | null,
  desiredAt: number | null,
): LobbyState {
  const existing = findTimer(state, kind, playerId);
  if (desiredAt === null) {
    return existing ? removeTimers(state, (timer) => timer.token === existing.token) : state;
  }
  if (existing?.at === desiredAt) return state;
  const cleared = existing ? removeTimers(state, (timer) => timer.token === existing.token) : state;
  return addTimer(cleared, kind, desiredAt, playerId);
}
