/**
 * Gesehene Fragen einer Lobby (docs/04 §Fragenauswahl 3, docs/01 §Fragenauswahl): Beim Spielstart (Phase
 * `intro`) werden die `recentQuestionIds` aller menschlichen Mitspielenden geladen und mit den Fragen der
 * bisherigen Spiele dieser Lobby vereinigt (`buildSeenQuestions`). Die Lobby-Historie deckt Revanchen ab,
 * deren Vorgängerspiel noch nicht (oder wegen eines DB-Fehlers gar nicht) in `guests` gespeichert ist.
 *
 * Fehler oder Zeitüberschreitung beim Laden → nur die Lobby-Historie (das Spiel läuft weiter, es werden dann
 * eben seltener schon gesehene Fragen vermieden). Wirft nie.
 */
import type { GuestsRepo } from "@quizmaster/db";
import { buildSeenQuestions, type SeenQuestions } from "@quizmaster/game-engine";
import { guestIdSchema } from "@quizmaster/shared";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { withTimeout } from "../registry/util.ts";

/** Frist für das Laden der gesehenen Fragen (weit unter der Engine-Frist für Shell-Anfragen). */
export const SEEN_QUESTIONS_TIMEOUT_MS = 3_000;
/** So viele Fragen früherer Spiele merkt sich eine Lobby (wie `recentQuestionIds` je Gast). */
export const LOBBY_HISTORY_MAX = 1_000;

export interface SeenQuestionsDeps {
  guests: Pick<GuestsRepo, "loadRecentQuestionIds">;
  logger: Logger;
  metrics: RealtimeMetrics;
  timeoutMs?: number;
}

/**
 * Lädt die gesehenen Fragen für die übergebenen Gäste (Bots/ungültige IDs werden übersprungen) und
 * vereinigt sie mit `history` (Fragen früherer Spiele der Lobby, älteste vorne).
 */
export async function loadSeenQuestions(
  deps: SeenQuestionsDeps,
  guestIds: readonly string[],
  history: readonly string[],
): Promise<SeenQuestions> {
  const humans = [...new Set(guestIds.filter((guestId) => guestIdSchema.safeParse(guestId).success))];
  if (humans.length === 0) return buildSeenQuestions([history]);
  try {
    const lists = await withTimeout(
      deps.guests.loadRecentQuestionIds(humans),
      deps.timeoutMs ?? SEEN_QUESTIONS_TIMEOUT_MS,
      "Gesehene Fragen",
    );
    return buildSeenQuestions([...lists.values(), history]);
  } catch (error) {
    deps.metrics.recordMongoError("seen_questions");
    deps.logger.warn({ err: error, guests: humans.length }, "Gesehene Fragen nicht geladen – nur Lobby-Historie");
    return buildSeenQuestions([history]);
  }
}

/** Hängt die Fragen eines beendeten Spiels an die Lobby-Historie an (gekürzt auf die neuesten Einträge). */
export function appendHistory(history: string[], questionIds: readonly string[]): void {
  history.push(...questionIds);
  if (history.length > LOBBY_HISTORY_MAX) history.splice(0, history.length - LOBBY_HISTORY_MAX);
}
