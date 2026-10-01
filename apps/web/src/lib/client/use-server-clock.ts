"use client";

import { useEffect, useState } from "react";
import { selectOffset, useGameStore } from "../../stores/game-store";
import { useClientClock } from "./clock-context";
import { toServerTime } from "./phase-clock";

/**
 * Serverzeit in ms (`Date.now() + offset`), die sich genau an den übergebenen Serverzeitpunkten neu
 * setzt – plus beim Mounten und wenn sich der Offset ändert. So wechseln Overlays deterministisch zur
 * selben Zeit wie bei allen anderen, ohne Re-Render-Schleife (docs/07 §Frontend, ADR-020).
 */
export function useServerNow(boundaries: readonly number[]): number {
  const offset = useGameStore(selectOffset);
  const { now: clock, frozen } = useClientClock();
  const [now, setNow] = useState(() => toServerTime(clock(), offset));
  const key = boundaries.filter((value) => Number.isFinite(value)).join(",");

  useEffect(() => {
    const times = key === "" ? [] : key.split(",").map(Number);
    const current = toServerTime(clock(), offset);
    setNow(current);
    if (frozen) return;
    // Aufgerundet und auf den Zielzeitpunkt begrenzt: `setTimeout` kürzt Bruchteile von Millisekunden, der
    // Timer darf den Übergang daher nie knapp verfehlen (sonst bliebe die Bühne im alten Overlay stehen).
    const timers = times
      .filter((time) => time > current)
      .map((time) =>
        window.setTimeout(() => setNow(Math.max(time, toServerTime(clock(), offset))), Math.ceil(time - current)),
      );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [offset, key, clock, frozen]);

  return now;
}

/**
 * Restzeit bis zu einem Client-Zeitpunkt, einmal pro Sekunde aktualisiert (Frist-Countdown im
 * Verbindungs-Overlay). `null` ohne Ziel – abgeleitet statt per setState im Effect; ein Wert gilt nur für das
 * Ziel, zu dem er berechnet wurde (bis der Effect das neue Ziel misst, `null` wie bisher).
 */
export function useCountdown(untilClientMs: number | null): number | null {
  const { now: clock } = useClientClock();
  const [tick, setTick] = useState<{ until: number; remaining: number } | null>(() =>
    untilClientMs === null ? null : { until: untilClientMs, remaining: Math.max(0, untilClientMs - clock()) },
  );

  useEffect(() => {
    if (untilClientMs === null) return;
    const update = () => setTick({ until: untilClientMs, remaining: Math.max(0, untilClientMs - clock()) });
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [untilClientMs, clock]);

  return untilClientMs !== null && tick?.until === untilClientMs ? tick.remaining : null;
}

/** Zähler, der alle `intervalMs` steigt, solange `active` (z. B. wandernder Rahmen der Kategoriewahl). */
export function useTicker(intervalMs: number, active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, active]);
  return tick;
}
