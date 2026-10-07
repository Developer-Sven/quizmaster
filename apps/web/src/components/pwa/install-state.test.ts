import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSteps } from "./install-guide";
import { InstallRow } from "./install-row";
import {
  detectInstallBrowser,
  detectInstallPlatform,
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
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/142.0 Mobile/15E148 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  desktopChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
} as const;

const facts = (overrides: Partial<InstallFacts> = {}): InstallFacts => ({
  standalone: false,
  installed: false,
  canPrompt: false,
  platform: "other",
  relatedInstalled: false,
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

describe("installMethod auf dem Handy (ADR-054)", () => {
  it("jedes Handy bekommt die Zeile: direkt, wo möglich – sonst die Anleitung für diesen Browser", () => {
    expect(installMethod(facts({ platform: "ios" }))).toBe("ios");
    expect(installMethod(facts({ platform: "android" }))).toBe("android");
    expect(installMethod(facts({ platform: "android", canPrompt: true }))).toBe("prompt");
    // Desktop ohne Installationsdialog: keine Zeile.
    expect(installMethod(facts({ platform: "other" }))).toBeNull();
  });

  it("keine Zeile, wenn die App schon installiert ist oder als App läuft", () => {
    expect(installMethod(facts({ platform: "android", relatedInstalled: true }))).toBeNull();
    expect(installMethod(facts({ platform: "ios", standalone: true }))).toBeNull();
    expect(installMethod(facts({ platform: "ios", installed: true }))).toBeNull();
  });

  it("Anleitung je Browser: Teilen auf iPhone/iPad, Menü auf Android", () => {
    const texts = (method: "ios" | "android", browser: Parameters<typeof installSteps>[1]) =>
      installSteps(method, browser).map((step) => step.text);
    expect(texts("ios", "safari")[0]).toContain("„Teilen“");
    expect(texts("ios", "chrome")[0]).toContain("Adresszeile");
    expect(texts("ios", "firefox")[0]).toContain("Menü");
    expect(texts("ios", "safari")).toContain("Wähle „Zum Home-Bildschirm“ – eventuell weiter unten in der Liste.");
    expect(texts("android", "chrome")[0]).toContain("Menü");
    expect(texts("android", "firefox")[1]).toContain("Installieren");
    expect(installSteps("ios", "safari").map((step) => step.icon)).toEqual(["share", "add", null]);
    expect(installSteps("android", "chrome").map((step) => step.icon)).toEqual(["menu", "add", null]);
  });

  it("Samsung Internet: Menü-Schritt ohne Symbol – sein Menü ist kein ⋮, und Zeichen ersetzen keine Icons im Text", () => {
    const steps = installSteps("android", "samsung");
    expect(steps.map((step) => step.icon)).toEqual([null, "add", null]);
    expect(steps[0]?.text).toBe("Öffne das Menü des Browsers (unten rechts).");
    expect(steps[0]?.text).not.toMatch(/[≡⋮]/);
  });

  it("kein Menü-Zeichen im Text – das Symbol steht daneben (alle Browser)", () => {
    for (const method of ["ios", "android"] as const) {
      for (const browser of ["safari", "chrome", "firefox", "samsung", "edge", "other"] as const) {
        for (const step of installSteps(method, browser)) expect(step.text, `${method}/${browser}`).not.toMatch(/[≡⋮]/);
      }
    }
  });
});

describe("Plattform-Erkennung", () => {
  it("erkennt iPhone/iPad (auch iPadOS mit Mac-Kennung und Touch), Android und den Browser", () => {
    expect(detectInstallPlatform(UA.iphoneSafari, 5)).toBe("ios");
    expect(detectInstallPlatform(UA.iphoneChrome, 5)).toBe("ios");
    expect(detectInstallPlatform(UA.macSafari, 5)).toBe("ios");
    expect(detectInstallPlatform(UA.macSafari, 0)).toBe("other");
    expect(detectInstallPlatform(UA.androidFirefox, 5)).toBe("android");
    expect(detectInstallPlatform(UA.desktopChrome, 0)).toBe("other");
    expect(detectInstallBrowser(UA.iphoneSafari)).toBe("safari");
    expect(detectInstallBrowser(UA.iphoneChrome)).toBe("chrome");
    expect(detectInstallBrowser(UA.iphoneFirefox)).toBe("firefox");
    expect(detectInstallBrowser(UA.androidChrome)).toBe("chrome");
    expect(detectInstallBrowser(UA.androidFirefox)).toBe("firefox");
    expect(detectInstallBrowser(UA.androidSamsung)).toBe("samsung");
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

  it("erkennt Plattform und Browser beim Start (ADR-054)", () => {
    vi.stubGlobal("window", new FakeWindow(UA.iphoneFirefox, 5));
    const stop = startInstallCapture(window as unknown as FakeWindow);
    expect(installStateForTests()).toMatchObject({ ready: true, platform: "ios", browser: "firefox" });
    stop();
  });

  it("Android: schon installierte App (getInstalledRelatedApps) blendet die Zeile aus (ADR-054)", async () => {
    const installedApp = new FakeWindow(UA.androidChrome, 5);
    Object.assign(installedApp.navigator, { getInstalledRelatedApps: async () => [{ platform: "webapp" }] });
    vi.stubGlobal("window", installedApp);
    const stop = startInstallCapture(installedApp);
    await vi.waitFor(() => expect(installStateForTests().relatedInstalled).toBe(true));
    stop();
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

  it("lädt das Anleitungs-Sheet erst beim ersten Tipp – Sheet und motion bleiben aus der Startseite (ADR-037)", () => {
    // Ein statischer Import zog Sheet + motion (≈ 42 KB gzip) in das initiale JS von `/` (205 statt ≤ 165 KB).
    const source = readFileSync(new URL("./install-row.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import(?!\s+type)[^;]*from\s+["']\.\/install-sheet["']/m);
    expect(source).toMatch(/import\("\.\/install-sheet"\)/);
    // Ein gescheiterter Download wird nicht gemerkt (der nächste Tipp lädt neu) und ersetzt nie die Startseite.
    expect(source).toMatch(/sheetModule = null;\s*throw error;/);
    expect(source).toMatch(/\(\) => setUnavailable\(true\)/);
  });
});
