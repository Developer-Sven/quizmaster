/**
 * Teilen und Kopieren (docs/10 §App-Gefühl „Teilen“): Web Share API (`navigator.share`), sonst Kopieren
 * in die Zwischenablage. Abbrechen des Teilen-Dialogs ist kein Fehler.
 */

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

export interface ShareData {
  title: string;
  text: string;
  url: string;
}

/** Kopiert Text: Clipboard-API, sonst unsichtbares Textfeld + `execCommand` (ältere Browser). */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // Kein Zugriff (Berechtigung, unsicherer Kontext) – weiter mit dem Ersatzweg unten.
      console.warn("Zwischenablage nicht verfügbar:", error instanceof Error ? error.name : "unbekannt");
    }
  }
  if (typeof document === "undefined") return false;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.className = "sr-only";
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    console.warn("Kopieren nicht möglich:", error instanceof Error ? error.name : "unbekannt");
  }
  field.remove();
  return copied;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Teilt über das System-Menü, sonst wird der Link kopiert. */
export async function shareOrCopy(data: ShareData): Promise<ShareOutcome> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const canShare = typeof navigator.canShare !== "function" || navigator.canShare(data);
    if (canShare) {
      try {
        await navigator.share(data);
        return "shared";
      } catch (error) {
        if (isAbort(error)) return "cancelled";
        console.warn("Teilen nicht möglich:", error instanceof Error ? error.name : "unbekannt");
      }
    }
  }
  return (await copyText(data.url)) ? "copied" : "failed";
}
