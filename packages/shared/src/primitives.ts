/**
 * Wiederverwendbare zod-Bausteine für Protokoll, HTTP und Datenbank-Dokumente. Längengrenzen sind
 * bewusst eng (docs/06 Invariante 5); Server→Client-Schemas nutzen großzügigere Obergrenzen, damit
 * gültige Inhalte nie am Schema scheitern.
 */

import { ANSWER_INDEXES } from "./constants.ts";
import { LOBBY_CODE_INPUT_MAX_LENGTH, LOBBY_CODE_REGEX, normalizeLobbyCode } from "./lobby-code.ts";
import { NAME_INPUT_MAX_LENGTH } from "./names.ts";
import * as z from "./zod.ts";

/** Serverzeit in ms seit Epoche (`Date.now()`); Client-Zeitstempel sind nie maßgeblich. */
export const timestampSchema = z.int().min(0);

/** Öffentliche, zufällige IDs (playerId, Frage-Instanz-ID): 1–32 Zeichen `A–Z a–z 0–9 _ -`. */
export const PUBLIC_ID_REGEX = /^[A-Za-z0-9_-]{1,32}$/;

/** Öffentliche Spieler-ID – zufällig, NICHT die geheime guestId. */
export const playerIdSchema = z.string().regex(PUBLIC_ID_REGEX);

/**
 * Instanz-ID einer Frage in diesem Spiel (vom Server vergeben, undurchsichtig) – nicht die DB-ID.
 * Der Server bildet sie für `question:rate`/`question:report` selbst auf die DB-ID ab.
 */
export const questionInstanceIdSchema = z.string().regex(PUBLIC_ID_REGEX);

/** Slug in Kleinbuchstaben mit Bindestrichen (Kategorie-IDs, Lucide-Icon-Namen). */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Kategorie-ID = Slug aus `content/categories.json` (z. B. „rund-um-die-welt“). */
export const categoryIdSchema = z.string().max(64).regex(SLUG_REGEX);

/** Lucide-Icon-Name (docs/09 §9), z. B. „book-open“. */
export const iconNameSchema = z.string().max(64).regex(SLUG_REGEX);

/** Farbe als `#RRGGBB`. */
export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** Antwort-Index in der angezeigten Reihenfolge. */
export const answerIndexSchema = z.literal(ANSWER_INDEXES);

/** Flaggen-Code wie in `content/schema/question-file.schema.json` (ISO 3166-1 alpha-2, gb-eng …). */
export const FLAG_CODE_REGEX = /^[a-z]{2}(-[a-z]{2,3})?$|^(eu|un|arab|asean|cefta|eac|pc)$/;

export const flagMediaSchema = z.strictObject({ kind: z.literal("flag"), code: z.string().regex(FLAG_CODE_REGEX) });
/** Bild-Medium einer Frage (derzeit nur Flaggen) oder `null`. */
export const mediaSchema = flagMediaSchema.nullable();
export type Media = z.output<typeof mediaSchema>;

/** Normalisierter Lobby-Code (6 Zeichen aus dem Alphabet, docs/05). */
export const lobbyCodeSchema = z.string().regex(LOBBY_CODE_REGEX);

/** Rohe Code-Eingabe aus Client-Payloads: wird normalisiert („abc-234“ → „ABC234“) und dann geprüft. */
export const lobbyCodeInputSchema = z
  .string()
  .max(LOBBY_CODE_INPUT_MAX_LENGTH)
  .transform(normalizeLobbyCode)
  .pipe(lobbyCodeSchema);

/**
 * Roher Name aus Client-Payloads. Nur Typ und Länge – die Namensregeln (Format, reserviert,
 * Schimpfwörter) prüft der Server danach und antwortet mit `NAME_REJECTED`, nicht `VALIDATION_FAILED`.
 */
export const nameInputSchema = z.string().min(1).max(NAME_INPUT_MAX_LENGTH);

/** Angezeigter (bereits geprüfter) Name in Server-Payloads. */
export const displayNameSchema = z.string().min(1).max(NAME_INPUT_MAX_LENGTH);
