"use client";

import { useState } from "react";
import { de } from "../../i18n/de";
import { timerState, timerStyle } from "../../lib/ui/timer";
import { TimerAnnouncer } from "../../lib/ui/timer-announcer";

export interface TimerBarProps {
  /**
   * Identität des Timer-Laufs, z. B. `phaseStartedAt` oder `${round}-${turn}-${question}`. Nur ein
   * neuer Wert startet die Animation neu – auch beim Resync nach einem Reconnect einen neuen Wert
   * vergeben. Spätere Änderungen von `remainingMs`/`durationMs` im selben Lauf werden ignoriert.
   */
  runId: string | number;
  /** Restzeit beim Start des Laufs in ms, z. B. `deadline − (Date.now() + offset)` */
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
export function TimerBar({ runId, ...run }: TimerBarProps) {
  return <TimerBarRun key={runId} {...run} />;
}

/** Ein Lauf: Startwerte beim Mount eingefroren, damit Re-Renders der Eltern den Timer nicht zurücksetzen. */
function TimerBarRun({ remainingMs, durationMs, announce = true }: Omit<TimerBarProps, "runId">) {
  const [state] = useState(() => timerState(remainingMs, durationMs));
  return (
    <>
      {/* Spur mit Rahmen im Kontrastmodus: die Fläche wird dort zu Canvas, die volle Länge bleibt so sichtbar */}
      <div
        role="timer"
        aria-label={de.a11y.timer}
        className="h-1.5 w-full overflow-hidden bg-line forced-colors:outline forced-colors:-outline-offset-1"
      >
        {state.expired ? null : <div style={timerStyle(state)} className="h-full w-full animate-timer-bar" />}
      </div>
      {announce && !state.expired ? <TimerAnnouncer remainingMs={state.remainingMs} /> : null}
    </>
  );
}
