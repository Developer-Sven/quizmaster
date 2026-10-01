/**
 * Spiel-Sounds (docs/09 §10): sieben kurze, weiche Klänge aus `public/sounds/` (eigene Synthesen, CC0,
 * erzeugt von `scripts/generate-sounds.ts`, Pegel −12 dBFS in den Dateien – abgespielt wird mit Verstärkung 1).
 *
 * - **Lazy:** Die Dateien werden erst geladen, wenn das Spiel sie braucht (`preload()` beim Spielstart bzw.
 *   beim Einschalten), nie auf der Startseite.
 * - **Entsperren (iOS):** Der `AudioContext` entsteht erst in bzw. nach einer Interaktion (`unlock()` in einem
 *   Gesten-Handler; `armUnlock()` hängt die Handler an). Hat die Seite schon eine Interaktion gesehen (sticky
 *   activation), wird sofort entsperrt – Browser ohne diese Regel (Safari) entsperren bei der nächsten Geste.
 * - **Ton an/aus:** Standard an, gespeichert über `storage.ts` (`setEnabled` ist der Umschalter im HUD).
 * - Format: Opus in WebM, wo unterstützt, sonst MP3 (scheitert das Dekodieren, einmal MP3 als Ersatz).
 * - Gespielt wird nur bei sichtbarer Seite; ein Sound, der beim Abspielen noch nicht dekodiert ist, entfällt
 *   (ein verspäteter Ton wäre falscher als keiner).
 */
import { readStoredSoundOn, writeStoredSoundOn } from "./storage";

export const SOUND_NAMES = ["lock", "tick", "correct", "wrong", "turn", "win", "lose"] as const;
export type SoundName = (typeof SOUND_NAMES)[number];
export type SoundFormat = "webm" | "mp3";

/** Pfad einer Sound-Datei (statisch aus `public/sounds/`, gleiche Origin – CSP `connect-src 'self'`). */
export function soundUrl(name: SoundName, format: SoundFormat): string {
  return `/sounds/${name}.${format}`;
}

/** Opus in WebM, wenn der Browser es abspielen kann, sonst MP3. */
export function preferredFormat(canPlayType: (mime: string) => string): SoundFormat {
  const support = canPlayType('audio/webm; codecs="opus"');
  return support === "probably" || support === "maybe" ? "webm" : "mp3";
}

/** Minimale Audio-Schnittstelle (Web Audio API), austauschbar für Tests. `B` = dekodierter Puffer. */
export interface AudioEngine<B> {
  /** `suspended` | `running` | `closed` (Safari zusätzlich `interrupted`) */
  readonly state: string;
  resume(): Promise<void>;
  decode(data: ArrayBuffer): Promise<B>;
  /** Spielt einen Puffer sofort ab und liefert eine Stopp-Funktion. */
  start(buffer: B): () => void;
  /** Spielt einen stillen Puffer – auf iOS entsperrt erst das die Ausgabe innerhalb der Geste. */
  primeSilence(): void;
}

export interface SoundManagerDeps<B> {
  /** Erzeugt den Audio-Kontext; `null`, wenn der Browser keine Web Audio API hat. */
  createEngine: () => AudioEngine<B> | null;
  fetchSound: (url: string) => Promise<ArrayBuffer>;
  canPlayType: (mime: string) => string;
  readEnabled: () => boolean;
  writeEnabled: (enabled: boolean) => void;
  /** Hat die Seite schon eine Nutzer-Interaktion gesehen (`navigator.userActivation.hasBeenActive`)? */
  hasUserActivation: () => boolean;
  isVisible: () => boolean;
  warn: (message: string) => void;
}

export interface SoundManager {
  /** Ton an (Standard) oder aus */
  readonly enabled: boolean;
  /** Audio-Ausgabe entsperrt (Kontext läuft) */
  readonly unlocked: boolean;
  /** Ton an/aus (Umschalter im HUD); speichert die Einstellung. Aus stoppt laufende Sounds. */
  setEnabled(enabled: boolean): void;
  /** In einem Gesten-Handler aufrufen: erzeugt bzw. startet den Audio-Kontext. */
  unlock(): void;
  /** Lädt alle Sounds (dekodiert, sobald entsperrt). Ohne Wirkung bei Ton aus. */
  preload(): void;
  /** Spielt einen Sound; `false`, wenn aus, nicht entsperrt, Seite verborgen oder noch nicht geladen. */
  play(name: SoundName): boolean;
  /** Entsperrt bei der ersten Interaktion (bzw. sofort nach einer früheren). Liefert die Abmeldung. */
  armUnlock(target: EventTarget): () => void;
}

/** Ereignisse, die als Nutzer-Geste zählen und Audio entsperren dürfen (iOS: touchend/click). */
const UNLOCK_EVENTS = ["pointerdown", "touchend", "click", "keydown"] as const;

/** Höchstens so viele laufende Sounds merken (zum Stoppen bei „Ton aus“). */
const MAX_TRACKED_SOURCES = 8;

