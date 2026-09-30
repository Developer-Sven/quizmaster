import type { CssVariables } from "./cx";

/** Ab dieser Restzeit sind Timer rot (docs/09 §5, §7). */
export const TIMER_DANGER_MS = 5_000;

/** Sekundenmarken, bei denen Screenreader die Restzeit ansagen (docs/09 §7 „Screenreader“). */
export const TIMER_ANNOUNCE_AT_SECONDS = [10, 5] as const;

/** Startwerte einer Timer-Animation aus Restzeit und Gesamtdauer. */
export interface TimerState {
  /** Restzeit in ms, begrenzt auf 0 … Gesamtdauer */
  remainingMs: number;
  /** Anteil der Restzeit an der Gesamtdauer beim Start (1 = voll, 0 = abgelaufen) */
  fraction: number;
  /** Verzögerung bis zum Wechsel auf danger in ms (negativ = schon im roten Bereich) */
  dangerDelayMs: number;
  expired: boolean;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Berechnet den Startzustand; ungültige Werte (NaN, negativ) gelten als abgelaufen. */
export function timerState(remainingMs: number, durationMs: number): TimerState {
  const total = Math.max(1, finiteOrZero(durationMs));
  const remaining = Math.min(total, Math.max(0, finiteOrZero(remainingMs)));
  return {
    remainingMs: remaining,
    fraction: remaining / total,
    dangerDelayMs: remaining - TIMER_DANGER_MS,
    expired: remaining <= 0,
  };
}

/** CSS-Variablen für die Timer-Utilities `animate-timer-*` in globals.css. */
export function timerStyle(state: TimerState): CssVariables {
  return {
    "--timer-remaining": `${state.remainingMs}ms`,
    "--timer-from": String(state.fraction),
    "--timer-danger-delay": `${state.dangerDelayMs}ms`,
  };
}

/** Angezeigte Sekunden: aufgerundet, nie negativ (20 000 ms → 20, 4 001 ms → 5, 0 → 0). */
export function secondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(finiteOrZero(remainingMs) / 1000));
}

/** Geplante Screenreader-Ansagen: nur Marken, die noch vor uns liegen. */
export function timerAnnouncements(remainingMs: number): Array<{ seconds: number; delayMs: number }> {
  const remaining = finiteOrZero(remainingMs);
  return TIMER_ANNOUNCE_AT_SECONDS.map((mark) => ({ seconds: mark, delayMs: remaining - mark * 1000 })).filter(
    (entry) => entry.delayMs >= 0,
  );
}
