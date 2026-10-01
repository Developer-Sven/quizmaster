/**
 * Nur für Tests: gültige Beispiel-Zustände (docs/05 §Zustände) mit wenigen Zeilen erzeugen.
 */

import type { BoardRow, PrivatePlayerState, PublicLobbyState, PublicPlayer, PublicQuestion } from "@quizmaster/shared";
import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";

export function testPlayer(id: string, patch: Partial<PublicPlayer> = {}): PublicPlayer {
  return {
    id,
    name: id.toUpperCase(),
    color: "blue",
    isHost: false,
    isBot: false,
    connected: true,
    status: "active",
    score: 0,
    ...patch,
  };
}

export function testLobby(patch: Partial<PublicLobbyState> = {}): PublicLobbyState {
  return {
    rev: 1,
    protocolVersion: 1,
    code: "ABC234",
    phase: "lobby",
    phaseStartedAt: 1_000,
    phaseEndsAt: null,
    settings: { ...DEFAULT_LOBBY_SETTINGS },
    players: [testPlayer("p1", { isHost: true, name: "Mia" }), testPlayer("p2", { name: "Ben", color: "sky" })],
    order: null,
    progress: null,
    turn: null,
    question: null,
    board: [],
    results: null,
    ...patch,
  };
}

export function testQuestion(patch: Partial<PublicQuestion> = {}): PublicQuestion {
  return {
    id: "q1",
    index: 1,
    total: 3,
    categoryId: "musik-hits",
    prompt: "Wie heißt die Hauptstadt von Australien?",
    answers: ["Sydney", "Canberra", "Melbourne", "Perth"],
    media: null,
    startsAt: 10_000,
    deadline: 30_000,
    answeredBy: [],
    ...patch,
  };
}

export function testSelf(playerId: string, patch: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
  return { playerId, isHost: false, canPick: false, myAnswer: null, ...patch };
}

export function testRow(
  round: number,
  pickerId: string,
  results: BoardRow["results"],
  categoryId = "musik-hits",
): BoardRow {
  return { round, pickerId, categoryId, results };
}
