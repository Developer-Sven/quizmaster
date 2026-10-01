/**
 * Installieren (docs/10, ADR-040): Die Zeile „App installieren“ gibt es nur, wo der Browser direkt installieren
 * kann – Chromium (Android, Desktop) liefert dafür `beforeinstallprompt`, ein Tipp öffnet sofort den
 * Installationsdialog. Safari auf iPhone/iPad erlaubt Webseiten kein Installieren (nur „Teilen“ → „Zum
 * Home-Bildschirm“), dort erscheint keine Zeile. Schon installiert (Standalone) → keine Zeile.
 *
 * Das Event kommt einmal je Seitenaufruf und oft vor der Hydration: Ein kleines Inline-Skript im Root-Layout
 * ({@link EARLY_INSTALL_CAPTURE_SCRIPT}) fängt es sofort ab und legt es auf `window.__qmInstallPrompt`;
 * {@link startInstallCapture} übernimmt es von dort (vorher war die Zeile deshalb „mal da, mal nicht“).
 */
import { useSyncExternalStore } from "react";

export type InstallMethod = "prompt";

export interface InstallFacts {
  /** läuft schon als installierte App (Display-Mode bzw. `navigator.standalone` auf iOS) */
  standalone: boolean;
  /** in dieser Sitzung installiert (`appinstalled` bzw. Installationsdialog angenommen) */
  installed: boolean;
  /** abgefangenes `beforeinstallprompt` liegt bereit (Chromium) */
  canPrompt: boolean;
}

/** Zeile anbieten, wenn der Browser direkt installieren kann und die App noch nicht installiert ist. */
export function installMethod(facts: InstallFacts): InstallMethod | null {
  if (facts.standalone || facts.installed) return null;
  return facts.canPrompt ? "prompt" : null;
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
}

const INITIAL_STATE: InstallState = Object.freeze({
  ready: false,
  standalone: false,
  installed: false,
  canPrompt: false,
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

/** Wertet die Browser-Umgebung einmal aus (idempotent, nur im Browser). */
function ensureEnvironment(): void {
  if (state.ready || typeof window === "undefined") return;
  update({ ready: true, standalone: standaloneNow() });
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
export function installStateForTests(): InstallFacts & { ready: boolean } {
  return state;
}
