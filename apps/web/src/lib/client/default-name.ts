/**
 * Standardname „Gast-123456“ (ADR-039): Das Namensfeld ist nie leer – wer gleich loslegen will, tippt nur
 * „Lobby erstellen“ bzw. den Code. Der Name wird wie ein selbst gewählter gemerkt und lässt sich jederzeit ändern.
 */
import { readStoredName, writeStoredName } from "./storage";

const DIGITS = 6;
const FALLBACK = "Gast-123456";
const DEFAULT_NAME = /^Gast-(\d{6})$/;

/**
 * Ziffernfolgen, die der Standardname meidet: „88“ (NS-Codes wie 1488 – auch dort, wo der Server sie noch zuließe)
 * und alles, was die Moderation als Wort liest. Sie liest 0, 1, 3, 4, 5, 7 als o, i/l, e, a, s, t (docs/06):
 * „455“/„555“, „7…7“ mit Einsen dazwischen, „55“ direkt nach „Gast-“ oder am Ende. Einmalig gegen alle 10^6
 * Folgen mit der Server-Prüfung abgeglichen (keine abgelehnte bleibt übrig); der Test wiederholt das laufend an
 * einem großen Ausschnitt.
 */
const AVOID: readonly RegExp[] = [/88/, /^55|55$/, /[45]55/, /71+7/];

/** Darf der Standardname diese 6 Ziffern tragen? */
export function isUsableDefaultDigits(digits: string): boolean {
  return /^\d{6}$/.test(digits) && !AVOID.some((pattern) => pattern.test(digits));
}

export function defaultGuestName(random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const digits = String(Math.floor(random() * 10 ** DIGITS)).padStart(DIGITS, "0");
    if (isUsableDefaultDigits(digits)) return `Gast-${digits}`;
  }
  return FALLBACK;
}

/**
 * Gemerkter Name, sonst ein neuer Standardname – der sofort gemerkt wird (Start- und Beitreten-Seite). Ein früher
 * erzeugter Standardname mit gemiedenen Ziffern (der Server würde ihn ablehnen) wird durch einen neuen ersetzt.
 */
export function rememberedOrDefaultName(): string {
  const stored = readStoredName();
  const storedDigits = DEFAULT_NAME.exec(stored)?.[1];
  if (stored && (storedDigits === undefined || isUsableDefaultDigits(storedDigits))) return stored;
  const generated = defaultGuestName();
  writeStoredName(generated);
  return generated;
}
