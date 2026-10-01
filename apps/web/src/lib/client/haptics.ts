/**
 * Haptik (docs/09 §10): kurze Vibration über `navigator.vibrate` – nur wo vorhanden (Android/Chromium;
 * iOS-Safari hat die API nicht, dann passiert nichts). Muster: Einloggen 15 ms · richtig [20, 40, 20] ·
 * falsch 60 ms. Ohne vorherige Nutzer-Interaktion wird nicht vibriert: Chromium würde den Aufruf sonst mit
 * einer Konsolen-Warnung („Intervention“) blockieren. Unabhängig vom Ton-Umschalter.
 */

export const HAPTIC_PATTERNS = {
  lock: 15,
  correct: [20, 40, 20],
  wrong: 60,
} as const satisfies Record<string, number | readonly number[]>;

export type HapticKind = keyof typeof HAPTIC_PATTERNS;

/** Der Teil von `navigator`, den die Haptik braucht (austauschbar für Tests). */
export interface VibrationTarget {
  vibrate?: (pattern: number | number[]) => boolean;
  userActivation?: { readonly hasBeenActive: boolean };
}

/** Muster als veränderbarer Wert für `navigator.vibrate`. */
export function hapticPattern(kind: HapticKind): number | number[] {
  const pattern: number | readonly number[] = HAPTIC_PATTERNS[kind];
  return typeof pattern === "number" ? pattern : [...pattern];
}

let warned = false;

function browserNavigator(): VibrationTarget | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

/** Vibriert mit dem Muster `kind`. `false`, wenn die API fehlt, noch keine Interaktion war oder der Browser ablehnt. */
export function vibrate(kind: HapticKind, target: VibrationTarget | undefined = browserNavigator()): boolean {
  if (!target || typeof target.vibrate !== "function") return false;
  if (target.userActivation && !target.userActivation.hasBeenActive) return false;
  try {
    return target.vibrate(hapticPattern(kind));
  } catch (error) {
    // Manche Einbettungen (Permissions-Policy) werfen statt `false` zu liefern – einmal melden, weiterspielen.
    if (!warned) {
      warned = true;
      console.warn("Vibration nicht möglich:", error instanceof Error ? error.name : "unbekannt");
    }
    return false;
  }
}
