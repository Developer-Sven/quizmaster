import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallRow } from "./install-row";
import {
  EARLY_INSTALL_CAPTURE_SCRIPT,
  type InstallFacts,
  installMethod,
  installStateForTests,
  isStandaloneDisplay,
  promptInstall,
  resetInstallStateForTests,
  startInstallCapture,
} from "./install-state";

const UA = {
  androidChrome:
    "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
} as const;

const facts = (overrides: Partial<InstallFacts> = {}): InstallFacts => ({
  standalone: false,
  installed: false,
  canPrompt: false,
  ...overrides,
});

describe("installMethod (ADR-040)", () => {
  it("nur wo der Browser direkt installieren kann – sofort, ohne erst ein Spiel zu beenden", () => {
    expect(installMethod(facts({ canPrompt: true }))).toBe("prompt");
    expect(installMethod(facts())).toBeNull();
  });

  it("blendet die Zeile aus, wenn die App installiert ist oder als App läuft", () => {
    expect(installMethod(facts({ standalone: true, canPrompt: true }))).toBeNull();
    expect(installMethod(facts({ installed: true, canPrompt: true }))).toBeNull();
  });
});

describe("Plattform-Erkennung", () => {
  it("erkennt den Standalone-Modus über Display-Mode oder navigator.standalone (iOS)", () => {
    const none = () => false;
    expect(isStandaloneDisplay(none, undefined)).toBe(false);
    expect(isStandaloneDisplay(none, false)).toBe(false);
    expect(isStandaloneDisplay(none, true)).toBe(true);
    expect(isStandaloneDisplay((query) => query === "(display-mode: standalone)", undefined)).toBe(true);
    expect(isStandaloneDisplay((query) => query === "(display-mode: browser)", undefined)).toBe(false);
  });
});

/** Minimaler Browser für die Zustandslogik (Node-Testumgebung ohne DOM). */
class FakeWindow extends EventTarget {
  readonly storage = new Map<string, string>();
  readonly media = new Map<string, EventTarget & { matches: boolean }>();
  readonly localStorage = {
    getItem: (key: string) => this.storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      this.storage.set(key, value);
    },
  };
  readonly navigator: { userAgent: string; maxTouchPoints: number; standalone?: boolean };
  standaloneMatches = false;

  constructor(userAgent: string, maxTouchPoints = 0) {
    super();
    this.navigator = { userAgent, maxTouchPoints };
  }

  matchMedia(query: string): EventTarget & { matches: boolean } {
    let list = this.media.get(query);
    if (!list) {
      list = Object.defineProperty(new EventTarget(), "matches", {
        get: () => query === "(display-mode: standalone)" && this.standaloneMatches,
      }) as EventTarget & { matches: boolean };
      this.media.set(query, list);
    }
    return list;
  }
}

function installPromptEvent(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(async () => {});
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome, platform: "web" }) });
  return { event, prompt };
}

describe("Install-Zustand im Browser", () => {
  let fake: FakeWindow;

  beforeEach(() => {
    resetInstallStateForTests();
    fake = new FakeWindow(UA.androidChrome, 5);
    vi.stubGlobal("window", fake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetInstallStateForTests();
  });

  it("übernimmt ein schon vor der Hydration abgefangenes Event (Inline-Skript im Root-Layout)", async () => {
    const { event, prompt } = installPromptEvent("accepted");
    const early = fake as FakeWindow & { __qmInstallPrompt?: Event | null };
    early.__qmInstallPrompt = event;
    const stop = startInstallCapture(early);
    expect(installStateForTests()).toMatchObject({ ready: true, canPrompt: true });
    expect(early.__qmInstallPrompt).toBeNull();
    await expect(promptInstall()).resolves.toBe("accepted");
    expect(prompt).toHaveBeenCalledOnce();
    stop();
  });

  it("ein nach dem Start eintreffendes Event wird übernommen und nie ein zweites Mal (Merker geleert)", async () => {
    const target = fake as FakeWindow & { __qmInstallPrompt?: Event | null };
    const stop = startInstallCapture(target);
    const { event, prompt } = installPromptEvent("dismissed");
    // Wie im Browser: Das Inline-Skript legt das Event ab, danach hört die App-Erfassung mit.
    target.__qmInstallPrompt = event;
    target.dispatchEvent(event);
    expect(target.__qmInstallPrompt).toBeNull();
    await expect(promptInstall()).resolves.toBe("dismissed");
    expect(prompt).toHaveBeenCalledOnce();
    stop();
    // Erneuter Start (z. B. erneutes Einhängen): kein schon benutztes Event, keine Zeile.
    const again = startInstallCapture(target);
    expect(installStateForTests().canPrompt).toBe(false);
    again();
  });

  it("das Inline-Skript fängt das Event ab, bevor React lädt (ohne Mini-Infobar)", () => {
    const target = new EventTarget() as EventTarget & { __qmInstallPrompt?: Event | null };
    new Function("window", EARLY_INSTALL_CAPTURE_SCRIPT)(target);
    expect(target.__qmInstallPrompt).toBeNull();
    const { event } = installPromptEvent("accepted");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(target.__qmInstallPrompt).toBe(event);
  });

  it("fängt beforeinstallprompt ab (kein Mini-Infobar) und löst später den Dialog aus", async () => {
    const stop = startInstallCapture(fake);
    const { event, prompt } = installPromptEvent("accepted");
    fake.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(installStateForTests().canPrompt).toBe(true);

    await expect(promptInstall()).resolves.toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(installStateForTests()).toMatchObject({ canPrompt: false, installed: true });
    // Ein Event lässt sich nur einmal verwenden
    await expect(promptInstall()).resolves.toBe("unavailable");
    stop();
  });

  it("blendet nach Ablehnung aus, bis der Browser erneut anbietet", async () => {
    const stop = startInstallCapture(fake);
    fake.dispatchEvent(installPromptEvent("dismissed").event);
    await expect(promptInstall()).resolves.toBe("dismissed");
    expect(installStateForTests()).toMatchObject({ canPrompt: false, installed: false });
    fake.dispatchEvent(installPromptEvent("accepted").event);
    expect(installStateForTests().canPrompt).toBe(true);
    stop();
  });

  it("erkennt eine Installation (appinstalled) und den Wechsel in den Standalone-Modus", () => {
    const stop = startInstallCapture(fake);
    fake.dispatchEvent(installPromptEvent("accepted").event);
    fake.dispatchEvent(new Event("appinstalled"));
    expect(installStateForTests()).toMatchObject({ installed: true, canPrompt: false });

    fake.standaloneMatches = true;
    fake.matchMedia("(display-mode: standalone)").dispatchEvent(new Event("change"));
    expect(installStateForTests().standalone).toBe(true);
    stop();
  });

  it("ignoriert fremde Events ohne prompt() und hört nach dem Aufräumen nicht mehr zu", () => {
    const stop = startInstallCapture(fake);
    fake.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true }));
    expect(installStateForTests().canPrompt).toBe(false);
    stop();
    fake.dispatchEvent(installPromptEvent("accepted").event);
    expect(installStateForTests().canPrompt).toBe(false);
  });
});

describe("InstallRow", () => {
  it("rendert auf dem Server nichts – die Zeile entsteht erst im Browser (kein Hydration-Unterschied)", () => {
    resetInstallStateForTests();
    expect(renderToStaticMarkup(createElement(InstallRow))).toBe("");
  });
});
