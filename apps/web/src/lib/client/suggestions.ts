/**
 * Vorschläge für die Einstellungen (ADR-053) im Client: offene Vorschläge (Host), der eigene offene Vorschlag und
 * die Hinweise aus dem Vergleich zweier Zustände – neuer Vorschlag beim Host, Entscheidung bzw. „Vorschläge aus“
 * bei der vorschlagenden Person. Zurückziehen, Ersetzen und Spielstart bleiben still.
 */
import type { PublicLobbyState, SettingsSuggestion } from "@quizmaster/shared";
import { hostPlayer } from "./game-view";

/** Offene Vorschläge in Einreichungs-Reihenfolge. */
export function pendingSuggestions(lobby: PublicLobbyState): SettingsSuggestion[] {
  return lobby.suggestions.filter((entry) => entry.status === "pending");
}

/** Offener Vorschlag dieser Person – `null`, wenn keiner offen ist. */
export function ownPendingSuggestion(lobby: PublicLobbyState, selfId: string | null): SettingsSuggestion | null {
  return lobby.suggestions.find((entry) => entry.playerId === selfId && entry.status === "pending") ?? null;
}

export type SuggestionNotice =
  | { kind: "suggestionReceived"; name: string }
  | { kind: "suggestionAccepted"; host: string }
  | { kind: "suggestionDeclined"; host: string }
  | { kind: "suggestionsOff" };

/** Hinweise zu Vorschlägen beim Wechsel `previous` → `next` aus Sicht von `selfId`. */
export function suggestionNotices(
  previous: PublicLobbyState | null,
  next: PublicLobbyState,
  selfId: string | null,
): SuggestionNotice[] {
  if (!previous || previous.code !== next.code || selfId === null) return [];
  const self = next.players.find((player) => player.id === selfId);
  if (self?.isHost) {
    const known = new Set(previous.suggestions.map((entry) => entry.id));
    return pendingSuggestions(next).flatMap((entry): SuggestionNotice[] => {
      const name = next.players.find((player) => player.id === entry.playerId)?.name;
      return known.has(entry.id) || name === undefined ? [] : [{ kind: "suggestionReceived", name }];
    });
  }
  const own = ownPendingSuggestion(previous, selfId);
  if (own === null) return [];
  const host = hostPlayer(next.players)?.name ?? "";
  const decided = next.suggestions.find((entry) => entry.id === own.id);
  if (decided?.status === "accepted") return [{ kind: "suggestionAccepted", host }];
  if (decided?.status === "declined") return [{ kind: "suggestionDeclined", host }];
  if (decided === undefined && previous.settings.allowSuggestions && !next.settings.allowSuggestions) {
    return [{ kind: "suggestionsOff" }];
  }
  return [];
}
