/**
 * Sheet „Ergebnis“ der Karte „Letztes Spiel“ (ADR-038): Inhalt serverseitig gerendert (das Sheet selbst hängt sich
 * erst im Browser an `body`).
 */
import type { PublicLobbyState } from "@quizmaster/shared";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type LastGameSnapshot, nextLastGame } from "../../lib/client/last-game";
import { testLobby } from "../../lib/client/test-support";
import { LastGameResult } from "./last-game-sheet";

const RESULTS: NonNullable<PublicLobbyState["results"]> = {
  outcome: "win",
  ranking: [
    { playerId: "p1", place: 1, score: 3, status: "active" },
    { playerId: "p2", place: 2, score: 1, status: "active" },
  ],
};

function lastGame(): LastGameSnapshot {
  const over = testLobby({ phase: "game_over", phaseEndsAt: 55_000, order: ["p1", "p2"], results: RESULTS });
  const snapshot = nextLastGame(null, over, "p1");
  if (snapshot === null) throw new Error("Testaufbau: kein Spielende");
  return snapshot;
}

describe("Ergebnis des letzten Spiels (ADR-038)", () => {
  it("setzt die eigene Ergebniszeile nicht größer als den Sheet-Titel (h2, 22 px): `title` statt `h1`", () => {
    const html = renderToStaticMarkup(h(LastGameResult, { lastGame: lastGame(), categories: {} }));
    const headline = /<p class="([^"]*)">Gewonnen<\/p>/.exec(html)?.[1]?.split(" ") ?? [];
    expect(headline).toContain("text-title");
    expect(headline).not.toContain("text-h1");
    expect(html).toContain('data-testid="last-game-result"');
  });
});