export function createSoundManager<B>(deps: SoundManagerDeps<B>): SoundManager {
  let enabled = deps.readEnabled();
  let engine: AudioEngine<B> | null = null;
  let format: SoundFormat | null = null;
  const raw = new Map<string, Promise<ArrayBuffer | null>>();
  const decoded = new Map<SoundName, B>();
  const decoding = new Map<SoundName, Promise<void>>();
  const stops: Array<() => void> = [];

  const running = () => engine !== null && engine.state === "running";
  const currentFormat = () => {
    format ??= preferredFormat(deps.canPlayType);
    return format;
  };

  /** Lädt die Rohdaten einer Datei einmal (Fehler → `null`, mit Hinweis). */
  function fetchRaw(name: SoundName, fileFormat: SoundFormat): Promise<ArrayBuffer | null> {
    const url = soundUrl(name, fileFormat);
    let pending = raw.get(url);
    if (!pending) {
      pending = deps.fetchSound(url).catch((error: unknown) => {
        deps.warn(`Sound ${name}.${fileFormat} nicht geladen: ${describe(error)}`);
        raw.delete(url);
        return null;
      });
      raw.set(url, pending);
    }
    return pending;
  }

  async function decodeWith(name: SoundName, fileFormat: SoundFormat): Promise<boolean> {
    const data = await fetchRaw(name, fileFormat);
    if (!data || !engine) return false;
    try {
      // decodeAudioData übernimmt (detacht) den Puffer – deshalb eine Kopie
      decoded.set(name, await engine.decode(data.slice(0)));
      return true;
    } catch (error) {
      deps.warn(`Sound ${name}.${fileFormat} nicht dekodierbar: ${describe(error)}`);
      return false;
    }
  }

  /** Dekodiert einen Sound (einmal); scheitert WebM, folgt MP3. */
  function decode(name: SoundName): Promise<void> {
    if (decoded.has(name) || !running()) return Promise.resolve();
    let pending = decoding.get(name);
    if (!pending) {
      const preferred = currentFormat();
      pending = decodeWith(name, preferred)
        .then(async (ok) => {
          if (!ok && preferred === "webm") await decodeWith(name, "mp3");
        })
        .finally(() => decoding.delete(name));
      decoding.set(name, pending);
    }
    return pending;
  }

  function decodeAll(): void {
    if (!enabled) return;
    for (const name of SOUND_NAMES) void decode(name);
  }

  function stopAll(): void {
    for (const stop of stops.splice(0)) stop();
  }

  function unlock(): void {
    engine ??= deps.createEngine();
    if (!engine) return;
    engine.primeSilence();
    if (running()) {
      decodeAll();
      return;
    }
    engine.resume().then(decodeAll, (error: unknown) => {
      deps.warn(`Audio nicht entsperrt: ${describe(error)}`);
    });
  }

  return {
    get enabled() {
      return enabled;
    },
    get unlocked() {
      return running();
    },
    setEnabled(next) {
      deps.writeEnabled(next);
      if (next === enabled) return;
      enabled = next;
      if (next) decodeAll();
      else stopAll();
    },
    unlock,
    preload() {
      if (!enabled) return;
      const preferred = currentFormat();
      for (const name of SOUND_NAMES) void fetchRaw(name, preferred);
      decodeAll();
    },
    play(name) {
      if (!enabled || !deps.isVisible() || !engine || !running()) return false;
      const buffer = decoded.get(name);
      if (buffer === undefined) {
        void decode(name);
        return false;
      }
      stops.push(engine.start(buffer));
      if (stops.length > MAX_TRACKED_SOURCES) stops.splice(0, stops.length - MAX_TRACKED_SOURCES);
      return true;
    },
    armUnlock(target) {
      if (running()) return () => {};
      if (deps.hasUserActivation()) unlock();
      const onGesture = () => {
        unlock();
        if (running()) detach();
      };
      // Objekt-Optionen statt `true`: manche EventTarget-Implementierungen (Node) entfernen sonst nicht.
      const detach = () => {
        for (const type of UNLOCK_EVENTS) target.removeEventListener(type, onGesture, { capture: true });
      };
      for (const type of UNLOCK_EVENTS) target.addEventListener(type, onGesture, { capture: true, passive: true });
      return detach;
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.name : "unbekannt";
}

// ---------------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------------

interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

/** Web Audio API als {@link AudioEngine} (ein Kontext je Seite). */
function webAudioEngine(): AudioEngine<AudioBuffer> | null {
  const Context = window.AudioContext ?? (window as unknown as WebkitWindow).webkitAudioContext;
  if (!Context) return null;
  const context = new Context({ latencyHint: "interactive" });
  const play = (buffer: AudioBuffer) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    return source;
  };
  return {
    get state() {
      return context.state;
    },
    resume: () => context.resume(),
    decode: (data) => context.decodeAudioData(data),
    start(buffer) {
      const source = play(buffer);
      return () => source.stop();
    },
    primeSilence() {
      play(context.createBuffer(1, 1, context.sampleRate));
    },
  };
}

const warned = new Set<string>();

function browserDeps(): SoundManagerDeps<AudioBuffer> {
  return {
    createEngine: webAudioEngine,
    async fetchSound(url) {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    },
    canPlayType: (mime) => document.createElement("audio").canPlayType(mime),
    readEnabled: readStoredSoundOn,
    writeEnabled: writeStoredSoundOn,
    hasUserActivation: () => navigator.userActivation?.hasBeenActive ?? false,
    isVisible: () => document.visibilityState !== "hidden",
    warn(message) {
      // Jeden Hinweis nur einmal je Seite – ohne Inhalte, nur Dateiname und Fehlerart.
      if (warned.has(message)) return;
      warned.add(message);
      console.warn(message);
    },
  };
}

let manager: SoundManager | null = null;

/** Der Sound-Manager dieser Seite (im Browser); auf dem Server `null`. */
export function getSoundManager(): SoundManager | null {
  if (typeof window === "undefined") return null;
  manager ??= createSoundManager(browserDeps());
  return manager;
}
