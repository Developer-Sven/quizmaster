/**
 * Hilfen für die Sicherheits-Invarianten (docs/06, docs/11): Schlüssel, die in Client-Payloads nie bzw.
 * erst ab `reveal` vorkommen dürfen, und eine Tiefensuche für Tests der Engine und des Realtime-Servers.
 */

/** Dürfen vor Phase `reveal` in keinem Client-Payload vorkommen (Invariante 1). */
export const PRE_REVEAL_FORBIDDEN_KEYS = ["correct", "picks", "explanation", "source"] as const;

/** Dürfen in keinem Client-Payload vorkommen (Invariante 4: die guestId ist geheim). */
export const CLIENT_FORBIDDEN_KEYS = ["guestId"] as const;

/**
 * Sucht rekursiv in Objekten/Arrays nach Schlüsseln und liefert die Fundstellen als Pfade
 * (z. B. `question.correct`, `players[2].guestId`). Leeres Ergebnis = Payload sauber.
 */
export function findKeysDeep(value: unknown, keys: Iterable<string>): string[] {
  const wanted = new Set(keys);
  const found: string[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (wanted.has(key)) found.push(childPath);
      visit(child, childPath);
    }
  };
  visit(value, "");
  return found;
}
