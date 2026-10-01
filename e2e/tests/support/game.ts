/**
 * Spielen im Browser (docs/09 §7): Eine Person wählt, wenn sie dran ist, eine Kategorie und beantwortet
 * jede Frage – über dieselben Kacheln/Buttons wie ein Mensch. Mehrere Personen spielen parallel
 * (`Promise.all`). Mit `GAME_TIMING=fast` bleiben 1,5 s für die Wahl und 2 s für eine Antwort.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { Player } from "./player.ts";

/** Aktuelles Bühnen-Overlay (ohne ein gerade ausblendendes, `data-exiting`). */
export function stageOverlay(page: Page, name: string): Locator {
  return page.locator(`[data-testid="overlay-${name}"]:not([data-exiting])`);
}

export type AnswerStrategy =
  /** Antwort „Richtig …“ (Fixtures: answers[0] beginnt mit „Richtig“), sonst die erste */
  | "correct"
  /** immer die erste Antwort (A) */
  | "first";

export interface PlayOptions {
  answer?: AnswerStrategy;
  /** Gesamtfrist bis zum Spielende */
  timeoutMs?: number;
}

export interface PickRecord {
  /** HUD-Fortschritt, z. B. „Runde 1/2 · Zug 3/3“ */
  progress: string;
  /** Name der angetippten Kategorie */
  category: string;
  /** Wahl kam an (die Kategorie steht danach im Kategoriestreifen) */
  accepted: boolean;
}

export interface PlayResult {
  picks: PickRecord[];
  /** beantwortete Fragen */
  answers: number;
  /** Fragen, deren Antwort-Buttons nicht mehr rechtzeitig bedienbar waren */
  missedAnswers: number;
  /** true = Spielende erreicht */
  finished: boolean;
}

/** Runde aus „Runde 2/3 · Zug 1/4“. */
export function roundOf(progress: string): number {
  const match = /Runde (\d+)\//.exec(progress);
  if (!match?.[1]) throw new Error(`Kein Fortschritt im HUD: „${progress}“`);
  return Number(match[1]);
}

export function gameLocators(player: Player): {
  pickTiles: Locator;
  openAnswers: Locator;
  correctAnswer: Locator;
  gameOver: Locator;
  categoryStrip: Locator;
} {
  const page = player.page;
  const question = stageOverlay(page, "question");
  return {
    // Nur die wählende Person sieht die Kacheln als Buttons (Zuschauende: view-only).
    pickTiles: stageOverlay(page, "category-pick").getByRole("button"),
    // Bedienbare Antworten (nach dem Einloggen bzw. nach der Deadline aria-disabled).
    openAnswers: question.getByRole("button", { disabled: false }),
    correctAnswer: question.getByRole("button", { name: /^Richtig/, disabled: false }),
    gameOver: stageOverlay(page, "game-over"),
    categoryStrip: page.getByTestId("category-strip"),
  };
}

/** Wartet, bis die Person eine offene Frage sieht (Antwort-Buttons bedienbar). */
export async function waitForOpenQuestion(player: Player, timeoutMs = 30_000): Promise<void> {
  await gameLocators(player).openAnswers.first().waitFor({ state: "visible", timeout: timeoutMs });
}

/** Tippt eine Antwort an (Strategie) und wartet, bis sie eingeloggt ist. Liefert false, wenn es zu spät war. */
export async function answerQuestion(player: Player, strategy: AnswerStrategy): Promise<boolean> {
  const { openAnswers, correctAnswer } = gameLocators(player);
  const target = strategy === "correct" && (await correctAnswer.count()) > 0 ? correctAnswer : openAnswers;
  let answered = true;
  try {
    await target.first().click({ timeout: 1_500 });
  } catch (error) {
    // Frage inzwischen vorbei (Deadline/Auflösung) – zählt als verpasst, das Spiel läuft weiter.
    if (!(error instanceof Error)) throw error;
    answered = false;
  }
  // Eingeloggt oder vorbei: danach sind keine Antworten dieser Frage mehr bedienbar.
  await expect(openAnswers).toHaveCount(0, { timeout: 5_000 });
  return answered;
}

async function pickCategory(player: Player): Promise<PickRecord> {
  const { pickTiles, categoryStrip } = gameLocators(player);
  const tile = pickTiles.first();
  const category = ((await tile.textContent()) ?? "").trim();
  const progress = ((await player.hudProgress.textContent()) ?? "").trim();
  let clicked = true;
  try {
    await tile.click({ timeout: 1_200 });
  } catch (error) {
    // Wahlzeit vorbei (Server wählt zufällig) – wird als nicht angenommen protokolliert.
    if (!(error instanceof Error)) throw error;
    clicked = false;
  }
  await expect(pickTiles).toHaveCount(0, { timeout: 5_000 });
  let accepted = false;
  if (clicked) {
    // Die Wahl kam an, wenn der Kategoriestreifen genau diese Kategorie zeigt.
    accepted = await expect(categoryStrip)
      .toContainText(category, { timeout: 4_000 })
      .then(() => true)
      .catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        return false;
      });
  }
  return { progress, category, accepted };
}

/**
 * Spielt bis zum Spielende (Overlay „Spielende“): wählt, wenn man dran ist, eine Kategorie und beantwortet jede
 * Frage nach der Strategie.
 */
export async function playUntilGameOver(player: Player, options: PlayOptions = {}): Promise<PlayResult> {
  const answer = options.answer ?? "correct";
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const { pickTiles, openAnswers, gameOver } = gameLocators(player);
  const next = gameOver.or(pickTiles).or(openAnswers);
  const result: PlayResult = { picks: [], answers: 0, missedAnswers: 0, finished: false };

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${player.name}: Spielende nicht rechtzeitig erreicht`);
    await next.first().waitFor({ state: "visible", timeout: remaining });
    if ((await gameOver.count()) > 0) {
      result.finished = true;
      return result;
    }
    if ((await pickTiles.count()) > 0) {
      result.picks.push(await pickCategory(player));
      continue;
    }
    if ((await openAnswers.count()) > 0) {
      if (await answerQuestion(player, answer)) result.answers += 1;
      else result.missedAnswers += 1;
    }
  }
}
