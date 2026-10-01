/**
 * Flaggenbild einer Bildfrage früh laden (Fairness, W4-Review): Die Frage steht ab Beginn der Phase `question` im
 * Zustand – mit 2 s (erste Frage im Zug) bzw. 800 ms (weitere) Vorlauf vor `startsAt` (docs/05 §Phasen). Ohne
 * Vorladen fordert erst die Fragekarte beim Einhängen zu `startsAt` das SVG an; große Flaggen (bis ~50 KB gzip)
 * erscheinen dann auf langsamen Verbindungen sichtbar nach dem Start des 20-s-Timers. Die Flagge ist Teil der
 * Frage, nicht der Lösung – das Vorladen verrät nichts (die richtige Antwort kommt erst mit `reveal`).
 */

/** Wie in QuestionCard: nur einfache flag-icons-Codes (`de`, `gb-sct`). */
const FLAG_CODE = /^[a-z]{2}(?:-[a-z0-9]{1,8})?$/;
/** Bereits angeforderte Flaggen dieser Seite (der HTTP-/SW-Cache übernimmt den Rest). */
const requested = new Set<string>();

export function flagUrl(code: string): string {
  return `/flags/${code}.svg`;
}

/** Fordert das Flaggenbild an und dekodiert es vor; ein Fehler gibt den Code für einen neuen Versuch frei. */
export function preloadFlag(media: { kind: "flag"; code: string } | null | undefined): void {
  if (typeof window === "undefined" || media?.kind !== "flag" || !FLAG_CODE.test(media.code)) return;
  const code = media.code;
  if (requested.has(code)) return;
  requested.add(code);
  const image = new Image();
  image.decoding = "async";
  image.src = flagUrl(code);
  image.decode().catch((error: unknown) => {
    requested.delete(code);
    console.warn("Flagge nicht vorgeladen:", code, error instanceof Error ? error.name : "unbekannt");
  });
}
