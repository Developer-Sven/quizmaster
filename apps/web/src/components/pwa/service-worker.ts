/**
 * Service Worker auf der Seite (docs/10 „Service Worker“, „Update-Fluss“): Registrierung nur in Produktion
 * (in `next dev` per Flag), `updateViaCache: 'none'`, Update-Prüfung bei Rückkehr in den Vordergrund.
 *
 * Update-Fluss: neuer SW installiert und wartet → {@link useUpdateAvailable} wird `true` → Banner „Neue Version
 * verfügbar“ (Start, Lobby, ab `game_over` – nie im laufenden Spiel, {@link updateBannerAllowed}) → „Aktualisieren“
 * ruft {@link applyUpdate}: `SKIP_WAITING` an den wartenden SW → `controllerchange` → Reload.
 */
import type { Phase } from "@quizmaster/shared";
import { useSyncExternalStore } from "react";
import { SKIP_WAITING, SW_DEV_PARAM, SW_SCOPE, SW_URL } from "../../sw/protocol";

/** Die Teile von `ServiceWorker`, die der Update-Fluss braucht (Tests nutzen Attrappen). */
export interface WorkerLike extends EventTarget {
  readonly state: string;
  postMessage(message: unknown): void;
}

/** Die Teile von `ServiceWorkerRegistration`. */
export interface RegistrationLike extends EventTarget {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  update(): Promise<unknown>;
}

/** Die Teile von `ServiceWorkerContainer` (`navigator.serviceWorker`). */
export interface ContainerLike extends EventTarget {
  readonly controller: unknown;
  register(url: string, options?: RegistrationOptions): Promise<RegistrationLike>;
  getRegistrations(): Promise<readonly { unregister(): Promise<boolean> }[]>;
}

/** Kommt `controllerchange` nach „Aktualisieren“ nicht, lädt die Seite trotzdem neu. */
export const UPDATE_RELOAD_FALLBACK_MS = 4_000;

/** Lange offene Lobbys prüfen zusätzlich regelmäßig auf eine neue Version. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

/** localStorage-Flag, mit dem der SW auch in `next dev` registriert wird: `localStorage.setItem("qm.sw", "dev")`. */
export const DEV_FLAG_KEY = "qm.sw";

export type RegistrationPlan = { kind: "register"; url: string } | { kind: "unregister" };

/**
 * Produktion: `/sw.js`. Entwicklung nur mit Flag (`/sw.js?dev` – dann ohne Cache für `/_next/static`), sonst
 * werden alte Registrierungen entfernt, damit ein früher getesteter Produktions-SW `next dev` nicht stört.
 */
export function registrationPlan(options: { production: boolean; devFlag: boolean }): RegistrationPlan {
  if (options.production) return { kind: "register", url: SW_URL };
  if (options.devFlag) return { kind: "register", url: `${SW_URL}?${SW_DEV_PARAM}` };
  return { kind: "unregister" };
}

/** Update-Banner nur außerhalb eines laufenden Spiels: Start (keine Lobby), Lobby und Spielende (docs/10). */
export function updateBannerAllowed(phase: Phase | null): boolean {
  return phase === null || phase === "lobby" || phase === "game_over";
}

export type StatusBannerKind = "update" | "maintenance";

/**
 * Höchstens ein Banner unter der Kopfzeile, Update vor Wartung (docs/09 §5). `updateRequired` (Server lehnt die
 * Protokollversion ab) zeigt das Update-Banner immer; ein wartender SW nur, wo {@link updateBannerAllowed} es erlaubt.
 */
export function statusBannerKind(input: {
  updateRequired: boolean;
  updateWaiting: boolean;
  maintenance: boolean;
  phase: Phase | null;
}): StatusBannerKind | null {
  if (input.updateRequired) return "update";
  if (input.updateWaiting && updateBannerAllowed(input.phase)) return "update";
  if (input.maintenance) return "maintenance";
  return null;
}

export interface UpdateControllerDeps {
  reload: () => void;
  setTimer: (callback: () => void, ms: number) => void;
}

