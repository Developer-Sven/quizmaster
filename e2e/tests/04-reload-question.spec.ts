/**
 * Szenario 4 (docs/11): Reload während einer Frage → gleicher Platz, Punkte bleiben erhalten
 * (docs/05 §Reconnect: `lobby:resume` über die guestId, Reconnect-Frist im Spiel).
 */

import { expect, test } from "./support/fixtures.ts";
import { answerQuestion, gameLocators, waitForOpenQuestion } from "./support/game.ts";
import type { Player } from "./support/player.ts";

/**
 * Beantwortet Fragen (richtig, sofern erkennbar), bis die Person mindestens `target` Punkte hat. Wählen muss
 * niemand – nach 1,5 s wählt der Server zufällig. Zahlenfragen haben keine erkennbar richtige Antwort: dann
 * aussetzen, bis die Frage vorbei ist.
 */
async function scoreAtLeast(player: Player, target: number): Promise<void> {
  const { correctAnswer, openAnswers } = gameLocators(player);
  for (let question = 0; question < 20; question++) {
    if ((await player.ownScore()) >= target) return;
    await waitForOpenQuestion(player);
    if ((await correctAnswer.count()) > 0) await answerQuestion(player, "correct");
    else await expect(openAnswers).toHaveCount(0, { timeout: 5_000 });
  }
  throw new Error(`${player.name} hat nach 20 Fragen keine ${target} Punkte`);
}

test("Reload während einer Frage: gleicher Platz, Punkte erhalten", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await host.startGame();
  await expect(guest.gameScreen).toBeVisible();

  // Erst Punkte sammeln (Punkte zählen erst nach der Auflösung), dann bei der nächsten offenen Frage neu laden.
  await scoreAtLeast(guest, 1);
  await waitForOpenQuestion(guest);
  const selfId = await guest.selfStripEntry.getAttribute("data-player-id");
  const scoreBefore = await guest.ownScore();
  expect(selfId).toBeTruthy();
  expect(scoreBefore).toBeGreaterThanOrEqual(1);

  await guest.page.reload();

  // Gleicher Platz: dieselbe Person (playerId), kein zusätzlicher Platz, Punkte unverändert.
  await expect(guest.gameScreen).toBeVisible();
  await expect(guest.selfStripEntry).toHaveAttribute("data-player-id", selfId ?? "");
  await expect(guest.stripPlayers).toHaveCount(2);
  expect(await guest.ownScore()).toBe(scoreBefore);
  const guestOnHost = host.stripPlayers.and(host.page.locator(`[data-player-id="${selfId}"]`));
  await expect(guestOnHost).toHaveCount(1);
  expect(await host.scoreOf(guestOnHost)).toBe(scoreBefore);
  await expect(guest.page.getByTestId("connection-overlay")).toBeHidden();

  // Der Platz ist voll funktionsfähig: weiter antworten, bis ein weiterer Punkt dazukommt.
  await scoreAtLeast(guest, scoreBefore + 1);
  await expect.poll(() => host.scoreOf(guestOnHost)).toBeGreaterThanOrEqual(scoreBefore + 1);
});
