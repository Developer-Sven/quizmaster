"use client";

import { de } from "../../i18n/de";
import { timerState, timerStyle } from "../../lib/ui/timer";
import { TimerAnnouncer } from "../../lib/ui/timer-announcer";

export interface TimerBarProps {
  /**
   * Restzeit beim (Neu-)Start in ms, z. B. `deadline − (Date.now() + offset)`. Nur bei Phasenstart
   * oder Resync neu berechnen – jede Wertänderung startet die Animation neu.
   */
  remainingMs: number;
  /** Gesamtdauer in ms (Antwortzeit 20 000) */
  durationMs: number;
  /** Screenreader-Ansage bei 10 und 5 s (Standard an) */
  announce?: boolean;
}

/**
 * TimerBar (docs/09 §5): 6 px hoch, volle Breite, `primary`, letzte 5 s `danger`. Läuft als reine
 * CSS-Animation (`scaleX` → 0) über die Restzeit – keine Re-Render-Schleife (docs/07). Bleibt bei
 * reduzierter Bewegung aktiv (Information).
 */
export function TimerBar({ remainingMs, durationMs, announce = true }: TimerBarProps) {
  const state = timerState(remainingMs, durationMs);
  const runKey = `${state.remainingMs}/${durationMs}`;
  return (
    <>
      <div role="timer" aria-label={de.a11y.timer} className="h-1.5 w-full overflow-hidden bg-line">
        {state.expired ? null : (
          <div key={runKey} style={timerStyle(state)} className="h-full w-full bg-primary animate-timer-bar" />
        )}
      </div>
      {announce && !state.expired ? <TimerAnnouncer key={runKey} remainingMs={state.remainingMs} /> : null}
    </>
  );
}
