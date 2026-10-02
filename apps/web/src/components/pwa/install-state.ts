/**
 * Installieren (docs/10, ADR-040, ADR-054): Die Zeile „App installieren“ steht auf jedem Handy, solange die App nicht
 * installiert ist. Wo der Browser selbst installieren kann – Chromium (Android, Desktop) liefert dafür
 * `beforeinstallprompt` –, öffnet ein Tipp sofort den Installationsdialog („prompt“). iPhone/iPad erlauben Webseiten
 * in keinem Browser das Installieren (nur „Teilen“ → „Zum Home-Bildschirm“) → Anleitung („ios“); Android ohne Dialog
 * (Firefox, Chrome vor dem Event) → Anleitung über das Browser-Menü („android“). Am Desktop nur mit Dialog. Schon
 * installiert (Standalone bzw. auf Android über `getInstalledRelatedApps` erkannt) → keine Zeile.
 *
 * Das Event kommt einmal je Seitenaufruf und oft vor der Hydration: Ein kleines Inline-Skript im Root-Layout
 * ({@link EARLY_INSTALL_CAPTURE_SCRIPT}) fängt es sofort ab und legt es auf `window.__qmInstallPrompt`;
 * {@link startInstallCapture} übernimmt es von dort (vorher war die Zeile deshalb „mal da, mal nicht“).
 */
import { useSyncExternalStore } from "react";

export type InstallMethod = "prompt" | "ios" | "android";
export type InstallPlatform = "ios" | "android" | "other";
export type InstallBrowser = "safari" | "chrome" | "firefox" | "edge" | "samsung" | "other";

export interface InstallFacts {
  /** läuft schon als installierte App (Display-Mode bzw. `navigator.standalone` auf iOS) */
  standalone: boolean;
  /** in dieser Sitzung installiert (`appinstalled` bzw. Installationsdialog angenommen) */
  installed: boolean;
  /** abgefangenes `beforeinstallprompt` liegt bereit (Chromium) */
  canPrompt: boolean;
  platform: InstallPlatform;
  /** Android: die App ist schon installiert (`navigator.getInstalledRelatedApps`, Manifest `related_applications`) */
  relatedInstalled: boolean;
}

/** Wie installiert wird – `null`: keine Zeile (installiert bzw. Desktop ohne Installationsdialog). */
export function installMethod(facts: InstallFacts): InstallMethod | null {
  if (facts.standalone || facts.installed) return null;
  if (facts.canPrompt) return "prompt";
  if (facts.platform === "ios") return "ios";
  if (facts.platform === "android" && !facts.relatedInstalled) return "android";
  return null;
}

/** iPhone/iPad (iPadOS meldet sich als Mac – mit Touch), Android oder anderes. */
export function detectInstallPlatform(userAgent: string, maxTouchPoints: number): InstallPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "other";
}

