/**
 * Szenario 8 (docs/11): Host spielt allein gegen 3 Dev-Bots bis zum Ende (`DEV_BOTS_ENABLED=true`,
 * docs/05 §Dev-Bots: Bots wählen und antworten selbst).
 */

import { expect, test } from "./support/fixtures.ts";
import { playUntilGameOver } from "./support/game.ts";

test("Host allein gegen 3 Dev-Bots bis zum Spielende", async ({ players }) => {
  const host = await players.create("Mia");
  await host.createLobby();

  for (let bot = 1; bot <= 3; bot++) {
    await host.addBot();
    await expect(host.lobbyPlayer(`Bot ${bot}`)).toBeVisible();
  }
  await expect(host.page.getByRole("heading", { name: "Spieler 4/8" })).toBeVisible();
  await host.changeSettings({ Runden: 2, "Fragen pro Kategorie": 2 });
  await expect(host.page.getByTestId("lobby-summary")).toContainText("2 Runden · 2 Fragen je Kat.");

  await host.startGame();
  await expect(host.stripPlayers).toHaveCount(4);
  const result = await playUntilGameOver(host, { answer: "correct" });

  expect(result.finished).toBe(true);
  // 2 Runden × 1 Zug je Runde für den Host; die Bots wählen ihre Züge selbst.
  expect(result.picks).toHaveLength(2);
  expect(result.picks.every((pick) => pick.accepted)).toBe(true);
  expect(result.answers + result.missedAnswers).toBe(16);

  const ranking = await host.rankingLines();
  expect(ranking).toHaveLength(4);
  for (const name of ["Mia", "Bot 1", "Bot 2", "Bot 3"]) {
    expect(
      ranking.some((line) => line.includes(name)),
      `${name} in der Rangliste`,
    ).toBe(true);
  }
  await expect(host.page.getByRole("list", { name: "Podest" })).toBeVisible();
  // Bots zählen als verbunden: Revanche ist möglich.
  await expect(host.page.getByRole("button", { name: "Revanche" })).toBeEnabled();
});