export interface UpdateController {
  subscribe(listener: () => void): () => void;
  /** wartet ein neuer SW? */
  isWaiting(): boolean;
  /** beobachtet eine Registrierung auf neue, wartende Versionen */
  watch(registration: RegistrationLike, container: ContainerLike): void;
  /** `controllerchange` des Containers */
  handleControllerChange(): void;
  /** „Aktualisieren“: wartenden SW aktivieren und neu laden (ohne wartenden SW: nur neu laden) */
  applyUpdate(): void;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const listeners = new Set<() => void>();
  let waitingWorker: WorkerLike | null = null;
  let reloadRequested = false;
  let reloaded = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    deps.reload();
  };

  const setWaiting = (worker: WorkerLike) => {
    if (waitingWorker === worker) return;
    waitingWorker = worker;
    worker.addEventListener("statechange", () => {
      // Aktiviert (z. B. „Aktualisieren“ in einem anderen Tab) oder verworfen: nichts mehr anzubieten.
      if (waitingWorker === worker && (worker.state === "activated" || worker.state === "redundant")) {
        waitingWorker = null;
        notify();
      }
    });
    notify();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isWaiting: () => waitingWorker !== null,
    watch(registration, container) {
      // Ein Update ist es nur, wenn schon eine ältere Version die Seite steuert (nicht beim ersten Install).
      const track = (worker: WorkerLike) => {
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && container.controller) setWaiting(worker);
        });
      };
      if (registration.waiting && container.controller) setWaiting(registration.waiting);
      if (registration.installing) track(registration.installing);
      registration.addEventListener("updatefound", () => {
        if (registration.installing) track(registration.installing);
      });
    },
    handleControllerChange() {
      // Nur nach „Aktualisieren“ neu laden – nicht bei der ersten Übernahme durch clientsClaim.
      if (reloadRequested) reloadOnce();
    },
    applyUpdate() {
      const worker = waitingWorker;
      if (!worker) {
        reloadOnce();
        return;
      }
      reloadRequested = true;
      worker.postMessage({ type: SKIP_WAITING });
      deps.setTimer(reloadOnce, UPDATE_RELOAD_FALLBACK_MS);
    },
  };
}

let controller: UpdateController | null = null;

function updateController(): UpdateController {
  controller ??= createUpdateController({
    reload: () => window.location.reload(),
    setTimer: (callback, ms) => {
      window.setTimeout(callback, ms);
    },
  });
  return controller;
}

function subscribeUpdates(listener: () => void): () => void {
  return updateController().subscribe(listener);
}

function isUpdateWaiting(): boolean {
  return updateController().isWaiting();
}

function noUpdateOnServer(): boolean {
  return false;
}

/** `true`, sobald eine neue Version installiert ist und auf „Aktualisieren“ wartet. */
export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(subscribeUpdates, isUpdateWaiting, noUpdateOnServer);
}

/** Aktion des Update-Banners (auch für `UPDATE_REQUIRED`): SKIP_WAITING → controllerchange → Reload. */
export function applyUpdate(): void {
  updateController().applyUpdate();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unbekannt";
}

function readDevFlag(): boolean {
  try {
    return window.localStorage.getItem(DEV_FLAG_KEY) === "dev";
  } catch (error) {
    console.warn("Lokaler Speicher nicht verfügbar:", errorName(error));
    return false;
  }
}

/**
 * Registriert den SW (bzw. räumt in `next dev` ohne Flag auf) und verdrahtet den Update-Fluss. Einmal je Seite
 * aus dem Root-Layout aufrufen; liefert die Aufräumfunktion.
 */
export function startServiceWorker(): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const container: ContainerLike = navigator.serviceWorker;
  const plan = registrationPlan({ production: process.env.NODE_ENV === "production", devFlag: readDevFlag() });

  if (plan.kind === "unregister") {
    void container
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch((error: unknown) => console.warn("Service Worker: Abmelden fehlgeschlagen:", errorName(error)));
    return () => {};
  }

  const updates = updateController();
  const onControllerChange = () => updates.handleControllerChange();
  container.addEventListener("controllerchange", onControllerChange);

  let registration: RegistrationLike | null = null;
  const checkForUpdate = () => {
    if (!registration || !navigator.onLine) return;
    registration
      .update()
      .catch((error: unknown) => console.warn("Service Worker: Update-Prüfung fehlgeschlagen:", errorName(error)));
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") checkForUpdate();
  };

  void container
    .register(plan.url, { scope: SW_SCOPE, updateViaCache: "none" })
    .then((registered) => {
      registration = registered;
      updates.watch(registered, container);
    })
    .catch((error: unknown) => console.warn("Service Worker: Registrierung fehlgeschlagen:", errorName(error)));
  document.addEventListener("visibilitychange", onVisibilityChange);
  const interval = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);

  return () => {
    container.removeEventListener("controllerchange", onControllerChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.clearInterval(interval);
  };
}
