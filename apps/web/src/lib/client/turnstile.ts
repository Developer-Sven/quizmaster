/**
 * Cloudflare Turnstile im Browser (docs/06 §Bot-Schutz, ADR-011): Das Skript von challenges.cloudflare.com wird
 * erst geladen, wenn eine Session angelegt wird oder der Server `TURNSTILE_REQUIRED` meldet (lazy). Es bekommt die
 * CSP-Nonce der Seite; `'strict-dynamic'` erlaubt es ohnehin, weil ein vertrauenswürdiges Skript es einfügt.
 *
 * Widget: Modus „Managed“ (Einstellung des Site Keys im Cloudflare-Dashboard), explizit gerendert in einen
 * Container der Seite, sichtbar nur, wenn Cloudflare eine Bestätigung verlangt (`appearance: interaction-only`),
 * dunkles Thema, Deutsch. Jedes Token gilt genau einmal – je Lösung wird das Widget neu gerendert und danach
 * entfernt; Lösungen laufen nacheinander. Fehler (Skript nicht ladbar, Widget-Fehler, abgelaufene oder nicht
 * bestätigte Prüfung) enden mit `null` und Status `error` – ohne automatische Wiederholung, die nächste Aktion
 * startet eine neue Prüfung.
 *
 * Kein React, kein zod: als reines Modul testbar und klein im Start-Bundle.
 */

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Höchstdauer, bis das Skript geladen ist. */
export const TURNSTILE_LOAD_TIMEOUT_MS = 15_000;
/** Höchstdauer einer Prüfung (inkl. Bestätigung durch die Person). */
export const TURNSTILE_SOLVE_TIMEOUT_MS = 120_000;

/** Wofür das Token gebraucht wird (Turnstile-`action`, im Cloudflare-Dashboard auswertbar). */
export type TurnstilePurpose = "session" | "join";

/**
 * - `idle`: keine Prüfung aktiv
 * - `loading`: Skript lädt
 * - `running`: Prüfung läuft unsichtbar
 * - `interactive`: Cloudflare verlangt eine Bestätigung (Widget sichtbar)
 * - `error`: letzte Prüfung fehlgeschlagen
 */
export type TurnstileStatus = "idle" | "loading" | "running" | "interactive" | "error";

/** Optionen von `turnstile.render` (Ausschnitt der Cloudflare-API). */
export interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: "auto" | "light" | "dark";
  language?: string;
  appearance?: "always" | "execute" | "interaction-only";
  size?: "normal" | "flexible" | "compact";
  retry?: "auto" | "never";
  "refresh-expired"?: "auto" | "manual" | "never";
  callback?: (token: string) => void;
  "error-callback"?: (code: string) => boolean | undefined;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  "unsupported-callback"?: () => void;
  "before-interactive-callback"?: () => void;
  "after-interactive-callback"?: () => void;
}

/** `window.turnstile` (Ausschnitt). */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | null | undefined;
  remove(widgetId: string): void;
}

interface TurnstileWindow {
  turnstile?: TurnstileApi;
}

/**
 * CSP-Nonce der Seite: Next setzt sie auf seine Skripte. Browser verbergen das Attribut (Schutz vor Auslesen per
 * CSS), die Eigenschaft `nonce` bleibt für Skripte lesbar.
 */
export function pageNonce(doc: Pick<Document, "querySelectorAll">): string | null {
  for (const script of Array.from(doc.querySelectorAll("script"))) {
    if (script.nonce) return script.nonce;
  }
  return null;
}

export interface LoadTurnstileOptions {
  doc?: Document;
  win?: TurnstileWindow;
  timeoutMs?: number;
}

let loading: Promise<TurnstileApi> | null = null;

/** Lädt das Turnstile-Skript einmal (gleichzeitige Aufrufe teilen sich den Ladevorgang; nach Fehlern erneut). */
export function loadTurnstile(options: LoadTurnstileOptions = {}): Promise<TurnstileApi> {
  const win: TurnstileWindow = options.win ?? (window as unknown as TurnstileWindow);
  const doc = options.doc ?? document;
  if (win.turnstile) return Promise.resolve(win.turnstile);
  if (loading) return loading;
  const timeoutMs = options.timeoutMs ?? TURNSTILE_LOAD_TIMEOUT_MS;
  const attempt = new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement("script");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      clearTimeout(timer);
      script.remove();
      reject(new Error(message));
    };
    timer = setTimeout(() => fail("Turnstile: Zeitüberschreitung beim Laden"), timeoutMs);
    script.addEventListener("load", () => {
      clearTimeout(timer);
      if (win.turnstile) resolve(win.turnstile);
      else fail("Turnstile: Skript ohne API");
    });
    script.addEventListener("error", () => fail("Turnstile: Skript nicht ladbar"));
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    const nonce = pageNonce(doc);
    if (nonce) script.nonce = nonce;
    doc.head.appendChild(script);
  });
  loading = attempt;
  // Nach einem Fehler darf der nächste Versuch neu laden.
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}

