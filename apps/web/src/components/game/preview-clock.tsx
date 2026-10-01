"use client";

import { type ReactNode, useEffect, useState } from "react";
import { FrozenClockProvider, useClientClock } from "@/lib/client/clock-context";

/** Schrittweite der laufenden Vorschau-Uhr (20 Bilder/s genügen für die Zeitpunkte der Choreografie). */
export const PREVIEW_CLOCK_STEP_MS = 50;

/** URL-Parameter der Vorschau: `clock=play` lässt die Uhr ab dem eingefrorenen Zeitpunkt laufen. */
export const PREVIEW_CLOCK_PARAM = "clock";

/** Soll die eingefrorene Vorschau-Uhr laufen? (`?clock=play`) */
export function previewClockPlays(search: string): boolean {
  return new URLSearchParams(search).get(PREVIEW_CLOCK_PARAM) === "play";
}

/**
 * Uhr der Spiel-Vorschau (/dev/game, docs/09 §7): Standard ist die eingefrorene Uhr der Vorschau (ein fester
 * Moment für Screenshots). Mit `?clock=play` läuft sie ab diesem Moment weiter, sodass die Choreografie in
 * Echtzeit abläuft (Intro-Titelkarte, Ausblenden, wandernder Rahmen …). Wirkt nur unter einer eingefrorenen
 * Uhr – im echten Spiel (nie eingefroren) gibt die Komponente ihren Inhalt unverändert zurück.
 */
export function PreviewClock({ children }: { children: ReactNode }) {
  const outer = useClientClock();
  const [playFrom] = useState(() =>
    outer.frozen && typeof window !== "undefined" && previewClockPlays(window.location.search) ? outer.now() : null,
  );
  if (playFrom === null) return children;
  return <PlayingClock from={playFrom}>{children}</PlayingClock>;
}

/** Eingefrorene Uhr, deren Zeitpunkt in kleinen Schritten mitläuft (wie eine echte Uhr ab `from`). */
function PlayingClock({ from, children }: { from: number; children: ReactNode }) {
  const [at, setAt] = useState(from);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setAt(from + (performance.now() - started)), PREVIEW_CLOCK_STEP_MS);
    return () => window.clearInterval(timer);
  }, [from]);
  return <FrozenClockProvider at={at}>{children}</FrozenClockProvider>;
}
