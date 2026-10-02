/**
 * Spielmodi des Hosts (ADR-046–049): Anzeige-Modus (Host spielt nicht mit, großer Bildschirm), Host übertragen,
 * Kategorien begrenzen (feste Kategorie ohne Wahl) und „Zeit pro Frage: Host“ mit „Auflösen (x/y Antworten)“.
 */

import { expect, test } from "./support/fixtures.ts";
import { stageOverlay } from "./support/game.ts";
import { openAnswers, pickFirstCategory, pickRoles, playQuicklyUntil, waitForOverlay } from "./support/phases.ts";
import { stageEvents } from "./support/stage-recorder.ts";

test("Anzeige-Modus: Host zeigt nur an, zwei spielen am Handy (ADR-046)", async ({ players }) => {
  const host = await players.create("Mia");
  const ben = await players.create("Ben");
  const lea = await players.create("Lea");
  const code = await host.createLobby();
  await ben.joinByCode(code);
  await lea.joinByCode(code);
  await host.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
  await host.page.getByRole("button", { name: "Einstellungen" }).click();
  const sheet = host.page.getByRole("dialog", { name: "Einstellungen" });
  await sheet.getByRole("button", { name: "Du zeigst nur an (großer Bildschirm)" }).click();
  await expect(sheet.getByRole("button", { name: "Du zeigst nur an (großer Bildschirm)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await sheet.getByRole("button", { name: "Fertig" }).click();
  await expect(host.lobbyPlayer("Mia")).toContainText("zeigt an");
  await expect(ben.page.getByTestId("lobby-summary-extras")).toContainText("Mia zeigt nur an");
  await expect(host.page.locator("html")).toHaveAttribute("data-presenter", "");

  await host.startGame();
  // Auf dem Anzeige-Gerät: nur die beiden Mitspielenden im Streifen, keine bedienbaren Antworten.
  await expect(host.stripPlayers).toHaveCount(2);
  await playQuicklyUntil([ben, lea], "question");
  await waitForOverlay(host, "question");
  await expect(stageOverlay(host.page, "question").getByRole("button", { disabled: false })).toHaveCount(0);
  await playQuicklyUntil([ben, lea], "game-over");
  await waitForOverlay(host, "game-over");
  await expect(host.page.getByTestId("game-over-headline")).not.toHaveText(/^(Gewonnen|Verloren|Platz \d)$/);
});

test("Host übertragen: Ben wird Host, Mia wartet (ADR-047)", async ({ players }) => {
  const host = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await host.createLobby();
  await ben.joinByCode(code);
  await expect(ben.page.getByTestId("lobby-make-host")).toHaveCount(0);
  await host.page.getByRole("button", { name: "Ben zum Host machen" }).click();
  const dialog = host.page.getByRole("alertdialog", { name: "Ben zum Host machen?" });
  await dialog.getByRole("button", { name: "Übertragen" }).click();
  await expect(ben.lobbyPlayer("Ben")).toHaveAttribute("data-host", "true");
  await expect(ben.page.getByRole("button", { name: "Einstellungen" })).toBeVisible();
  await expect(host.page.getByRole("button", { name: "Einstellungen" })).toHaveCount(0);
  await expect(host.waitingNote).toHaveText("Warte auf Ben …");
});

test("Feste Kategorie: keine Wahl, alle Züge in dieser Kategorie (ADR-048)", async ({ players }) => {
  const host = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await host.createLobby();
  await ben.joinByCode(code);
  await host.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
  await host.page.getByRole("button", { name: "Einstellungen" }).click();
  await host.page.getByTestId("settings-categories-row").click();
  const list = host.page.getByTestId("settings-categories");
  const first = list.locator('[data-testid^="settings-category-"]').first();
  const name = ((await first.textContent()) ?? "").trim();
  expect(name.length).toBeGreaterThan(0);
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await host.page.getByTestId("settings-categories-done").click();
  const sheet = host.page.getByRole("dialog", { name: "Einstellungen" });
  await expect(sheet.getByTestId("settings-categories-row")).toContainText(name);
  await sheet.getByRole("button", { name: "Fertig" }).click();
  await expect(ben.page.getByTestId("lobby-summary-extras")).toContainText(`Nur ${name}`);

  await host.startGame();
  await playQuicklyUntil([host, ben], "game-over");
  for (const player of [host, ben]) {
    const overlays = (await stageEvents(player.page)).map((event) => event.testId);
    expect(overlays, `${player.name}: keine Kategoriewahl`).not.toContain("overlay-category-pick");
  }
});

test("Zeit pro Frage „Host“: kein Countdown, der Host löst mit Stand der Antworten auf (ADR-049)", async ({
  players,
}) => {
  const host = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await host.createLobby();
  await ben.joinByCode(code);
  await host.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1, "Zeit pro Frage": 0 });
  await expect(ben.page.getByTestId("lobby-summary-extras")).toContainText("Auflösen per Host");
  await host.startGame();
  // Wahl ohne zu antworten (ohne Countdown löste eine schnelle Antwort aller die Frage sofort auf).
  const { picker } = await pickRoles([host, ben]);
  await pickFirstCategory(picker);
  await waitForOverlay(ben, "question");
  await expect(stageOverlay(ben.page, "question").getByRole("timer")).toHaveCount(0);
  await expect(ben.page.getByTestId("game-continue")).toHaveCount(0);
  // Irgendeine Antwort (Zahlenfragen haben kein „Richtig …“ im Text).
  await openAnswers(ben).first().click();
  await expect(openAnswers(ben)).toHaveCount(0);
  const reveal = host.page.getByTestId("game-continue");
  await expect(reveal).toHaveText("Auflösen (1/2 Antworten)");
  // Ohne „Auflösen“ bleibt die Frage stehen (schneller Testmodus: sonst nach 2 s vorbei).
  await host.page.waitForTimeout(3_000);
  await expect(stageOverlay(host.page, "question")).toBeVisible();
  await reveal.click();
  for (const player of [host, ben]) await waitForOverlay(player, "answer-reveal");
});
