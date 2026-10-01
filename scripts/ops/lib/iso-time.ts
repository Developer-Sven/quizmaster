/**
 * Zeitpunkte für CLI-Optionen wie `--since`: ISO-Datum (`2026-10-01`, Mitternacht UTC) oder Zeitpunkt mit Zone
 * (`2026-10-01T12:00:00Z`, `2026-10-01T14:00:00+02:00`). Ohne Zone wäre die Bedeutung vom Server abhängig – daher
 * nicht erlaubt. Ungültige Kalendertage (V8 verschiebt z. B. 2026-02-30 still auf den 2. März) werden abgelehnt.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Hinweis für Fehlermeldungen der CLIs. */
export const ISO_INSTANT_HINT = "ein ISO-Datum (2026-10-01) oder einen Zeitpunkt mit Zone (2026-10-01T12:00:00Z)";

/** Zeitpunkt oder `null`, wenn `value` kein gültiges ISO-Datum bzw. kein Zeitpunkt mit Zone ist. */
export function parseIsoInstant(value: string): Date | null {
  const text = value.trim();
  if (!ISO_INSTANT.test(text)) return null;
  const date = new Date(text);
  const day = text.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || Number.isNaN(midnight.getTime())) return null;
  return midnight.toISOString().startsWith(day) ? date : null;
}
