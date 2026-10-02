import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { toPublicState } from "../src/index.ts";
import { lobbyWith, type Simulation } from "./support/simulation.ts";

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function suggestions(sim: Simulation) {
  return toPublicState(sim.state).suggestions;
}

function suggestionOf(sim: Simulation, guestId: string) {
  const playerId = sim.playerId(guestId);
  const suggestion = suggestions(sim).find((entry) => entry.playerId === playerId);
  if (!suggestion) throw new Error(`Kein Vorschlag von ${guestId}`);
  return suggestion;
}

describe("Vorschläge für die Einstellungen (ADR-053)", () => {
  it("Mitglieder schlagen vor, der Host übernimmt mit eigener Anpassung – gespeichert werden nur Abweichungen", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    expect(sim.state.settings.allowSuggestions).toBe(true);
    const revBefore = sim.state.rev;
    sim.ok({
      type: "SUGGEST_SETTINGS",
      guestId: ben,
      changes: { rounds: 5, questionsPerCategory: DEFAULT_LOBBY_SETTINGS.questionsPerCategory },
    });
    const suggestion = suggestionOf(sim, ben);
    expect(suggestion).toMatchObject({ changes: { rounds: 5 }, status: "pending", at: sim.now });
    expect(suggestion.changes).not.toHaveProperty("questionsPerCategory");
    expect(sim.state.rev).toBeGreaterThan(revBefore);
    // Ein Vorschlag ändert nichts – erst der Host entscheidet.
    expect(sim.state.settings.rounds).toBe(DEFAULT_LOBBY_SETTINGS.rounds);

    sim.ok({
      type: "ACCEPT_SUGGESTION",
      guestId: sim.host,
      suggestionId: suggestion.id,
      changes: { rounds: 4, answerSec: 30 },
    });
    expect(sim.state.settings).toMatchObject({ rounds: 4, answerSec: 30 });
    expect(suggestionOf(sim, ben).status).toBe("accepted");
    // Entschieden ist entschieden.
    expect(
      errorCode(sim.dispatch({ type: "DECLINE_SUGGESTION", guestId: sim.host, suggestionId: suggestion.id })),
    ).toBe("INVALID_OPTION");
  });

  it("Übernehmen ohne Anpassung wendet den Vorschlag an, Ablehnen ändert nichts", () => {
    const sim = lobbyWith(3);
    const [, ben = "", lea = ""] = sim.guests;
    sim.ok({ type: "SUGGEST_SETTINGS", guestId: ben, changes: { afterQuestionSec: 0, categoryIds: ["sport"] } });
    sim.ok({ type: "SUGGEST_SETTINGS", guestId: lea, changes: { maxPlayers: 4 } });
    sim.ok({ type: "ACCEPT_SUGGESTION", guestId: sim.host, suggestionId: suggestionOf(sim, ben).id });
    expect(sim.state.settings).toMatchObject({ afterQuestionSec: 0, categoryIds: ["sport"] });
    const settings = sim.state.settings;
    sim.ok({ type: "DECLINE_SUGGESTION", guestId: sim.host, suggestionId: suggestionOf(sim, lea).id });
    expect(sim.state.settings).toEqual(settings);
    expect(suggestions(sim).map((entry) => entry.status)).toEqual(["accepted", "declined"]);
  });

  it("je Person ein Vorschlag: ein neuer ersetzt den alten (neue ID), Zurückziehen entfernt ihn", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    sim.ok({ type: "SUGGEST_SETTINGS", guestId: ben, changes: { rounds: 5 } });
    const first = suggestionOf(sim, ben);
    sim.ok({ type: "SUGGEST_SETTINGS", guestId: ben, changes: { rounds: 6 } });
    const second = suggestionOf(sim, ben);
    expect(suggestions(sim)).toHaveLength(1);
    expect(second.id).not.toBe(first.id);
    expect(second.changes).toEqual({ rounds: 6 });
    // Der alte Vorschlag ist nicht mehr offen.
    expect(errorCode(sim.dispatch({ type: "ACCEPT_SUGGESTION", guestId: sim.host, suggestionId: first.id }))).toBe(
      "INVALID_OPTION",
    );
    // Auch nach einer Entscheidung darf die Person neu vorschlagen.
    sim.ok({ type: "DECLINE_SUGGESTION", guestId: sim.host, suggestionId: second.id });
    sim.ok({ type: "SUGGEST_SETTINGS", guestId: ben, changes: { rounds: 7 } });
    expect(suggestionOf(sim, ben)).toMatchObject({ status: "pending", changes: { rounds: 7 } });
    sim.ok({ type: "WITHDRAW_SUGGESTION", guestId: ben });
    expect(suggestions(sim)).toEqual([]);
    // Nichts mehr zurückzuziehen: keine Änderung, kein Fehler.
    const rev = sim.state.rev;
    sim.ok({ type: "WITHDRAW_SUGGESTION", guestId: ben });
    expect(sim.state.rev).toBe(rev);
  });

  it("abgelehnt: vom Host, bei abgeschalteten Vorschlägen, außerhalb der Lobby, ohne Änderung oder ungültig", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const suggest = (changes: unknown, guestId = ben) =>
      errorCode(sim.dispatch({ type: "SUGGEST_SETTINGS", guestId, changes } as never));
    expect(suggest({ rounds: 5 }, sim.host)).toBe("INVALID_OPTION");
    expect(suggest({ rounds: DEFAULT_LOBBY_SETTINGS.rounds })).toBe("INVALID_OPTION");
    // Personen maximal unter der aktuellen Personenzahl (3).
    expect(suggest({ maxPlayers: 2 })).toBe("INVALID_OPTION");
    expect(suggest({})).toBe("VALIDATION_FAILED");
    expect(suggest({ rounds: 99 })).toBe("VALIDATION_FAILED");
    // Vorschläge an/aus ist Sache des Hosts.
    expect(suggest({ allowSuggestions: false })).toBe("VALIDATION_FAILED");
    expect(suggestions(sim)).toEqual([]);

    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { allowSuggestions: false } });
    expect(suggest({ rounds: 5 })).toBe("INVALID_OPTION");
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { allowSuggestions: true } });

    sim.ok({ type: "START", guestId: sim.host });
    expect(suggest({ rounds: 5 })).toBe("INVALID_PHASE");
  });

  it("nur der Host entscheidet; unbekannte Vorschläge und zu kleine „Personen maximal“ werden abgelehnt", () => {
    const sim = lobbyWith(3);
    const [, ben = "", lea = ""] = sim.guests;
    sim.ok({ type: "SUGGEST_SETTINGS", guestId: ben, changes: { rounds: 5 } });
    const { id } = suggestionOf(sim, ben);
    expect(errorCode(sim.dispatch({ type: "ACCEPT_SUGGESTION", guestId: lea, suggestionId: id }))).toBe("NOT_HOST");
    expect(errorCode(sim.dispatch({ type: "DECLINE_SUGGESTION", guestId: ben, suggestionId: id }))).toBe("NOT_HOST");
    expect(
      errorCode(sim.dispatch({ type: "ACCEPT_SUGGESTION", guestId: sim.host, suggestionId: "gibtesnicht12" })),
    ).toBe("INVALID_OPTION");
    expect(
      errorCode(
        sim.dispatch({ type: "ACCEPT_SUGGESTION", guestId: sim.host, suggestionId: id, changes: { maxPlayers: 2 } }),
      ),
    ).toBe("INVALID_OPTION");
    expect(
      errorCode(
        sim.dispatch({
          type: "ACCEPT_SUGGESTION",
          guestId: sim.host,
          suggestionId: id,
          changes: { allowSuggestions: false },
        } as never),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(suggestionOf(sim, ben).status).toBe("pending");
    expect(sim.state.settings.rounds).toBe(DEFAULT_LOBBY_SETTINGS.rounds);
  });

  it("verschwinden beim Abschalten, beim Spielstart, wenn die Person geht oder Host wird", () => {
    const sim = lobbyWith(4);
    const [, ben = "", lea = "", tom = ""] = sim.guests;
    const suggestAll = () => {
      for (const [index, guestId] of [ben, lea, tom].entries()) {
        sim.ok({ type: "SUGGEST_SETTINGS", guestId, changes: { rounds: 5 + index } });
      }
    };
    suggestAll();
    expect(suggestions(sim)).toHaveLength(3);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { allowSuggestions: false } });
    expect(suggestions(sim)).toEqual([]);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { allowSuggestions: true } });

    suggestAll();
    sim.ok({ type: "LEAVE", guestId: tom });
    expect(suggestions(sim).map((entry) => entry.playerId)).toEqual([sim.playerId(ben), sim.playerId(lea)]);
    // Lea wird Host: ihr eigener Vorschlag entfällt, Bens bleibt für sie zur Entscheidung.
    sim.ok({ type: "TRANSFER_HOST", guestId: sim.host, targetPlayerId: sim.playerId(lea) });
    expect(suggestions(sim).map((entry) => entry.playerId)).toEqual([sim.playerId(ben)]);
    sim.ok({ type: "START", guestId: lea });
    expect(suggestions(sim)).toEqual([]);
  });
});
