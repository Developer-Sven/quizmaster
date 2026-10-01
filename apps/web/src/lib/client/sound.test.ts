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
  /** Aufrufe von `resume()` (Entsperren bzw. Fortsetzen) */
  resumes: number;
  set(options: { activation?: boolean; visible?: boolean; resumeFails?: boolean }): void;
  /** iOS unterbricht den laufenden Kontext (App-Wechsel, Sperrbildschirm, Anruf): Zustand `interrupted`. */
  interrupt(): void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeAudio(
  options: { stored?: boolean; canPlay?: string; undecodable?: readonly string[]; noEngine?: boolean } = {},
): FakeAudio {
  const state = { activation: false, visible: true, resumeFails: false };
  let contextState = "suspended";
  const audio: FakeAudio = {
    engines: 0,
    started: [],
    stopped: [],
    fetched: [],
    written: [],
    warnings: [],
    primes: 0,
    resumes: 0,
    set(next) {
      Object.assign(state, next);
    },
    interrupt() {
      contextState = "interrupted";
    },
    deps: {
      createEngine: () => {
        if (options.noEngine) return null;
        audio.engines += 1;
        contextState = "suspended";
        const engine: AudioEngine<FakeBuffer> = {
          get state() {
            return contextState;
          },
          // wie im Browser asynchron: der Kontext läuft erst nach der Geste
          resume: async () => {
            audio.resumes += 1;
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

  it("entsperrt bei der ersten Geste (pointerdown, touchend, click, keydown); weitere Gesten lassen den laufenden Kontext in Ruhe", async () => {
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
    // weitere Gesten: der Kontext läuft – weder neu entsperren noch einen zweiten Kontext anlegen
    for (const type of ["pointerdown", "click", "keydown"]) target.dispatchEvent(new Event(type));
    expect(audio.primes).toBe(1);
    expect(audio.resumes).toBe(1);
    expect(audio.engines).toBe(1);
    detach();
  });

  it("entsperrt nach einer Unterbrechung (iOS: App-Wechsel, Sperrbildschirm, Anruf) bei der nächsten Geste erneut", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    const target = new EventTarget();
    const detach = sound.armUnlock(target);
    target.dispatchEvent(new Event("touchend"));
    await flush();
    expect(sound.play("lock")).toBe(true);
    // weiteres Tippen bei laufendem Kontext (z. B. die nächste Antwort)
    target.dispatchEvent(new Event("touchend"));
    await flush();

    audio.interrupt();
    expect(sound.unlocked).toBe(false);
    target.dispatchEvent(new Event("touchend"));
    expect(audio.resumes).toBe(2);
    expect(audio.primes).toBe(2);
    await flush();
    expect(sound.unlocked).toBe(true);
    expect(sound.play("tick")).toBe(true);
    expect(audio.engines).toBe(1);
    detach();
  });

  it("setzt einen unterbrochenen Kontext beim Abspielen fort (Tipp-Handler): dieser Ton entfällt, der nächste klingt", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    sound.unlock();
    await flush();
    audio.interrupt();
    expect(sound.play("lock")).toBe(false);
    expect(audio.resumes).toBe(2);
    await flush();
    expect(sound.play("lock")).toBe(true);
    expect(audio.started).toEqual(["/sounds/lock.webm"]);
  });

  it("setzt einen entsperrten Kontext fort, sobald die Seite wieder sichtbar ist – verborgen nicht", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    const target = new EventTarget();
    const detach = sound.armUnlock(target);
    target.dispatchEvent(new Event("click"));
    await flush();
    audio.interrupt();
    audio.set({ visible: false });
    target.dispatchEvent(new Event("visibilitychange"));
    expect(audio.resumes).toBe(1);
    audio.set({ visible: true });
    target.dispatchEvent(new Event("visibilitychange"));
    expect(audio.resumes).toBe(2);
    await flush();
    expect(sound.unlocked).toBe(true);
    detach();
  });

  it("legt beim Sichtbarwerden ohne vorherige Geste keinen Audio-Kontext an", () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    const target = new EventTarget();
    const detach = sound.armUnlock(target);
    target.dispatchEvent(new Event("visibilitychange"));
    expect(audio.engines).toBe(0);
    detach();
  });

  it("meldet alle Handler (Gesten und Sichtbarkeit) ab, wenn das Spiel endet", async () => {
    const audio = fakeAudio();
    const sound = createSoundManager(audio.deps);
    const target = new EventTarget();
    const detach = sound.armUnlock(target);
    target.dispatchEvent(new Event("click"));
    await flush();
    detach();
    audio.interrupt();
    for (const type of ["pointerdown", "touchend", "click", "keydown", "visibilitychange"]) {
      target.dispatchEvent(new Event(type));
    }
    expect(audio.resumes).toBe(1);
    expect(audio.engines).toBe(1);
  });

  it("meldet die Handler ab, wenn das Spiel vor der ersten Geste endet", () => {
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
