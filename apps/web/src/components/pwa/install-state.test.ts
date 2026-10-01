import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallRow } from "./install-row";
import {
  FIRST_GAME_KEY,
  type InstallFacts,
  installMethod,
  installStateForTests,
  isIosAddToHomeScreenCapable,
  isStandaloneDisplay,
  markFirstGameFinished,
  promptInstall,
  resetInstallStateForTests,
  startInstallCapture,
} from "./install-state";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1",
  ipadDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  iphoneInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.0.0",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
} as const;

const facts = (overrides: Partial<InstallFacts> = {}): InstallFacts => ({
  standalone: false,
  installed: false,
  firstGameFinished: true,
  canPrompt: false,
  iosAddToHomeScreen: false,
  ...overrides,
});

describe("installMethod (docs/10 Installations-Erlebnis)", () => {
  it("bietet erst nach dem ersten beendeten Spiel etwas an", () => {
    expect(installMethod(facts({ firstGameFinished: false, canPrompt: true }))).toBeNull();
    expect(installMethod(facts({ firstGameFinished: false, iosAddToHomeScreen: true }))).toBeNull();
  });

  it("blendet die Zeile aus, wenn die App installiert ist oder als App läuft", () => {
    expect(installMethod(facts({ standalone: true, canPrompt: true }))).toBeNull();
    expect(installMethod(facts({ standalone: true, iosAddToHomeScreen: true }))).toBeNull();
    expect(installMethod(facts({ installed: true, canPrompt: true }))).toBeNull();
  });

  it("Android/Chromium: Installationsdialog, iOS: Anleitung, sonst nichts (nicht installierbar)", () => {
    expect(installMethod(facts({ canPrompt: true }))).toBe("prompt");
    expect(installMethod(facts({ iosAddToHomeScreen: true }))).toBe("ios-guide");
    expect(installMethod(facts())).toBeNull();
  });
});

describe("Plattform-Erkennung", () => {
  it("erkennt iPhone, iPad (auch mit Desktop-Kennung) und andere iOS-Browser", () => {
    expect(isIosAddToHomeScreenCapable(UA.iphoneSafari, 5)).toBe(true);
    expect(isIosAddToHomeScreenCapable(UA.iphoneChrome, 5)).toBe(true);
    expect(isIosAddToHomeScreenCapable(UA.ipadDesktop, 5)).toBe(true);
  });

  it("schließt Mac, Android und In-App-Browser aus", () => {
    expect(isIosAddToHomeScreenCapable(UA.ipadDesktop, 0)).toBe(false);
    expect(isIosAddToHomeScreenCapable(UA.androidChrome, 5)).toBe(false);
    expect(isIosAddToHomeScreenCapable(UA.iphoneInstagram, 5)).toBe(false);
  });

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

  it("markFirstGameFinished merkt sich das Spielende dauerhaft und ist idempotent", async () => {
    const stop = startInstallCapture(fake);
    expect(installStateForTests().firstGameFinished).toBe(false);
    markFirstGameFinished();
    markFirstGameFinished();
    expect(fake.storage.get(FIRST_GAME_KEY)).toBe("1");
    await Promise.resolve();
    expect(installStateForTests().firstGameFinished).toBe(true);
    stop();
  });

  it("liest den Merker beim nächsten Besuch aus localStorage", () => {
    fake.storage.set(FIRST_GAME_KEY, "1");
    const stop = startInstallCapture(fake);
    expect(installStateForTests()).toMatchObject({ ready: true, firstGameFinished: true, iosAddToHomeScreen: false });
    stop();
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

  it("erkennt iOS als Plattform mit Anleitung", () => {
    vi.stubGlobal("window", new FakeWindow(UA.iphoneSafari, 5));
    const stop = startInstallCapture(window);
    expect(installStateForTests().iosAddToHomeScreen).toBe(true);
    stop();
  });
});

describe("InstallRow", () => {
  it("rendert auf dem Server nichts – die Zeile entsteht erst im Browser (kein Hydration-Unterschied)", () => {
    resetInstallStateForTests();
    expect(renderToStaticMarkup(createElement(InstallRow))).toBe("");
  });
});
