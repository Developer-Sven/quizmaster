"use client";

/**
 * React-Anbindung der Choreografie (docs/09 §7–8, §10): Overlay-Uhr mit Einstiegspunkt, Töne/Haptik zu
 * Serverzeitpunkten, Audio-Vorbereitung und das Verhalten der Seite während des Spiels.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useClientClock } from "../../lib/client/clock-context";
import { vibrate } from "../../lib/client/haptics";
import { remainingMs, toServerTime } from "../../lib/client/phase-clock";
import { getSoundManager } from "../../lib/client/sound";
import { useServerNow } from "../../lib/client/use-server-clock";
import { selectOffset, useGameStore } from "../../stores/game-store";
import { type CueScheduler, createCueScheduler, type StageCue } from "./choreography";

/**
 * Uhr eines Overlays: Serverzeit (neu gesetzt an den übergebenen Zeitpunkten) und `enteredAt` – wie viele ms
 * der Anker beim Einhängen schon zurücklag. Damit setzt die Choreografie nach einem Reconnect oder Neuladen
 * mittendrin fort, statt von vorn zu beginnen (siehe choreography.ts).
 */
export function useOverlayClock(anchor: number, boundaries: readonly number[]): { now: number; enteredAt: number } {
  const now = useServerNow(boundaries);
  const [enteredAt] = useState(() => Math.max(0, now - anchor));
  return { now, enteredAt };
}

export interface TimerRun {
  /** Identität des Laufs für TimerBar/TimerRing (neu → Animation startet mit `remainingMs` neu) */
  runId: string;
  /** Restzeit beim Start des Laufs (frisch aus der Uhr), `null` ohne Ziel */
  remainingMs: number | null;
}

/**
 * Lauf eines CSS-Timers (TimerBar/TimerRing) bis `target` (Serverzeit): Wechselt `generation` (z. B. nach
 * einer Wiederaufnahme) oder der Uhren-Offset, startet der Timer mit der dann frisch gelesenen Restzeit neu.
 * Neue Lauf-ID und neue Restzeit kommen im selben Render – sonst startete der Timer mit veralteter Zeit,
 * denn das Overlay bleibt über eine Wiederaufnahme hinweg eingehängt (nichts wird wiederholt).
 */
export function useTimerRun(target: number | null, generation: string): TimerRun {
  const offset = useGameStore(selectOffset);
  const { now: clock } = useClientClock();
  const runId = `${generation}:${offset}`;
  const [run, setRun] = useState<TimerRun>(() => ({
    runId,
    remainingMs: remainingMs(target, toServerTime(clock(), offset)),
  }));
  useEffect(() => {
    if (run.runId === runId) return;
    setRun({ runId, remainingMs: remainingMs(target, toServerTime(clock(), offset)) });
  }, [run.runId, runId, target, clock, offset]);
  return run;
}

/** Kleinste Nachfrist, falls ein Timer knapp vor seinem Zeitpunkt feuert. */
const BOUNDARY_RETRY_MS = 4;

/**
 * Ein aus der Serverzeit abgeleiteter einfacher Wert (z. B. die Stufe der Bühne), der IMMER frisch ist: Er
 * wird bei jedem Rendern aus der aktuellen Uhr berechnet – auch im ersten Render nach einem neuen Zustand
 * (z. B. nach einem Reconnect mitten in der Frage; `useServerNow` hätte dort noch die alte Zeit und würde
 * kurz das falsche Overlay einhängen) – und an den Zeitpunkten `boundaries` neu gerendert.
 * `compute` muss zwischen zwei Zeitpunkten denselben Wert liefern (Vergleich per `Object.is`).
 */
export function useServerMoment<T extends string | number | boolean | null>(
  compute: (serverNow: number) => T,
  boundaries: readonly number[],
): T {
  const offset = useGameStore(selectOffset);
  const { now: clock, frozen } = useClientClock();
  const key = boundaries.filter((value) => Number.isFinite(value)).join(",");
  const subscribe = useCallback(
    (notify: () => void) => {
      if (frozen || key === "") return () => {};
      const serverNow = () => toServerTime(clock(), offset);
      const timers = new Set<number>();
      const arm = (at: number) => {
        const wait = Math.max(BOUNDARY_RETRY_MS, Math.ceil(at - serverNow()));
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          if (serverNow() < at) arm(at);
          else notify();
        }, wait);
        timers.add(timer);
      };
      const current = serverNow();
      for (const at of key.split(",").map(Number)) if (at > current) arm(at);
      return () => {
        for (const timer of timers) window.clearTimeout(timer);
      };
    },
    [key, clock, offset, frozen],
  );
  const snapshot = () => compute(toServerTime(clock(), offset));
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function playCue(cue: StageCue): void {
  getSoundManager()?.play(cue.sound);
  if (cue.haptic) vibrate(cue.haptic);
}

let scheduler: CueScheduler | null = null;

/** Ein Planer je Seite: Cue-IDs bleiben über Phasen, Neuplanungen und Remounts hinweg gemerkt. */
function cueScheduler(): CueScheduler {
  scheduler ??= createCueScheduler({
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    run: playCue,
  });
  return scheduler;
}

/**
 * Plant die Töne und Haptik der aktuellen Phase zu ihren Serverzeitpunkten (docs/09 §7, §10). Jeder Cue feuert
 * höchstens einmal; nach einem Uhrenabgleich wird neu geplant. Die eingefrorene Vorschau (/dev/game) bleibt still.
 */
export function useStageCues(cues: readonly StageCue[]): void {
  const offset = useGameStore(selectOffset);
  const { now: clock, frozen } = useClientClock();
  useEffect(() => {
    if (frozen || cues.length === 0) return;
    return cueScheduler().schedule(cues, () => toServerTime(clock(), offset));
  }, [cues, frozen, clock, offset]);
}

/** Einloggen (docs/09 §7.5): Ton `lock` und Haptik 15 ms – direkt im Tipp-/Tasten-Handler aufrufen. */
export function lockFeedback(): void {
  getSoundManager()?.play("lock");
  vibrate("lock");
}

/**
 * Audio im Spiel (docs/09 §10): entsperrt bei der ersten Interaktion (bzw. sofort nach einer früheren) und lädt
 * die Sounds, solange der Ton an ist. Ob gespielt wird, entscheidet der Sound-Manager (gespeicherte Einstellung).
 */
export function useGameAudio(soundOn: boolean): void {
  useEffect(() => {
    const manager = getSoundManager();
    return manager ? manager.armUnlock(document) : undefined;
  }, []);
  useEffect(() => {
    if (soundOn) getSoundManager()?.preload();
  }, [soundOn]);
}

/**
 * Seite während des Spiels (docs/10 §App-Gefühl): kein Überscrollen/Pull-to-Refresh am Dokument
 * (`overscroll-behavior: none`); beim Verlassen wird der vorige Wert wiederhergestellt.
 */
export function useGameDocument(): void {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overscrollBehavior;
    root.style.overscrollBehavior = "none";
    return () => {
      root.style.overscrollBehavior = previous;
    };
  }, []);
}
