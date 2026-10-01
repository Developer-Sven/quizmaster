/**
 * Standardname „Gast-123456“ (ADR-039): Das Namensfeld ist nie leer – wer gleich loslegen will, tippt nur
 * „Lobby erstellen“ bzw. den Code. Der Name wird wie ein selbst gewählter gemerkt und lässt sich jederzeit ändern.
 * Ziffernfolgen mit „88“ meidet er: Die Moderation sperrt NS-Codes wie „1488“ auch in Namen (docs/06).
 */
import { readStoredName, writeStoredName } from "./storage";

const DIGITS = 6;
const AVOID = /88/;

export function defaultGuestName(random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const digits = String(Math.floor(random() * 10 ** DIGITS)).padStart(DIGITS, "0");
    if (!AVOID.test(digits)) return `Gast-${digits}`;
  }
  return "Gast-123456";
}

/** Gemerkter Name, sonst ein neuer Standardname – der sofort gemerkt wird (Start- und Beitreten-Seite). */
export function rememberedOrDefaultName(): string {
  const stored = readStoredName();
  if (stored) return stored;
  const generated = defaultGuestName();
  writeStoredName(generated);
  return generated;
}
