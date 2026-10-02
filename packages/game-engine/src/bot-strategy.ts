/**
 * Dev-Bots (docs/05 §Dev-Bots): wählen zufällig und antworten nach 2–12 s mit sinkender Trefferquote
 * (Schwierigkeit 1: 85 % … 5: 40 %, linear). Reine Funktionen – nutzbar im Realtime-Server (`planBotMoves`
 * mit dem Engine-Zustand) und im Lasttest (ohne Kenntnis der richtigen Antwort → zufällige Antwort).
 * Zeiten skalieren mit dem Timing-Modus: Antwort nach 10–60 % der Antwortzeit (normal 2–12 s),
 * Kategoriewahl nach 10–40 % der Wahlzeit (normal 1,5–6 s).
 */
import { type AnswerIndex, type Difficulty, getTimings, type Timings } from "@quizmaster/shared";
import type { AnswerCommand, PickCommand } from "./commands.ts";
import { chance, pickOne, type Rng } from "./rng.ts";
import { activePlayers, currentQuestion, currentTurn } from "./state.ts";
import type { LobbyState } from "./types.ts";

/** Trefferquote bei Schwierigkeit 1 bzw. 5 (dazwischen linear). */
export const BOT_ACCURACY = { easiest: 0.85, hardest: 0.4 } as const;
/** Antwortverzögerung als Anteil der Antwortzeit (20 s → 2–12 s). */
export const BOT_ANSWER_DELAY_SHARE = { min: 0.1, max: 0.6 } as const;
/** Wahlverzögerung als Anteil der Wahlzeit (15 s → 1,5–6 s). */
export const BOT_PICK_DELAY_SHARE = { min: 0.1, max: 0.4 } as const;

/** Trefferquote eines Bots für eine Schwierigkeit: 85 %, 73,75 %, 62,5 %, 51,25 %, 40 %. */
export function botAccuracy(difficulty: Difficulty): number {
  return BOT_ACCURACY.easiest - ((difficulty - 1) * (BOT_ACCURACY.easiest - BOT_ACCURACY.hardest)) / 4;
}

function delayWithin(totalMs: number, share: { readonly min: number; readonly max: number }, rng: Rng): number {
  const min = Math.round(totalMs * share.min);
  const max = Math.round(totalMs * share.max);
  return min + rng.int(max - min + 1);
}

/** Verzögerung einer Bot-Antwort ab `startsAt` (normal 2.000–12.000 ms). */
export function botAnswerDelayMs(timings: Pick<Timings, "answerMs">, rng: Rng): number {
  return delayWithin(timings.answerMs, BOT_ANSWER_DELAY_SHARE, rng);
}

/** Verzögerung einer Bot-Kategoriewahl ab Phasenbeginn (normal 1.500–6.000 ms). */
export function botPickDelayMs(timings: Pick<Timings, "categoryPickMs">, rng: Rng): number {
  return delayWithin(timings.categoryPickMs, BOT_PICK_DELAY_SHARE, rng);
}

/** Zufällige Kategorie aus den Optionen. */
export function chooseBotCategory<T extends { id: string }>(options: readonly T[], rng: Rng): T {
  return pickOne(options, rng);
}

/**
 * Antwort eines Bots: mit `botAccuracy(difficulty)` die richtige, sonst eine zufällige falsche. Ohne
 * Kenntnis der richtigen Antwort oder der Schwierigkeit (Lasttest-Client) gleichverteilt zufällig.
 */
export function chooseBotAnswer(
  question: { correct: AnswerIndex | null; difficulty: Difficulty | null },
  rng: Rng,
): AnswerIndex {
  const { correct, difficulty } = question;
  if (correct === null || difficulty === null) return rng.int(4) as AnswerIndex;
  if (chance(botAccuracy(difficulty), rng)) return correct;
  const wrong = ([0, 1, 2, 3] as const).filter((index) => index !== correct);
  return pickOne(wrong, rng);
}

/** Geplante Aktion eines Bots: `command` zum Zeitpunkt `at` (Serverzeit) dispatchen. */
export interface BotMove {
  at: number;
  command: PickCommand | AnswerCommand;
}

/**
 * Bot-Aktionen für die aktuelle Phase: Kategoriewahl, wenn ein Bot wählt; Antworten aller aktiven Bots,
 * die die laufende Frage noch nicht beantwortet haben. Die Shell ruft das nach jedem Phasenwechsel
 * (`phaseToken` geändert) auf und plant die Commands; verspätete/doppelte Aktionen lehnt `reduce` ab.
 */
export function planBotMoves(state: LobbyState, rng: Rng): BotMove[] {
  const timings = getTimings(state.timing);
  const bots = activePlayers(state).filter((player) => player.isBot);
  if (bots.length === 0 || state.closed !== null) return [];
  const turn = currentTurn(state.game);
  if (state.phase === "category_pick" && turn && turn.categoryId === null) {
    const picker = bots.find((bot) => bot.playerId === turn.pickerId);
    if (!picker) return [];
    const option = chooseBotCategory(turn.options, rng);
    return [
      {
        at: state.phaseStartedAt + botPickDelayMs(timings, rng),
        command: { type: "PICK", guestId: picker.guestId, categoryId: option.id },
      },
    ];
  }
  const question = currentQuestion(state.game);
  if (state.phase !== "question" || !turn || !question || question.startsAt === null) return [];
  const startsAt = question.startsAt;
  // Kurze Antwortzeit (ADR-049, z. B. 10 s): Bots antworten spätestens 500 ms vor der Deadline.
  const latest = question.deadline === null ? Number.POSITIVE_INFINITY : question.deadline - 500;
  return bots
    .filter(
      (bot) =>
        turn.participantIds.includes(bot.playerId) &&
        !question.responses.some((entry) => entry.playerId === bot.playerId),
    )
    .map((bot) => ({
      at: Math.max(startsAt, Math.min(startsAt + botAnswerDelayMs(timings, rng), latest)),
      command: {
        type: "ANSWER",
        guestId: bot.guestId,
        questionId: question.instanceId,
        choice: chooseBotAnswer({ correct: question.correct, difficulty: question.difficulty }, rng),
      },
    }));
}
