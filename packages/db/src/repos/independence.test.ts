import { describe, expect, it } from "vitest";
import { countIndependentSources, type FeedbackOrigin } from "./independence.ts";

const origin = (ipKeys: (string | null)[], lobbyCodes: (string | null)[]): FeedbackOrigin => ({ ipKeys, lobbyCodes });
const one = (ipKey: string | null, lobbyCode: string | null) => origin([ipKey], [lobbyCode]);

/** Referenz: Einträge sind verbunden, wenn sie einen IP-Schlüssel oder eine Lobby teilen (Breitensuche). */
function reference(origins: readonly FeedbackOrigin[]): number {
  const norm = (values: readonly (string | null)[]) => (values.length === 0 ? [null] : values);
  const linked = (a: FeedbackOrigin, b: FeedbackOrigin) =>
    norm(a.ipKeys).some((ip) => norm(b.ipKeys).includes(ip)) ||
    norm(a.lobbyCodes).some((lobby) => norm(b.lobbyCodes).includes(lobby));
  const seen = new Set<number>();
  let components = 0;
  for (let start = 0; start < origins.length; start++) {
    if (seen.has(start)) continue;
    components += 1;
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.pop() ?? 0;
      for (let next = 0; next < origins.length; next++) {
        const a = origins[current];
        const b = origins[next];
        if (!seen.has(next) && a !== undefined && b !== undefined && linked(a, b)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return components;
}

/** Deterministischer Zufall (LCG), damit ein Fehlschlag reproduzierbar bleibt. */
function random(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % max;
  };
}

describe("unabhängige Quellen (ADR-058)", () => {
  it("verschiedene IP und verschiedene Lobby: jede Meldung ist eine eigene Quelle", () => {
    expect(countIndependentSources([])).toBe(0);
    expect(countIndependentSources([one("a", "L1"), one("b", "L2"), one("c", "L3")])).toBe(3);
  });

  it("gleiche Lobby oder gleiche IP verbindet – auch über Zwischenschritte", () => {
    // Drei Sessions einer Person (eine IP) in drei Lobbys.
    expect(countIndependentSources([one("a", "L1"), one("a", "L2"), one("a", "L3")])).toBe(1);
    // Drei Mitspielende einer Lobby mit eigenen IPs.
    expect(countIndependentSources([one("a", "L1"), one("b", "L1"), one("c", "L1")])).toBe(1);
    // Kette: a–L1–b–L2–c hängt zusammen, d ist unabhängig.
    expect(
      countIndependentSources([one("a", "L1"), one("b", "L1"), one("b", "L2"), one("c", "L2"), one("d", "L3")]),
    ).toBe(2);
    // Ein Gast mit mehreren IPs/Lobbys verbindet alle davon.
    expect(countIndependentSources([origin(["a", "b"], ["L1"]), one("b", "L2"), one("c", "L3")])).toBe(2);
  });

  it("unbekannte IP oder Lobby (ältere Einträge) hängen zusammen – fail closed", () => {
    expect(countIndependentSources([one(null, "L1"), one(null, "L2"), one(null, "L3")])).toBe(1);
    expect(countIndependentSources([one("a", null), one("b", null), one("c", "L1")])).toBe(2);
    expect(countIndependentSources([origin([], []), origin([], []), one("c", "L1")])).toBe(2);
  });

  it("stimmt mit der Referenz überein (500 zufällige Fälle)", () => {
    const next = random(58);
    const pick = (prefix: string, size: number) => {
      const value = next(size + 1);
      return value === size ? null : `${prefix}${value}`;
    };
    for (let round = 0; round < 500; round++) {
      const entries = Array.from({ length: next(12) }, () =>
        origin(
          Array.from({ length: next(3) }, () => pick("ip", 6)),
          Array.from({ length: next(3) }, () => pick("L", 6)),
        ),
      );
      expect(countIndependentSources(entries), JSON.stringify(entries)).toBe(reference(entries));
    }
  });
});
