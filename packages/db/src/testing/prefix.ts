/**
 * Collection-Präfixe für Testläufe (ADR-029): je Aufruf eindeutig und mit Zeitstempel, damit der
 * Janitor verwaiste Präfixe abgebrochener Läufe erkennt. Format `t<yyMMddHHmm UTC>_<6 Zeichen>_`,
 * z. B. `t2609301812_ab12cd_`.
 */
import { randomInt } from "node:crypto";

export const TEST_PREFIX_REGEX = /^t(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_([a-z0-9]{6})_/;
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RANDOM_LENGTH = 6;

const pad = (value: number) => String(value).padStart(2, "0");

/** Neues Präfix für den Zeitpunkt `now` (UTC). */
export function createTestPrefix(now: Date = new Date(), random: (max: number) => number = randomInt): string {
  const stamp = [
    pad(now.getUTCFullYear() % 100),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
  ].join("");
  let suffix = "";
  for (let index = 0; index < RANDOM_LENGTH; index++) suffix += RANDOM_ALPHABET[random(RANDOM_ALPHABET.length)];
  return `t${stamp}_${suffix}_`;
}

/** Präfix eines Collection-Namens (`null`, wenn kein Test-Präfix). */
export function testPrefixOf(collectionName: string): string | null {
  const match = TEST_PREFIX_REGEX.exec(collectionName);
  return match ? match[0] : null;
}

/** Erstellungszeitpunkt eines Präfixes (UTC, minutengenau) oder `null`. */
export function testPrefixCreatedAt(prefixOrName: string): Date | null {
  const match = TEST_PREFIX_REGEX.exec(prefixOrName);
  if (!match) return null;
  const [, yy, mm, dd, hh, min] = match.map(Number);
  if ([yy, mm, dd, hh, min].some((part) => part === undefined || Number.isNaN(part))) return null;
  const date = new Date(Date.UTC(2000 + (yy ?? 0), (mm ?? 1) - 1, dd ?? 1, hh ?? 0, min ?? 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Escaped ein Präfix für einen `^…`-Regex-Filter auf Collection-Namen. */
export function prefixRegex(prefix: string): RegExp {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}
