/**
 * Szenario 2 (docs/11): komplettes Spiel mit 3 Personen (`GAME_TIMING=fast`, 2 Runden, 2 Fragen pro
 * Kategorie): jede Person wählt einmal pro Runde, Auflösung, Zug-Ergebnis, Rundentafel, Endstand,
 * „Fragen ansehen“ mit Bewertung (und Melden), Revanche.
 */

import { expect, test } from "./support/fixtures.ts";
import { type PlayResult, playUntilGameOver, roundOf } from "./support/game.ts";
import type { Player } from "./support/player.ts";
import { countByOverlay, stageEvents } from "./support/stage-recorder.ts";

const ROUNDS = 2;
const QUESTIONS_PER_CATEGORY = 2;
const PLAYERS = 3;
const TURNS = ROUNDS * PLAYERS;
const QUESTIONS = TURNS * QUESTIONS_PER_CATEGORY;

test("komplettes Spiel mit 3 Personen bis zur Revanche", async ({ players }) => {
  const mia = await players.create("Mia");
  const ben = await players.create("Ben");
  const lea = await players.create("Lea");
  const all: Player[] = [mia, ben, lea];

  const code = await mia.createLobby();
  await ben.joinByCode(code);
  await lea.joinByLink(code);
  await mia.changeSettings({ Runden: ROUNDS, "Fragen pro Kategorie": QUESTIONS_PER_CATEGORY });
  for (const player of all) {
    // Einstellungen wirken sofort für alle (docs/09 §6).
    await expect(player.page.getByTestId("lobby-summary")).toContainText("2 Runden · 2 Fragen je Kat.");
    await expect(player.page.getByRole("heading", { name: "Spieler 3/8" })).toBeVisible();
  }

  await mia.startGame();
  const results: PlayResult[] = await Promise.all(
    all.map((player) => playUntilGameOver(player, { answer: "correct" })),
  );

  // --- Jede Person wählt genau einmal pro Runde, jeder Zug hat genau eine wählende Person ------------------
  const turns = new Set<string>();
  for (const [index, result] of results.entries()) {
    const name = all[index]?.name;
    expect(result.finished, `${name} erreicht das Spielende`).toBe(true);
    expect(result.picks.map((pick) => roundOf(pick.progress)).sort(), `${name} wählt je Runde einmal`).toEqual([1, 2]);
    for (const pick of result.picks) {
      expect(pick.accepted, `${name}: Wahl „${pick.category}“ (${pick.progress}) angenommen`).toBe(true);
      turns.add(pick.progress);
    }
  }
  expect(turns.size, "jeder Zug hatte genau eine wählende Person").toBe(TURNS);

  // --- Auflösung, Zug-Ergebnis und Rundentafel liefen bei allen über die Bühne -----------------------------
  for (const player of all) {
    const events = await stageEvents(player.page);
    const counts = countByOverlay(events);
    expect(counts["overlay-intro"], `${player.name}: Intro`).toBe(1);
    expect(counts["overlay-category-pick"], `${player.name}: Kategoriewahl je Zug`).toBe(TURNS);
    const questions = events.filter((event) => event.testId === "overlay-question");
    expect(questions, `${player.name}: Fragen`).toHaveLength(QUESTIONS);
    // Kategoriestreifen während der Frage: Kategoriename und „Frage x/K“ (docs/09 §7).
    for (const question of questions) expect(question.strip).toMatch(/^\S.*[12]\/2$/);
    const reveals = events.filter((event) => event.testId === "overlay-answer-reveal");
    expect(reveals, `${player.name}: Auflösungen`).toHaveLength(QUESTIONS);
    for (const reveal of reveals) expect(reveal.correctMarked, "Auflösung markiert die richtige Antwort").toBe(true);
    const summaries = events.filter((event) => event.testId === "overlay-turn-summary");
    expect(summaries, `${player.name}: Zug-Ergebnisse`).toHaveLength(TURNS);
    for (const summary of summaries) expect(summary.rows, "eine Zeile je Person").toBe(PLAYERS);
    const boards = events.filter((event) => event.testId === "overlay-round-board");
    expect(boards.map((board) => board.heading)).toEqual(["Runde 1 von 2", "Runde 2 von 2"]);
    expect(counts["overlay-game-over"], `${player.name}: Spielende`).toBe(1);
  }

  // --- Endstand: Podest + Rangliste, für alle gleich ------------------------------------------------------
  for (const player of all) {
    // Ausgeblendete Overlays verschwinden – auf der Bühne bleibt nur das Spielende (kein Stapel alter Overlays).
    await expect(player.page.locator('[data-testid^="overlay-"]')).toHaveCount(1);
  }
  const rankings = await Promise.all(all.map((player) => player.rankingLines()));
  expect(rankings[0]).toHaveLength(PLAYERS);
  expect(rankings[1]).toEqual(rankings[0]);
  expect(rankings[2]).toEqual(rankings[0]);
  for (const player of all) {
    await expect(player.page.getByRole("list", { name: "Podest" })).toBeVisible();
    await expect(player.page.getByTestId("game-over-headline")).toHaveText(/^(Gewonnen|Platz [23]|Unentschieden)$/);
  }
  // Spielverlauf (Tafel) aufklappbar.
  const history = ben.page.getByRole("button", { name: "Spielverlauf" });
  await history.click();
  await expect(history).toHaveAttribute("aria-expanded", "true");
  await expect(ben.page.getByRole("table")).toBeVisible();

  // --- „Fragen ansehen“: alle Fragen, Bewerten, Melden -------------------------------------------------------
  await ben.page.getByRole("button", { name: "Fragen ansehen" }).click();
  const review = ben.page.getByRole("dialog", { name: "Fragen ansehen" });
  const items = review.getByTestId("review-item");
  await expect(items).toHaveCount(QUESTIONS);
  const first = items.nth(0);
  const rateUp = first.getByRole("button", { name: "Gute Frage" });
  await expect(rateUp).toHaveAttribute("aria-pressed", "false");
  await rateUp.click();
  await expect(rateUp).toHaveAttribute("aria-pressed", "true");
  const firstId = await first.getAttribute("data-question-id");

  const second = items.nth(1);
  const secondId = await second.getAttribute("data-question-id");
  await second.getByRole("button", { name: "Frage melden" }).click();
  const reportView = ben.page.getByRole("dialog", { name: "Frage melden" });
  await reportView.getByRole("button", { name: "Tippfehler" }).click();
  await expect(ben.toast("Danke, wir prüfen die Frage.")).toBeAttached();
  await expect(
    review.getByTestId("review-item").nth(1).getByRole("button", { name: "Bereits gemeldet" }),
  ).toHaveAttribute("aria-disabled", "true");

  // Schließen und neu öffnen: Bewertung und Meldung kommen vom Server zurück.
  await review.getByRole("button", { name: "Schließen" }).click();
  await expect(review).toBeHidden();
  await ben.page.getByRole("button", { name: "Fragen ansehen" }).click();
  const reopened = ben.page.getByRole("dialog", { name: "Fragen ansehen" });
  await expect(
    reopened.locator(`[data-question-id="${firstId}"]`).getByRole("button", { name: "Gute Frage" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    reopened.locator(`[data-question-id="${secondId}"]`).getByRole("button", { name: "Bereits gemeldet" }),
  ).toBeVisible();
  await reopened.getByRole("button", { name: "Schließen" }).click();

  // --- Revanche: gleiche Einstellungen, Punkte zurück auf 0, alle wieder im Spiel ---------------------------
  await expect(ben.page.getByTestId("game-over-waiting")).toHaveText("Warte auf Mia …");
  await mia.page.getByRole("button", { name: "Revanche" }).click();
  for (const player of all) {
    await expect(player.hudProgress).toHaveText(/^Runde 1\/2 · Zug 1\/3$/);
    await expect(player.stripPlayers).toHaveCount(PLAYERS);
    for (const entry of await player.stripPlayers.all()) expect(await player.scoreOf(entry)).toBe(0);
  }
});
