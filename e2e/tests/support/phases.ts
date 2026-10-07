/**
 * Gezieltes Spielen für Phasen-Prüfungen (Szenario 9 und 12, Normal-Stack mit `GAME_TIMING=normal`): auf ein
 * bestimmtes Bühnen-Overlay warten, die wählende Person bestimmen, gezielt richtig/falsch antworten. Anders als
 * `playUntilGameOver` (game.ts) steuert der Test jeden Schritt selbst, damit er in jeder Phase prüfen kann.
 */
import { expect, type Locator } from "@playwright/test";
import { CORRECT_ANSWER_NAME, OTHER_ANSWER_NAME, stageOverlay } from "./game.ts";
import type { Player } from "./player.ts";

/** Overlay-Namen der Bühne (docs/09 §7, `data-testid="overlay-<name>"`). */
export type OverlayName =
  | "intro"
  | "category-pick"
  | "category-reveal"
  | "question"
  | "answer-reveal"
  | "turn-summary"
  | "round-board"
  | "game-over";

/**
 * Wartet, bis das Overlay steht (eingehängt und nicht am Ausblenden) und liefert es. Erscheint es nicht, nennt
 * der Fehler die aktuelle Spielphase – z. B. `game_over`, wenn der Server das Spiel abgebrochen hat (etwa weil
 * die Test-DB Fragen nicht liefern konnte, `LOAD_FAILED`).
 */
export async function waitForOverlay(player: Player, name: OverlayName, timeout = 30_000): Promise<Locator> {
  const overlay = stageOverlay(player.page, name);
  try {
    await expect(overlay, `${player.name}: Overlay ${name}`).toBeVisible({ timeout });
  } catch (error) {
    const screen = player.page.getByTestId("game-screen");
    const phase = (await screen.count()) > 0 ? await screen.getAttribute("data-phase") : null;
    throw new Error(`${player.name}: Overlay ${name} nicht erschienen (Spielphase: ${phase ?? "kein Spiel"})`, {
      cause: error,
    });
  }
  return overlay;
}

/** Kacheln der Kategoriewahl, die diese Person antippen kann (nur die wählende Person sieht Buttons). */
function pickButtons(player: Player): Locator {
  return stageOverlay(player.page, "category-pick").getByRole("button");
}

/** Kategoriewahl: wer wählt, wer schaut zu (alle sehen das Overlay). */
export async function pickRoles(players: readonly Player[]): Promise<{ picker: Player; watchers: Player[] }> {
  await Promise.all(players.map((player) => waitForOverlay(player, "category-pick")));
  let picker: Player | undefined;
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(players.map((player) => pickButtons(player).count()));
        picker = players[counts.findIndex((count) => count > 0)];
        return counts.filter((count) => count > 0).length;
      },
      { message: "genau eine Person wählt" },
    )
    .toBe(1);
  if (!picker) throw new Error("keine wählende Person");
  const chosen = picker;
  return { picker: chosen, watchers: players.filter((player) => player !== chosen) };
}

/** Wählt die erste angebotene Kategorie und wartet, bis die Wahl angenommen ist (Kacheln nicht mehr bedienbar). */
export async function pickFirstCategory(player: Player): Promise<void> {
  await pickButtons(player).first().click();
  await expect(pickButtons(player)).toHaveCount(0);
}

/**
 * Kategoriewahl mit Dev-Bots, bis die erste Person die Frage sieht: Ist eine der Personen dran, wählt sie die erste
 * Kategorie; sonst wählt ein Bot selbst. Niemand antwortet dabei.
 */
export async function pickUntilQuestion(players: readonly Player[], timeoutMs = 60_000): Promise<void> {
  const first = players[0];
  if (!first) throw new Error("keine Personen");
  const deadline = Date.now() + timeoutMs;
  while ((await stageOverlay(first.page, "question").count()) === 0) {
    if (Date.now() > deadline) throw new Error("Frage nach der Kategoriewahl nicht erreicht");
    for (const player of players) {
      if ((await pickButtons(player).count()) > 0) await pickFirstCategory(player);
    }
    await first.page.waitForTimeout(250);
  }
}

/** Bedienbare Antworten der laufenden Frage. */
export function openAnswers(player: Player): Locator {
  return stageOverlay(player.page, "question").getByRole("button", { disabled: false });
}

/**
 * Antwortet gezielt: `correct` = Antwort „Richtig …“ (Fixtures und Langtext-Variante), `wrong` = eine andere
 * (zugängliche Namen beginnen mit dem Buchstaben, siehe `CORRECT_ANSWER_NAME`).
 * Wartet, bis die Antwort eingeloggt ist.
 */
