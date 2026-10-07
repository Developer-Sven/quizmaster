/**
 * Unabhängige Quellen der Schutzautomatik (ADR-058, docs/08 §5).
 *
 * Gast-Sessions kosten nichts: Ohne weitere Prüfung könnte eine Person mit mehreren Sessions oder eine Gruppe in
 * einer Lobby eine Frage allein aus dem Pool drücken. Gezählt werden deshalb unabhängige Quellen: Meldungen bzw.
 * Daumen-runter, die über denselben IP-Schlüssel (HMAC, IPv6 /64), dieselbe Lobby oder denselben Gast verbunden
 * sind – auch über Zwischenschritte –, bilden zusammen EINE Quelle (Zusammenhangskomponenten per Union-Find über
 * die IP- und Lobby-Knoten; ein Eintrag je Gast verbindet alle seine IPs und Lobbys).
 *
 * Fehlt der IP-Schlüssel bzw. die Lobby (Einträge vor ADR-058, unbekannte IP), gilt „unbekannt“ als gemeinsamer
 * Wert: Solche Einträge hängen zusammen und können eine Frage nie allein über die Schwelle heben (fail closed).
 */

/** Herkunft der Einträge EINES Gasts: seine IP-Schlüssel und Lobby-Codes (`null` = unbekannt). */
export interface FeedbackOrigin {
  readonly ipKeys: readonly (string | null)[];
  readonly lobbyCodes: readonly (string | null)[];
}

/** Höchstzahl gelesener Herkünfte je Frage – darüber zählt die Prüfung nur diese (eher zu wenige: fail closed). */
export const INDEPENDENCE_SCAN_MAX = 5_000;

const UNKNOWN = "?";

/** Anzahl unabhängiger Quellen unter `origins`. */
export function countIndependentSources(origins: readonly FeedbackOrigin[]): number {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root)) root = up;
    // Pfadkompression: Jeder Knoten auf dem Weg zeigt danach direkt auf die Wurzel.
    let current = node;
    while (current !== root) {
      const up = parent.get(current) ?? root;
      parent.set(current, root);
      current = up;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const origin of origins) {
    const ipKeys = origin.ipKeys.length === 0 ? [null] : origin.ipKeys;
    const lobbyCodes = origin.lobbyCodes.length === 0 ? [null] : origin.lobbyCodes;
    const nodes = [
      ...ipKeys.map((ipKey) => `ip:${ipKey ?? UNKNOWN}`),
      ...lobbyCodes.map((lobbyCode) => `lobby:${lobbyCode ?? UNKNOWN}`),
    ];
    for (const node of nodes) if (!parent.has(node)) parent.set(node, node);
    const [first, ...rest] = nodes;
    if (first !== undefined) for (const node of rest) union(first, node);
  }

  let sources = 0;
  for (const node of parent.keys()) if (find(node) === node) sources += 1;
  return sources;
}
