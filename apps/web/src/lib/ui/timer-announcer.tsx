"use client";

import { useEffect, useState } from "react";
import { de } from "../../i18n/de";
import { timerAnnouncements } from "./timer";

/**
 * Screenreader-Ansage der Restzeit nur bei 10 und 5 Sekunden (docs/09 §7). `role="timer"` selbst
 * ist nicht live, deshalb eine eigene höfliche Live-Region neben dem Timer.
 */
export function TimerAnnouncer({ remainingMs }: { remainingMs: number }) {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const timeouts = timerAnnouncements(remainingMs).map(({ seconds, delayMs }) =>
      window.setTimeout(() => setMessage(de.a11y.secondsLeft(seconds)), delayMs),
    );
    return () => {
      for (const timeout of timeouts) window.clearTimeout(timeout);
    };
  }, [remainingMs]);
  return (
    <span className="sr-only" aria-live="polite" aria-atomic="true">
      {message}
    </span>
  );
}