/** Browser für die passende Anleitung (auf iOS kennzeichnen sich Chrome, Firefox und Edge eigens). */
export function detectInstallBrowser(userAgent: string): InstallBrowser {
  if (/SamsungBrowser\//.test(userAgent)) return "samsung";
  if (/EdgiOS\/|EdgA\/|Edg\//.test(userAgent)) return "edge";
  if (/FxiOS\/|Firefox\//.test(userAgent)) return "firefox";
  if (/CriOS\/|Chrome\//.test(userAgent)) return "chrome";
  if (/Safari\//.test(userAgent)) return "safari";
  return "other";
}

export { EARLY_INSTALL_CAPTURE_SCRIPT } from "./early-install-capture";

/** Display-Modi einer installierten App (Manifest: `standalone`). */
export const INSTALLED_DISPLAY_QUERIES = [
  "(display-mode: standalone)",
  "(display-mode: fullscreen)",
  "(display-mode: minimal-ui)",
] as const;

export function isStandaloneDisplay(matches: (query: string) => boolean, navigatorStandalone: unknown): boolean {
  return navigatorStandalone === true || INSTALLED_DISPLAY_QUERIES.some((query) => matches(query));
}

/** `beforeinstallprompt` (nur Chromium, nicht in den DOM-Typen). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: string }>;
}

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return "prompt" in event && typeof event.prompt === "function" && "userChoice" in event;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unbekannt";
}

interface InstallState extends InstallFacts {
  /** Umgebung im Browser ausgewertet (auf dem Server und vor der Hydration: nein → nichts anbieten) */
  ready: boolean;
  browser: InstallBrowser;
}

const INITIAL_STATE: InstallState = Object.freeze({
  ready: false,
  standalone: false,
  installed: false,
  canPrompt: false,
  platform: "other",
  relatedInstalled: false,
  browser: "other",
});

let state: InstallState = INITIAL_STATE;
let promptEvent: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<InstallState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function standaloneNow(): boolean {
  const { navigator } = window;
  // `navigator.standalone` gibt es nur in Safari auf iOS/iPadOS (nicht in den DOM-Typen).
  const standalone = "standalone" in navigator ? navigator.standalone : undefined;
  return isStandaloneDisplay((query) => window.matchMedia(query).matches, standalone);
}

/**
 * Android: Ist die App schon installiert, bietet die Seite kein Installieren an (ADR-054).
 * `navigator.getInstalledRelatedApps` gibt es nur in Chromium (nicht in den DOM-Typen).
 */
async function detectRelatedInstalled(): Promise<void> {
  const { navigator } = window;
  if (!("getInstalledRelatedApps" in navigator) || typeof navigator.getInstalledRelatedApps !== "function") return;
  try {
    const apps: unknown = await navigator.getInstalledRelatedApps();
    if (Array.isArray(apps) && apps.length > 0) update({ relatedInstalled: true });
  } catch (error) {
    // Ohne Antwort bleibt die Zeile (Anleitung) – Installieren ist dann höchstens überflüssig, nie kaputt.
    console.warn("Installierte App nicht prüfbar:", errorName(error));
  }
}

/** Wertet die Browser-Umgebung einmal aus (idempotent, nur im Browser). */
function ensureEnvironment(): void {
  if (state.ready || typeof window === "undefined") return;
  const { userAgent, maxTouchPoints } = window.navigator;
  const platform = detectInstallPlatform(userAgent, maxTouchPoints);
  update({ ready: true, standalone: standaloneNow(), platform, browser: detectInstallBrowser(userAgent) });
  if (platform === "android") void detectRelatedInstalled();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureEnvironment();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): InstallState {
  return state;
}

function getServerSnapshot(): InstallState {
  return INITIAL_STATE;
}

/** Installationsweg und Browser für die Zeile auf der Startseite (`null` = Zeile ausblenden). */
export function useInstallOffer(): { method: InstallMethod; browser: InstallBrowser } | null {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const method = installMethod(current);
  return method === null ? null : { method, browser: current.browser };
}

/** Die Teile von `window`, an denen die Installation beobachtet wird (Tests nutzen eine Attrappe). */
export interface InstallCaptureTarget {
  /** vom Inline-Skript abgefangenes Event (siehe EARLY_INSTALL_CAPTURE_SCRIPT) */
  __qmInstallPrompt?: Event | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  matchMedia(query: string): {
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  };
}

/**
 * Fängt `beforeinstallprompt` ab (kein Mini-Infobar, die Zeile löst später `prompt()` aus) und erkennt eine
 * Installation (`appinstalled`, Wechsel in den Standalone-Modus). Früh starten (Root-Layout), da das Event
 * nur einmal je Seitenaufruf kommt. Liefert die Aufräumfunktion.
 */
export function startInstallCapture(target: InstallCaptureTarget): () => void {
  ensureEnvironment();
  const adopt = (event: Event) => {
    if (!isBeforeInstallPromptEvent(event)) return;
    event.preventDefault();
    promptEvent = event;
    update({ canPrompt: true });
  };
  // Schon vor der Hydration abgefangen (Inline-Skript)? Dann übernehmen – es kommt nicht noch einmal.
  const early = target.__qmInstallPrompt;
  if (early) {
    target.__qmInstallPrompt = null;
    adopt(early);
  }
  const onBeforeInstallPrompt = (event: Event) => {
    // Das Inline-Skript hat es ebenfalls abgelegt – nie später ein schon benutztes Event übernehmen.
    target.__qmInstallPrompt = null;
    adopt(event);
  };
  const onInstalled = () => {
    promptEvent = null;
    update({ installed: true, canPrompt: false });
  };
  const displayMode = target.matchMedia(INSTALLED_DISPLAY_QUERIES[0]);
  const onDisplayModeChange = () => update({ standalone: standaloneNow() });

  target.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  target.addEventListener("appinstalled", onInstalled);
  displayMode.addEventListener("change", onDisplayModeChange);
  return () => {
    target.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    target.removeEventListener("appinstalled", onInstalled);
    displayMode.removeEventListener("change", onDisplayModeChange);
  };
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

/**
 * Öffnet den Installationsdialog des Browsers (Android/Chromium). Ein abgefangenes Event lässt sich nur
 * einmal verwenden – danach verschwindet die Zeile, bis der Browser es erneut anbietet.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = promptEvent;
  if (!event) return "unavailable";
  promptEvent = null;
  update({ canPrompt: false });
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome !== "accepted") return "dismissed";
    update({ installed: true });
    return "accepted";
  } catch (error) {
    console.warn("Installationsdialog nicht verfügbar:", errorName(error));
    return "unavailable";
  }
}

/** Nur für Tests: Zustand zurücksetzen. */
export function resetInstallStateForTests(): void {
  state = INITIAL_STATE;
  promptEvent = null;
  listeners.clear();
}

/** Nur für Tests: aktueller Zustand. */
export function installStateForTests(): InstallState {
  return state;
}
