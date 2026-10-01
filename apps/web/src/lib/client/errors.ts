/**
 * Fehlercodes → Darstellung im Web-Client (docs/05 §Fehlercodes, docs/09 §11). Jeder Code hat genau eine
 * Darstellung aus `i18n/de.ts` (`errorPresentation`); hier wird zusätzlich entschieden, WO sie erscheint
 * (unter dem Code, unter dem Namen, als Toast, als Banner) und wie der Client reagiert (still
 * synchronisieren, neu anmelden, erneut versuchen, Lobby verlassen). `message` vom Server wird nie gezeigt.
 */
import type { ErrorCode } from "@quizmaster/shared";
import { de, errorPresentation, errorPresentations } from "../../i18n/de";
import type { TurnstileStatus } from "./turnstile";

/** Fehler einer Aktion: Protokoll-Code oder `NETWORK` (kein Ack: Zeitüberschreitung, Trennung, kein Netz). */
export type ClientErrorCode = ErrorCode | "NETWORK";

/** Wo ein Fehler erscheint bzw. was stattdessen passiert. */
export type ErrorPlacement =
  /** inline unter dem Lobby-Code */
  | "code"
  /** inline unter dem Namensfeld */
  | "name"
  /** Toast (Fehler) */
  | "toast"
  /** Banner „Neue Version verfügbar“ */
  | "banner"
  /** kein Text – still per `lobby:resume` synchronisieren */
  | "resync";

/** Fehler, die beim Beitreten unter dem Code stehen (docs/09 §6 „Fehler inline unter dem Code“). */
const CODE_ERRORS: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  "LOBBY_NOT_FOUND",
  "LOBBY_FULL",
  "GAME_IN_PROGRESS",
  "KICKED",
  "BANNED",
  "RESIGNED",
]);

/** Anzeigetext zu einem Fehler. Stille Codes (resync, turnstile) zeigen den allgemeinen Text, falls doch nötig. */
export function errorText(code: ClientErrorCode): string {
  if (code === "NETWORK") return de.connection.lost;
  const presentation = errorPresentation(code);
  switch (presentation.kind) {
    case "message":
      return presentation.text;
    case "reauth":
      return presentation.fallback;
    case "update":
      return de.pwa.updateAvailable;
    default:
      return errorPresentations.INTERNAL.text;
  }
}

/**
 * Hinweis zu einer Aktion (Lobby erstellen, Beitreten), die mit `TURNSTILE_REQUIRED` endet – nach dem automatischen
 * zweiten Versuch (docs/09 §11); `status` = Zustand der Turnstile-Prüfung der Seite, `null` = keine Prüfung (kein
 * Site Key). Die Prüfung zeigt nur ihre eigenen Fehler (Status `error`, `TurnstileSlot`). Hat Cloudflare sie
 * bestanden und der Server das Token trotzdem abgelehnt (falscher Schlüssel, fremder Hostname, Wiederholung), steht
 * sie wieder auf `idle` – dann braucht die Aktion den Hinweis selbst, sonst endete sie ohne jede Rückmeldung.
 * `null` als Ergebnis = die Prüfung zeigt den Fehler schon.
 */
export function turnstileFailureText(status: TurnstileStatus | null): string | null {
  return status === "error" ? null : de.turnstile.failed;
}

/** Beitreten (Startseite und `/j/[code]`): Lobby-Fehler unter dem Code, Namensfehler unter dem Namen. */
export function joinErrorPlacement(code: ClientErrorCode): ErrorPlacement {
  if (CODE_ERRORS.has(code)) return "code";
  if (code === "NAME_REJECTED") return "name";
  if (code === "UPDATE_REQUIRED") return "banner";
  return "toast";
}

/** Lobby erstellen (Startseite): Namensfehler unter dem Namen, alles andere als Toast. */
export function createErrorPlacement(code: ClientErrorCode): ErrorPlacement {
  if (code === "NAME_REJECTED") return "name";
  if (code === "UPDATE_REQUIRED") return "banner";
  return "toast";
}

/**
 * Aktionen in Lobby und Spiel (Start, Wahl, Antwort, Einstellungen …): Fälle, die die Oberfläche
 * verhindert (NOT_HOST, INVALID_PHASE, TOO_LATE …), werden still per `lobby:resume` korrigiert.
 */
export function actionErrorPlacement(code: ClientErrorCode): ErrorPlacement {
  if (code === "NETWORK") return "toast";
  const presentation = errorPresentation(code);
  if (presentation.kind === "resync") return "resync";
  if (presentation.kind === "update") return "banner";
  return "toast";
}

/** Reaktion auf ein gescheitertes `lobby:resume` (docs/05 §Reconnect). */
export type ResumeFailure = "exit" | "retry" | "reauth" | "fatal";

export function resumeFailure(code: ClientErrorCode): ResumeFailure {
  switch (code) {
    case "LOBBY_NOT_FOUND":
    case "KICKED":
    case "RESIGNED":
    case "BANNED":
    case "VALIDATION_FAILED":
      return "exit";
    case "UNAUTHORIZED":
      return "reauth";
    case "UPDATE_REQUIRED":
      return "fatal";
    default:
      return "retry";
  }
}

/** Reaktion auf einen vom Server abgelehnten Verbindungsaufbau (`connect_error` mit Code). */
export type ConnectFailure = "reauth" | "fatal" | "retry" | "turnstile";

export function connectFailure(code: ErrorCode): ConnectFailure {
  switch (code) {
    case "UNAUTHORIZED":
      return "reauth";
    case "UPDATE_REQUIRED":
    case "BANNED":
      return "fatal";
    case "TURNSTILE_REQUIRED":
      return "turnstile";
    default:
      return "retry";
  }
}

/** Codes, bei denen die ganze Seite nicht weiterarbeiten kann (Anzeige statt Neuversuch). */
export function isFatalCode(code: ClientErrorCode): boolean {
  return code === "UPDATE_REQUIRED" || code === "BANNED" || code === "UNAUTHORIZED" || code === "TURNSTILE_REQUIRED";
}

const ERROR_CODE_PATTERN = /^[A-Z_]{3,40}$/;

/** `retryAfterMs` aus `err.data` eines abgelehnten Handshakes (ganze Zahl ≥ 0), sonst `undefined`. */
export function parseConnectErrorRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const value = (data as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Liest den Fehlercode aus einem `connect_error` des Servers: bevorzugt `err.data.code`, sonst
 * `err.message`, wenn sie ein Code ist. Transportfehler („xhr poll error“, „timeout“) liefern `null`.
 */
export function parseConnectErrorCode(
  error: unknown,
  isErrorCode: (value: unknown) => value is ErrorCode,
): ErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data === "object" && data !== null) {
    const code = (data as { code?: unknown }).code;
    if (isErrorCode(code)) return code;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && ERROR_CODE_PATTERN.test(message) && isErrorCode(message)) return message;
  return null;
}
