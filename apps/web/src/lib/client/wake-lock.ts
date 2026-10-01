"use client";

/**
 * Bildschirm-Sperre verhindern, solange ein Spiel läuft (docs/10 §App-Gefühl): `navigator.wakeLock.request
 * ("screen")` mit Feature-Erkennung. Der Browser gibt die Sperre selbst frei, sobald die Seite verborgen ist –
 * bei `visibilitychange` (wieder sichtbar) wird sie deshalb neu angefordert. Beim Verlassen des Spiels
 * (Spielende, Lobby, Seitenwechsel) wird sie freigegeben. Ablehnungen (Energiesparmodus, Berechtigung) sind
 * kein Fehler des Spiels: einmal melden, ohne Sperre weiterspielen.
 */
import { useEffect } from "react";

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface WakeLockDeps {
  /** `navigator.wakeLock` oder `null`, wenn der Browser die API nicht kennt */
  wakeLock: WakeLockLike | null;
  document: VisibilitySource;
  warn: (message: string) => void;
}

export interface WakeLockController {
  /** Sperre gewünscht (läuft ein Spiel)? Fordert an bzw. gibt frei. */
  setActive(active: boolean): void;
  /** Hält gerade eine Sperre */
  readonly held: boolean;
  /** Freigeben und Listener entfernen (Ende des Spiels, Verlassen der Seite) */
  dispose(): void;
}

export function createWakeLockController(deps: WakeLockDeps): WakeLockController {
  let active = false;
  let disposed = false;
  let pending = false;
  let sentinel: WakeLockSentinelLike | null = null;

  const onRelease = () => {
    // Vom Browser freigegeben (Seite verborgen) – bei Rückkehr neu anfordern.
    sentinel?.removeEventListener("release", onRelease);
    sentinel = null;
  };

  function acquire(): void {
    const api = deps.wakeLock;
    if (!api || !active || disposed || pending || sentinel !== null) return;
    if (deps.document.visibilityState !== "visible") return;
    pending = true;
    api.request("screen").then(
      (lock) => {
        pending = false;
        if (!active || disposed) {
          void lock.release().catch(reportRelease);
          return;
        }
        sentinel = lock;
        lock.addEventListener("release", onRelease);
      },
      (error: unknown) => {
        pending = false;
        deps.warn(`Bildschirmsperre nicht verhindert: ${error instanceof Error ? error.name : "unbekannt"}`);
      },
    );
  }

  function reportRelease(error: unknown): void {
    deps.warn(`Bildschirmsperre nicht freigegeben: ${error instanceof Error ? error.name : "unbekannt"}`);
  }

  function release(): void {
    const lock = sentinel;
    if (!lock) return;
    lock.removeEventListener("release", onRelease);
    sentinel = null;
    if (!lock.released) void lock.release().catch(reportRelease);
  }

  const onVisibility = () => {
    if (deps.document.visibilityState === "visible") acquire();
  };
  deps.document.addEventListener("visibilitychange", onVisibility);

  return {
    setActive(next) {
      active = next;
      if (next) acquire();
      else release();
    },
    get held() {
      return sentinel !== null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      deps.document.removeEventListener("visibilitychange", onVisibility);
      release();
    },
  };
}

const warned = new Set<string>();

function browserDeps(): WakeLockDeps {
  return {
    wakeLock: "wakeLock" in navigator ? navigator.wakeLock : null,
    document,
    warn(message) {
      if (warned.has(message)) return;
      warned.add(message);
      console.warn(message);
    },
  };
}

/** Hält den Bildschirm wach, solange `active` (laufendes Spiel); gibt beim Ende oder Unmount frei. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const controller = createWakeLockController(browserDeps());
    controller.setActive(true);
    return () => controller.dispose();
  }, [active]);
}
