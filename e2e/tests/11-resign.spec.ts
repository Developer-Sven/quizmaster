/**
 * Szenario 11 (docs/11): Aufgeben mitten im Spiel → „Aufgegeben“ im Ergebnis, das Spiel läuft für die anderen
 * weiter; bei 2 Personen endet das Spiel sofort (docs/01, Engine: < 2 Aktive → game_over).
 */

import { expect, test } from "./support/fixtures.ts";
import { playUntilGameOver, waitForOpenQuestion } from "./support/game.ts";

test("3 Personen: Aufgeben → „Aufgegeben“ im Ergebnis, Spiel läuft weiter", async ({ players }) => {
  const mia = await players.create("Mia");
  const ben = await players.create("Ben");
  const lea = await players.create("Lea");
  const code = await mia.createLobby();
  await ben.joinByCode(code);
  await lea.joinByCode(code);
  await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
  await mia.startGame();

  // Lea gibt während der ersten Frage auf.
  await waitForOpenQuestion(lea);
  const playing = Promise.all([playUntilGameOver(mia), playUntilGameOver(ben)]);
  await lea.resign();
  await expect(lea.page.getByRole("button", { name: "Lobby erstellen" })).toBeVisible();

  await Promise.all([mia, ben].map((player) => expect(player.toast("Lea hat aufgegeben.")).toBeAttached()));
  const [miaResult, benResult] = await playing;
  // Das Spiel lief für die beiden anderen bis zum Ende weiter (Leas restliche Züge entfallen).
  expect(miaResult.finished && benResult.finished).toBe(true);
  await expect(lea.page.getByTestId("game-screen")).toHaveCount(0);

  for (const player of [mia, ben]) {
    const ranking = await player.rankingLines();
    expect(ranking).toHaveLength(3);
    // Aufgegeben steht hinter allen Aktiven.
    expect(ranking[2]).toContain("Lea");
    expect(ranking[2]).toContain("Aufgegeben");
    expect(ranking.slice(0, 2).some((line) => line.includes("Aufgegeben"))).toBe(false);
  }
});

test("2 Personen: Aufgeben beendet das Spiel sofort", async ({ players }) => {
  const mia = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await mia.createLobby();
  await ben.joinByCode(code);
  await mia.startGame();
  await waitForOpenQuestion(ben);

  await ben.resign();

  // Sofortiges Spielende für Mia: gewonnen, Ben als aufgegeben.
  await expect(mia.page.getByTestId("overlay-game-over")).toBeVisible({ timeout: 3_000 });
  await expect(mia.page.getByTestId("game-over-headline")).toHaveText("Gewonnen");
  await expect(mia.page.getByTestId("game-over-score")).toBeVisible();
  await expect(ben.page.getByRole("button", { name: "Lobby erstellen" })).toBeVisible();
});
