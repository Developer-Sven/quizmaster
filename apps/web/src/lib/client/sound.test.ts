import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AudioEngine,
  createSoundManager,
  preferredFormat,
  SOUND_NAMES,
  type SoundManagerDeps,
  soundUrl,
} from "./sound";

/** Puffer der Test-Engine: die geladene URL. */
type FakeBuffer = string;

interface FakeAudio {
  deps: SoundManagerDeps<FakeBuffer>;
  /** erzeugte Engines (der AudioContext entsteht erst beim Entsperren) */
  engines: number;
  /** gestartete Puffer (URLs) */
  started: string[];
  stopped: string[];
  fetched: string[];
  written: boolean[];
  warnings: string[];
  primes: number;
  set(options: { activation?: boolean; visible?: boolean; resumeFails?: boolean }): void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeAudio(
  options: { stored?: boolean; canPlay?: string; undecodable?: readonly string[]; noEngine?: boolean } = {},
): FakeAudio {
  const state = { activation: false, visible: true, resumeFails: false };
  const audio: FakeAudio = {
    engines: 0,
    started: [],
    stopped: [],
    fetched: [],
    written: [],
    warnings: [],
    primes: 0,
    set(next) {
      Object.assign(state, next);
    },
    deps: {
      createEngine: () => {
        if (options.noEngine) return null;
        audio.engines += 1;
        let contextState = "suspended";
        const engine: AudioEngine<FakeBuffer> = {
          get state() {
            return contextState;
          },
          // wie im Browser asynchron: der Kontext läuft erst nach der Geste
          resume: async () => {
            await Promise.resolve();
            if (state.resumeFails) throw new DOMException("not allowed", "NotAllowedError");
            contextState = "running";
          },
          decode: async (data) => {
            const url = new TextDecoder().decode(data);
            if (options.undecodable?.some((part) => url.endsWith(part))) throw new Error("EncodingError");
            return url;
          },
          start: (buffer) => {
            audio.started.push(buffer);
            return () => audio.stopped.push(buffer);
          },
          primeSilence: () => {
            audio.primes += 1;
          },
        };
        return engine;
      },
      fetchSound: async (url) => {
        audio.fetched.push(url);
        return new TextEncoder().encode(url).buffer;
      },
      canPlayType: () => options.canPlay ?? "probably",
      readEnabled: () => options.stored ?? true,
      writeEnabled: (enabled) => audio.written.push(enabled),
      hasUserActivation: () => state.activation,
      isVisible: () => state.visible,
      warn: (message) => audio.warnings.push(message),
    },
  };
  return audio;
}

describe("Sound-Manager: Entsperren (iOS) und Laden", () => {
  it("erzeugt den Audio-Kontext erst beim Entsperren und spielt vorher nichts", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    sound.preload();
    await flush();
    expect(audio.engines).toBe(0);
    expect(audio.fetched).toHaveLength(SOUND_NAMES.length);
    expect(sound.play("lock")).toBe(false);

    sound.unlock();
    expect(audio.engines).toBe(1);
    expect(audio.primes).toBe(1);
    await flush();
    expect(sound.unlocked).toBe(true);
    expect(sound.play("lock")).toBe(true);
    expect(audio.started).toEqual(["/sounds/lock.webm"]);
  });

  it("entsperrt bei der ersten Geste (pointerdown, touchend, click, keydown) und meldet sich danach ab", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    const target = new EventTarget();
    const detach = sound.armUnlock(target);
    expect(audio.engines).toBe(0);
    target.dispatchEvent(new Event("touchend"));
    expect(audio.engines).toBe(1);
    expect(sound.unlocked).toBe(false);
    await flush();
    expect(sound.unlocked).toBe(true);
    // nächste Geste: entsperrt läuft – die Handler melden sich ab
    target.dispatchEvent(new Event("pointerdown"));
    expect(audio.primes).toBe(2);
    target.dispatchEvent(new Event("click"));
    target.dispatchEvent(new Event("keydown"));
    expect(audio.primes).toBe(2);
    expect(audio.engines).toBe(1);
    detach();
  });