export async function answer(player: Player, which: "correct" | "wrong"): Promise<void> {
  const name = which === "correct" ? CORRECT_ANSWER_NAME : OTHER_ANSWER_NAME;
  const question = stageOverlay(player.page, "question");
  await question.getByRole("button", { name, disabled: false }).first().click();
  await expect(openAnswers(player), `${player.name}: Antwort eingeloggt`).toHaveCount(0);
}

/** Buchstaben der Antworten (Tastenkürzel `A`–`D`, docs/09 §12). */
const ANSWER_LETTERS = ["A", "B", "C", "D"] as const;

/**
 * Antwortet per Tastatur (docs/09 §12: `1`–`4` bzw. `A`–`D`; die Antwortgruppe hat beim Öffnen den Fokus):
 * sucht die Position der gewünschten Antwort und drückt ihre Ziffer bzw. ihren Buchstaben. Liefert die Position.
 */
export async function answerByKeyboard(
  player: Player,
  which: "correct" | "wrong",
  key: "digit" | "letter",
): Promise<number> {
  const question = stageOverlay(player.page, "question");
  const texts = await Promise.all(
    [0, 1, 2, 3].map(async (index) => (await question.getByTestId(`answer-${index}`).textContent()) ?? ""),
  );
  const index = texts.findIndex((text) => text.includes("Richtig") === (which === "correct"));
  if (index < 0) throw new Error(`${player.name}: keine passende Antwort (${which})`);
  await player.page.keyboard.press(key === "digit" ? String(index + 1) : (ANSWER_LETTERS[index] ?? "A"));
  await expect(openAnswers(player), `${player.name}: Antwort per Tastatur eingeloggt`).toHaveCount(0);
  return index;
}

/** Kategoriewahl per Tastatur `1`–`3` (docs/09 §12); liefert den Namen der gewählten Kachel. */
export async function pickByKeyboard(player: Player, position: 1 | 2 | 3): Promise<string> {
  const name = (
    (await pickButtons(player)
      .nth(position - 1)
      .textContent()) ?? ""
  ).trim();
  await player.page.keyboard.press(String(position));
  await expect(pickButtons(player), `${player.name}: Wahl per Tastatur angenommen`).toHaveCount(0);
  return name;
}

/** Welche Antwort eine Person bei ihrer `index`-ten Frage gibt (0-basiert). */
export type AnswerPlan = (player: Player, index: number) => "correct" | "wrong";

const ALWAYS_CORRECT: AnswerPlan = () => "correct";

export interface PlayQuicklyOptions {
  /** Antwort je Person und Frage (Standard: immer richtig) */
  plan?: AnswerPlan;
  /** Zähler der beantworteten Fragen je Person – über mehrere Aufrufe weitergeben, damit `plan` mitzählt */
  answered?: Map<Player, number>;
  timeoutMs?: number;
}

/**
 * Alle Personen: wählen (falls dran) und antworten sofort nach `plan`, bis das Overlay `until` erscheint.
 * Antworten alle, löst der Server früh auf – das Spiel läuft so schnell wie möglich.
 */
export async function playQuicklyUntil(
  players: readonly Player[],
  until: OverlayName,
  options: PlayQuicklyOptions = {},
): Promise<void> {
  const plan = options.plan ?? ALWAYS_CORRECT;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const first = players[0];
  if (!first) throw new Error("keine Personen");
  const target = stageOverlay(first.page, until);
  const answered = options.answered ?? new Map<Player, number>();
  for (;;) {
    if ((await target.count()) > 0) return;
    if (Date.now() > deadline) throw new Error(`Overlay ${until} nicht erreicht`);
    await Promise.all(
      players.map(async (player) => {
        if ((await pickButtons(player).count()) > 0) {
          await pickButtons(player)
            .first()
            .click({ timeout: 2_000 })
            .catch((error: unknown) => {
              // Wahlzeit vorbei oder schon gewählt – das Spiel läuft weiter.
              if (!(error instanceof Error)) throw error;
            });
        }
        const index = answered.get(player) ?? 0;
        const name = plan(player, index) === "correct" ? CORRECT_ANSWER_NAME : OTHER_ANSWER_NAME;
        const choice = stageOverlay(player.page, "question").getByRole("button", { name, disabled: false });
        if ((await choice.count()) > 0) {
          const clicked = await choice
            .first()
            .click({ timeout: 2_000 })
            .then(() => true)
            .catch((error: unknown) => {
              // Frage inzwischen aufgelöst – zählt nur als verpasst.
              if (!(error instanceof Error)) throw error;
              return false;
            });
          if (clicked) answered.set(player, index + 1);
        }
      }),
    );
    await first.page.waitForTimeout(150);
  }
}
