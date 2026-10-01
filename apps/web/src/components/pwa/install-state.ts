/**
 * Installations-Erlebnis (docs/10 „Installations-Erlebnis“, docs/09 §6): Merker „erstes Spiel beendet“,
 * abgefangenes `beforeinstallprompt` (Android/Chromium), iOS-Erkennung (Anleitung statt Install-Event) und
 * „bereits installiert?“ (Standalone). Die Zeile „Als App installieren“ erscheint nur, wenn {@link installMethod}
 * eine Methode liefert – kein Pop-up, kein Banner.
 *
 * Vertrag mit dem Spielende (GameOverOverlay): `markFirstGameFinished()` beim ersten Anzeigen von `game_over`
 * aufrufen (am besten in einem Effekt; mehrfache Aufrufe sind harmlos).
 */
import { useSyncExternalStore } from "react";

/** localStorage-Schlüssel des Merkers (Präfix wie lib/client/storage.ts). */
export const FIRST_GAME_KEY = "qm.firstGameFinished";

export type InstallMethod = "prompt" | "ios-guide";

export interface InstallFacts {
  /** läuft schon als installierte App (Display-Mode bzw. `navigator.standalone` auf iOS) */
  standalone: boolean;
  /** in dieser Sitzung installiert (`appinstalled` bzw. Installationsdialog angenommen) */
  installed: boolean;
  /** Merker „erstes Spiel beendet“ */
  firstGameFinished: boolean;
  /** abgefangenes `beforeinstallprompt` liegt bereit (Android/Chromium) */
  canPrompt: boolean;
  /** iOS/iPadOS-Browser mit „Zum Home-Bildschirm“ (kein Install-Event) */
  iosAddToHomeScreen: boolean;
}

/**
 * Welche Installationshilfe angeboten wird: nur nach dem ersten beendeten Spiel, nur wenn installierbar und
 * noch nicht installiert. Chromium mit Event → Installationsdialog; iOS → Anleitungs-Sheet; sonst nichts.
 */
export function installMethod(facts: InstallFacts): InstallMethod | null {
  if (facts.standalone || facts.installed || !facts.firstGameFinished) return null;
  if (facts.canPrompt) return "prompt";
  if (facts.iosAddToHomeScreen) return "ios-guide";
  return null;
}

/** In-App-Browser sozialer Apps können nicht zum Home-Bildschirm hinzufügen. */
const IN_APP_BROWSER = /FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|musical_ly|BytedanceWebview/;

/** iPhone, iPod, iPad – auch iPadOS, das sich als Mac ausgibt (erkennbar am Touch). */
export function isIosAddToHomeScreenCapable(userAgent: string, maxTouchPoints: number): boolean {
  const appleMobile = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return appleMobile && !IN_APP_BROWSER.test(userAgent);
}

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

let storageWarned = false;

/** Meldet einen nicht nutzbaren Speicher einmal (privater Modus, voll) – ohne Inhalte. */
function reportStorageProblem(error: unknown): void {
  if (storageWarned) return;
  storageWarned = true;
  console.warn("Lokaler Speicher nicht verfügbar:", errorName(error));
}

function readFirstGameFlag(): boolean {
  try {
    return window.localStorage.getItem(FIRST_GAME_KEY) === "1";
  } catch (error) {
    reportStorageProblem(error);
    return false;
  }
}

function writeFirstGameFlag(): void {
  try {
    window.localStorage.setItem(FIRST_GAME_KEY, "1");
  } catch (error) {
    reportStorageProblem(error);
  }
}

interface InstallState extends InstallFacts {
  /** Umgebung im Browser ausgewertet (auf dem Server und vor der Hydration: nein → nichts anbieten) */
  ready: boolean;
}

const INITIAL_STATE: InstallState = Object.freeze({
  ready: false,
  standalone: false,
  installed: false,
  firstGameFinished: false,
  canPrompt: false,
  iosAddToHomeScreen: false,
});

let state: InstallState = INITIAL_STATE;
let promptEvent: BeforeInstallPromptEvent | null = null;
let firstGameMarked = false;
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

/** Wertet die Browser-Umgebung einmal aus (idempotent, nur im Browser). */
function ensureEnvironment(): void {
  if (state.ready || typeof window === "undefined") return;
  update({
    ready: true,
    standalone: standaloneNow(),
    iosAddToHomeScreen: isIosAddToHomeScreenCapable(window.navigator.userAgent, window.navigator.maxTouchPoints),
    firstGameFinished: state.firstGameFinished || readFirstGameFlag(),
  });
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

/** Aktuelle Installationshilfe für die Zeile auf der Startseite (`null` = Zeile ausblenden). */
export function useInstallMethod(): InstallMethod | null {
  return installMethod(useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot));
}

/**
 * Merkt sich, dass diese Person ein Spiel bis zum Ende gespielt hat (localStorage). Danach darf die Startseite
 * „Als App installieren“ anbieten. Idempotent, auf dem Server ohne Wirkung; die Benachrichtigung läuft entkoppelt
 * vom Aufrufer, damit der Aufruf auch während des Renderns des Spielendes keinen fremden State setzt.
 */
export function markFirstGameFinished(): void {
  if (typeof window === "undefined" || firstGameMarked) return;
  firstGameMarked = true;
  writeFirstGameFlag();
  queueMicrotask(() => {
    if (!state.firstGameFinished) update({ firstGameFinished: true });
  });
}

/** Die Teile von `window`, an denen die Installation beobachtet wird (Tests nutzen eine Attrappe). */
export interface InstallCaptureTarget {
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
  const onBeforeInstallPrompt = (event: Event) => {
    if (!isBeforeInstallPromptEvent(event)) return;
    event.preventDefault();
    promptEvent = event;
    update({ canPrompt: true });
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
  firstGameMarked = false;
  storageWarned = false;
  listeners.clear();
}

/** Nur für Tests: aktueller Zustand. */
export function installStateForTests(): InstallFacts & { ready: boolean } {
  return state;
}
