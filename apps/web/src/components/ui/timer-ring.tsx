"use client";

import { useEffect, useState } from "react";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { secondsLeft, timerState, timerStyle } from "../../lib/ui/timer";
import { TimerAnnouncer } from "../../lib/ui/timer-announcer";

export interface TimerRingProps {
  /** Restzeit beim (Neu-)Start in ms; nur bei Phasenstart oder Resync neu berechnen */
  remainingMs: number;
  /** Gesamtdauer in ms (Kategoriewahl 15 000) */
  durationMs: number;
  /** Screenreader-Ansage bei 10 und 5 s (Standard an) */
  announce?: boolean;
}

/**
 * TimerRing (docs/09 §5): Kreis 48, Strich 4 (`primary`, letzte 5 s `danger`) auf `line`,
 * Sekundenzahl (`label`, tabular) in der Mitte. Der Ring läuft als CSS-Animation über
 * `stroke-dashoffset`; nur die kleine Zahl aktualisiert sich einmal pro Sekunde.
 */
export function TimerRing({ remainingMs, durationMs, announce = true }: TimerRingProps) {
  const state = timerState(remainingMs, durationMs);
  const runKey = `${state.remainingMs}/${durationMs}`;
  return (
    <>
      <div
        role="timer"
        aria-label={de.a11y.timer}
        style={timerStyle(state)}
        className="relative flex size-12 shrink-0 items-center justify-center"
      >
        <svg viewBox="0 0 48 48" aria-hidden="true" className="absolute inset-0 size-12 -rotate-90">
          <circle cx="24" cy="24" r="22" fill="none" strokeWidth="4" className="stroke-line" />
          {state.expired ? null : (
            <circle
              key={runKey}
              cx="24"
              cy="24"
              r="22"
              fill="none"
              strokeWidth="4"
              pathLength={100}
              strokeDasharray="100"
              className="stroke-primary animate-timer-ring"
            />
          )}
        </svg>
        <TimerSeconds key={runKey} remainingMs={state.remainingMs} />
      </div>
      {announce && !state.expired ? <TimerAnnouncer key={runKey} remainingMs={state.remainingMs} /> : null}
    </>
  );
}

/** Kleines isoliertes Element für die Sekundenzahl (requestAnimationFrame, docs/07). */
function TimerSeconds({ remainingMs }: { remainingMs: number }) {
  const [seconds, setSeconds] = useState(() => secondsLeft(remainingMs));
  useEffect(() => {
    const endsAt = performance.now() + remainingMs;
    let frame = 0;
    const tick = () => {
      const left = secondsLeft(endsAt - performance.now());
      setSeconds(left);
      if (left > 0) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [remainingMs]);
  return (
    <span
      className={cx("relative text-label tabular-nums", seconds > 0 ? "text-text animate-timer-text" : "text-danger")}
    >
      {seconds}
    </span>
  );
}