/** Nur für Tests: Ladezustand vergessen. */
export function resetTurnstileLoaderForTests(): void {
  loading = null;
}

export interface TurnstileSolver {
  /** Löst eine Prüfung; `null` = fehlgeschlagen oder abgebrochen (Status `error`). Läuft nacheinander. */
  solve(purpose: TurnstilePurpose): Promise<string | null>;
  getStatus(): TurnstileStatus;
  /** Benachrichtigung bei jedem Statuswechsel (für `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Container des Widgets (Callback-Ref der Komponente); `null` beim Aushängen. */
  attach(element: HTMLElement | null): void;
  /**
   * Ansicht ausgehängt: laufende Prüfung abbrechen (Widget entfernen); bis `resume` liefert `solve` sofort `null`.
   * Umkehrbar, weil React (StrictMode) Effekte beim Einhängen probeweise auf- und wieder abbaut.
   */
  suspend(): void;
  /** Ansicht (wieder) eingehängt. */
  resume(): void;
}

export interface TurnstileSolverOptions {
  siteKey: string;
  load?: () => Promise<TurnstileApi>;
  solveTimeoutMs?: number;
}

export function createTurnstileSolver(options: TurnstileSolverOptions): TurnstileSolver {
  const load = options.load ?? (() => loadTurnstile());
  const solveTimeoutMs = options.solveTimeoutMs ?? TURNSTILE_SOLVE_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  let status: TurnstileStatus = "idle";
  let container: HTMLElement | null = null;
  let suspended = false;
  let cancelCurrent: (() => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const setStatus = (next: TurnstileStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of [...listeners]) listener();
  };

  const run = async (purpose: TurnstilePurpose): Promise<string | null> => {
    if (suspended) return null;
    setStatus("loading");
    let api: TurnstileApi;
    try {
      api = await load();
    } catch (error) {
      console.error("Turnstile nicht geladen:", error instanceof Error ? error.message : "unbekannt");
      setStatus("error");
      return null;
    }
    const host = container;
    if (suspended || host === null) {
      setStatus(suspended ? "idle" : "error");
      return null;
    }
    setStatus("running");
    return new Promise<string | null>((resolve) => {
      let widgetId: string | null | undefined;
      let settled = false;
      const finish = (token: string | null, next: TurnstileStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelCurrent = null;
        if (widgetId) {
          try {
            api.remove(widgetId);
          } catch (error) {
            console.error("Turnstile-Widget nicht entfernt:", error instanceof Error ? error.message : "unbekannt");
          }
        }
        setStatus(next);
        resolve(token);
      };
      const timer = setTimeout(() => finish(null, "error"), solveTimeoutMs);
      cancelCurrent = () => finish(null, "idle");
      try {
        widgetId = api.render(host, {
          sitekey: options.siteKey,
          action: purpose,
          theme: "dark",
          language: "de",
          appearance: "interaction-only",
          size: "flexible",
          retry: "never",
          "refresh-expired": "never",
          callback: (token) => finish(token, "idle"),
          "error-callback": () => {
            finish(null, "error");
            // Fehler ist behandelt (eigene Meldung statt Ausnahme bzw. Konsolenwarnung des Widgets).
            return true;
          },
          "expired-callback": () => finish(null, "error"),
          "timeout-callback": () => finish(null, "error"),
          "unsupported-callback": () => finish(null, "error"),
          "before-interactive-callback": () => {
            if (!settled) setStatus("interactive");
          },
          "after-interactive-callback": () => {
            if (!settled) setStatus("running");
          },
        });
      } catch (error) {
        console.error("Turnstile-Widget nicht gerendert:", error instanceof Error ? error.message : "unbekannt");
        finish(null, "error");
      }
    });
  };

  return {
    solve(purpose) {
      const next = queue.then(() => run(purpose));
      queue = next.catch(() => null);
      return next;
    },
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(element) {
      container = element;
    },
    suspend() {
      suspended = true;
      cancelCurrent?.();
    },
    resume() {
      suspended = false;
    },
  };
}