  it("meldet die Handler ab, wenn das Spiel vorher endet", () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    const target = new EventTarget();
    sound.armUnlock(target)();
    target.dispatchEvent(new Event("click"));
    expect(audio.engines).toBe(0);
  });

  it("entsperrt sofort, wenn die Seite schon eine Interaktion hatte (sticky activation)", async () => {
    const audio = fakeAudio();
    audio.set({ activation: true });
    const sound = createSoundManager(audio.deps);
    sound.armUnlock(new EventTarget());
    expect(audio.engines).toBe(1);
    await flush();
    expect(sound.unlocked).toBe(true);
  });

  it("meldet ein gescheitertes Entsperren (ohne Absturz) und versucht es bei der nächsten Geste erneut", async () => {
    const audio = fakeAudio();
    audio.set({ resumeFails: true });
    const sound = createSoundManager(audio.deps);
    const target = new EventTarget();
    sound.armUnlock(target);
    target.dispatchEvent(new Event("click"));
    await flush();
    expect(sound.unlocked).toBe(false);
    expect(audio.warnings.some((message) => message.includes("NotAllowedError"))).toBe(true);
    audio.set({ resumeFails: false });
    target.dispatchEvent(new Event("click"));
    await flush();
    expect(sound.unlocked).toBe(true);
  });

  it("lädt Opus/WebM, wo möglich, sonst MP3 – und weicht auf MP3 aus, wenn WebM nicht dekodiert", async () => {
    expect(preferredFormat(() => "probably")).toBe("webm");
    expect(preferredFormat(() => "maybe")).toBe("webm");
    expect(preferredFormat(() => "")).toBe("mp3");
    expect(soundUrl("tick", "mp3")).toBe("/sounds/tick.mp3");

    const mp3Only = fakeAudio({ canPlay: "" });
    const plain = createSoundManager(mp3Only.deps);
    plain.preload();
    expect(mp3Only.fetched.every((url) => url.endsWith(".mp3"))).toBe(true);

    const broken = fakeAudio({ undecodable: [".webm"] });
    const sound = createSoundManager(broken.deps);
    sound.unlock();
    await flush();
    await flush();
    expect(sound.play("win")).toBe(true);
    expect(broken.started).toEqual(["/sounds/win.mp3"]);
  });

  it("spielt nicht bei verborgener Seite und lässt nicht geladene Sounds aus, statt sie verspätet zu spielen", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    sound.unlock();
    audio.set({ visible: false });
    await flush();
    expect(sound.play("tick")).toBe(false);
    audio.set({ visible: true });
    expect(sound.play("tick")).toBe(true);
  });

  it("bleibt ohne Web Audio API stumm", () => {
    const audio = fakeAudio({ noEngine: true });
    const sound = createSoundManager(audio.deps);
    sound.unlock();
    expect(sound.unlocked).toBe(false);
    expect(sound.play("lock")).toBe(false);
  });
});

describe("Sound-Manager: Stummschalten und Persistenz", () => {
  it("übernimmt die gespeicherte Einstellung (Standard an)", () => {
    expect(createSoundManager(fakeAudio().deps).enabled).toBe(true);
    expect(createSoundManager(fakeAudio({ stored: false }).deps).enabled).toBe(false);
  });

  it("speichert den Umschalter, stoppt beim Ausschalten laufende Sounds und spielt danach nichts", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    sound.unlock();
    await flush();
    expect(sound.play("correct")).toBe(true);
    sound.setEnabled(false);
    expect(audio.written).toEqual([false]);
    expect(audio.stopped).toEqual(["/sounds/correct.webm"]);
    expect(sound.enabled).toBe(false);
    expect(sound.play("correct")).toBe(false);
    sound.setEnabled(true);
    expect(audio.written).toEqual([false, true]);
    expect(sound.play("correct")).toBe(true);
  });

  it("lädt bei „Ton aus“ nichts vor", () => {
    const audio = fakeAudio({ stored: false });
    createSoundManager(audio.deps).preload();
    expect(audio.fetched).toEqual([]);
  });
});

describe("Sound-Dateien (docs/09 §10)", () => {
  const directory = fileURLToPath(new URL("../../../public/sounds/", import.meta.url));

  it("liefert jeden Sound als .webm und .mp3 mit höchstens 20 KB und eine CC0-Lizenzdatei", () => {
    for (const name of SOUND_NAMES) {
      for (const format of ["webm", "mp3"] as const) {
        const file = `${directory}${name}.${format}`;
        expect(existsSync(file), file).toBe(true);
        const size = statSync(file).size;
        expect(size, file).toBeGreaterThan(0);
        expect(size, file).toBeLessThanOrEqual(20 * 1024);
      }
    }
    expect(readFileSync(`${directory}LICENSE.md`, "utf8")).toContain("CC0");
  });
});
