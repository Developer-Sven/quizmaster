import { describe, expect, it } from "vitest";
import {
  addHistory,
  currentOf,
  emptyState,
  parseState,
  popActivation,
  previousOf,
  pruneStack,
  pushActivation,
  releasesToDelete,
} from "./state.ts";

const sha = (char: string) => char.repeat(40);
const A = sha("a");
const B = sha("b");
const C = sha("c");
const D = sha("d");

describe("Rollback-Stapel", () => {
  it("Deploys legen auf, gleiches SHA oben wird nur aktualisiert", () => {
    let state = emptyState();
    state = pushActivation(state, A, "t1");
    state = pushActivation(state, B, "t2");
    state = pushActivation(state, B, "t3");
    expect(state.stack).toEqual([
      { sha: A, at: "t1" },
      { sha: B, at: "t3" },
    ]);
    expect(currentOf(state)).toBe(B);
    expect(previousOf(state)).toBe(A);
  });

  it("Rollback geht schrittweise zurück und endet beim ersten Release", () => {
    let state = [A, B, C].reduce((acc, value, index) => pushActivation(acc, value, `t${index}`), emptyState());
    const first = popActivation(state);
    expect(first.target).toBe(B);
    state = first.state;
    const second = popActivation(state);
    expect(second.target).toBe(A);
    expect(() => popActivation(second.state)).toThrow(/kein vorheriges Release/);
  });

  it("entfernt Einträge ohne Release-Verzeichnis", () => {
    const state = [A, B, C].reduce((acc, value) => pushActivation(acc, value, "t"), emptyState());
    expect(pruneStack(state, new Set([A, C])).stack.map((entry) => entry.sha)).toEqual([A, C]);
  });

  it("Historie ist begrenzt", () => {
    let state = emptyState();
    for (let index = 0; index < 150; index++) {
      state = addHistory(state, { at: `t${index}`, action: "deploy", sha: A, from: null, result: "ok" });
    }
    expect(state.history).toHaveLength(100);
    expect(state.history[0]?.at).toBe("t50");
  });
});

describe("Aufbewahrung (3 Releases)", () => {
  it("behält die drei jüngsten verschiedenen Releases des Stapels", () => {
    const state = [A, B, C, D].reduce((acc, value) => pushActivation(acc, value, "t"), emptyState());
    expect(releasesToDelete(state, [A, B, C, D], 3)).toEqual([A]);
  });

  it("löscht fehlgeschlagene Releases (nicht im Stapel), schützt aber ausdrücklich genannte", () => {
    const state = [A, B].reduce((acc, value) => pushActivation(acc, value, "t"), emptyState());
    expect(releasesToDelete(state, [A, B, C, D], 3)).toEqual([C, D]);
    expect(releasesToDelete(state, [A, B, C, D], 3, new Set([D]))).toEqual([C]);
  });

  it("zählt doppelte Stapeleinträge nur einmal", () => {
    const state = [A, B, A, C].reduce((acc, value) => pushActivation(acc, value, "t"), emptyState());
    expect(releasesToDelete(state, [A, B, C, D], 2)).toEqual([B, D]);
  });
});

describe("parseState", () => {
  it("weist beschädigte Dateien ohne Inhaltsausschnitt zurück", () => {
    expect(() => parseState("{kaputt")).toThrow(/kein gültiges JSON/);
    expect(() => parseState(JSON.stringify({ version: 2, stack: [], history: [] }))).toThrow(/Format/);
    expect(() => parseState(JSON.stringify({ version: 1, stack: [{ sha: "x", at: "t" }], history: [] }))).toThrow(
      /Stapel/,
    );
  });
});
