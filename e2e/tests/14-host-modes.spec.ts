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
  await host.page.getByRole("button", { name: "Einstellungen", exact: true }).click();
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
  await expect(ben.page.getByRole("button", { name: "Einstellungen", exact: true })).toBeVisible();
  await expect(host.page.getByRole("button", { name: "Einstellungen", exact: true })).toHaveCount(0);
  await expect(host.page.getByRole("button", { name: "Einstellungen ansehen" })).toBeVisible();
  await expect(host.waitingNote).toHaveText("Warte auf Ben …");
});

test("Feste Kategorie: keine Wahl, alle Züge in dieser Kategorie (ADR-048)", async ({ players }) => {
  const host = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await host.createLobby();
  await ben.joinByCode(code);
  await host.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
  await host.page.getByRole("button", { name: "Einstellungen", exact: true }).click();
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

test("Kategorien der Reihe nach: keine Wahl, eine Runde je Kategorie, 3 s pro Frage (ADR-056)", async ({ players }) => {
  const host = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await host.createLobby();
  await ben.joinByCode(code);
  await host.changeSettings({ "Fragen pro Kategorie": 1, "Zeit pro Frage": 3 });
  await host.page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  const sheet = host.page.getByRole("dialog", { name: "Einstellungen" });
  await sheet.getByTestId("settings-categories-row").click();
  const rows = host.page.getByTestId("settings-categories").locator('[data-testid^="settings-category-"]');
  const names: string[] = [];
  for (const index of [1, 0]) {
    const row = rows.nth(index);
    names.push(((await row.textContent()) ?? "").trim());
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");
  }
  await host.page.getByRole("button", { name: /^Der Reihe nach, ohne Wahl/ }).click();
  await expect(host.page.getByTestId("settings-category-order")).toHaveText(
    `Reihenfolge: 1. ${names[0]} · 2. ${names[1]}`,
  );
  await host.page.getByTestId("settings-categories-done").click();
  // Die Runden folgen der Anzahl der Kategorien und sind gesperrt.
  await expect(sheet.getByRole("group", { name: "Runden" }).locator("output")).toHaveText("2");
  await expect(sheet.getByRole("button", { name: "Runden erhöhen" })).toHaveAttribute("aria-disabled", "true");
  await expect(sheet.getByTestId("settings-categories-row")).toContainText("2 der Reihe nach");
  await sheet.getByRole("button", { name: "Fertig" }).click();
  await expect(ben.page.getByTestId("lobby-summary-extras")).toHaveText(`${names[0]} → ${names[1]} · 3 s pro Frage`);
  // 2 Runden × 1 Zug × 1 Frage – nicht mehr je Person ein Zug.
  await expect(ben.page.getByTestId("lobby-summary")).toContainText("2 Fragen");

  await host.startGame();
  const reveal = await waitForOverlay(ben, "category-reveal");
  await expect(reveal).toContainText(names[0] ?? "");
  await expect(reveal).toContainText("Runde 1 von 2");
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

test("Host beendet das Spiel: Ergebnis für alle, Hinweis, dann zurück in die Lobby (ADR-051)", async ({ players }) => {
  const host = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await host.createLobby();
  await ben.joinByCode(code);
  await host.changeSettings({ Runden: 3, "Fragen pro Kategorie": 3 });
  await host.startGame();
  await pickRoles([host, ben]);
  // Nur der Host beendet; alle anderen können nur aufgeben.
  await expect(ben.page.getByTestId("hud-end")).toHaveCount(0);
  await expect(ben.page.getByTestId("hud-resign")).toBeVisible();
  await host.page.getByRole("button", { name: "Spiel beenden" }).click();
  const dialog = host.page.getByRole("alertdialog", { name: "Spiel für alle beenden?" });
  await expect(dialog).toContainText("aktuellen Stand");
  await dialog.getByRole("button", { name: "Beenden" }).click();
  for (const player of [host, ben]) await waitForOverlay(player, "game-over");
  await expect(ben.toast("Der Host hat das Spiel beendet.")).toBeAttached();
  for (const player of [host, ben]) {
    await expect(player.page.getByTestId("lobby-last-game")).toBeVisible({ timeout: 15_000 });
  }
});
