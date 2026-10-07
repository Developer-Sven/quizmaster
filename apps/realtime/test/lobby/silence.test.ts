import { describe, expect, it } from "vitest";
import { isLobbySilent } from "../../src/lobby/silence.ts";

describe("Netzaussetzer erkennen (ADR-057)", () => {
  const heard = new Map<string, number | null>([
    ["mia", 1_000],
    ["ben", 9_500],
    ["lea", null],
  ]);
  const lastHeard = (guestId: string) => heard.get(guestId) ?? null;

  it("still nur, wenn von keiner aktiven Person etwas kam", () => {
    expect(isLobbySilent(["mia", "ben"], lastHeard, 10_000, 8_000)).toBe(false);
    expect(isLobbySilent(["mia", "lea"], lastHeard, 10_000, 8_000)).toBe(true);
    expect(isLobbySilent(["mia"], lastHeard, 8_999, 8_000)).toBe(false);
    expect(isLobbySilent(["mia"], lastHeard, 9_000, 8_000)).toBe(true);
  });

  it("ohne aktive Menschen (nur Bots) nie still", () => {
    expect(isLobbySilent([], lastHeard, 99_000, 8_000)).toBe(false);
  });
});
