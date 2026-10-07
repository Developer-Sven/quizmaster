/**
 * Lobby-Werkzeuge (ADR-041–043, ADR-045, ADR-052): Startseite mit drei Wegen, Namen in der Lobby ändern, schnelles
 * Einstellen ohne „Zu viele Versuche“, „Weiter“ per Host nach Frage, Kategorie und Zwischenstand und die Regeln
 * als Sheet, ohne die Lobby zu verlassen – auch über den Wechsel vom Spielende in die Lobby.
 */

import { expect, test } from "./support/fixtures.ts";
import { stageOverlay } from "./support/game.ts";
import { playQuicklyUntil, waitForOverlay } from "./support/phases.ts";

test("Startseite: Name, dann erstellen · Code · QR-Code mit „oder“ dazwischen; Code-Hinweis nur für Screenreader", async ({
  players,
}) => {
  const mia = await players.create("Mia");
  await mia.openStart();
  const page = mia.page;
  await expect(page.getByText("oder", { exact: true })).toHaveCount(2);
  const create = page.getByTestId("start-create");
  const scan = page.getByTestId("start-scan");
  const name = page.getByTestId("start-name");
  // Reihenfolge: Name oben, darunter erstellen, Code, QR-Code.
  const [nameBox, createBox, scanBox] = await Promise.all([
    name.boundingBox(),
    create.boundingBox(),
    scan.boundingBox(),
  ]);
  expect(nameBox && createBox && scanBox).toBeTruthy();
  if (nameBox && createBox && scanBox) {
    expect(nameBox.y).toBeLessThan(createBox.y);
    expect(createBox.y).toBeLessThan(scanBox.y);
    // Mehr Abstand zwischen Name und Gruppe als innerhalb der Gruppe (Linie mit 32 px darüber und darunter).
    expect(createBox.y - (nameBox.y + nameBox.height)).toBeGreaterThan(60);
  }
  const hint = page.getByText("Nach dem 6. Zeichen trittst du automatisch bei.");
  await expect(hint).toHaveCount(1);
  await expect(hint).toHaveClass(/sr-only/);
});

test("Namen in der Lobby ändern: alle sehen ihn, unpassende Namen werden abgelehnt (ADR-041)", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Gast-123456");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await expect(host.lobbyPlayer("Gast-123456")).toBeVisible();

  // Nur die eigene Zeile hat den Stift.
  await expect(guest.page.getByTestId("lobby-rename")).toHaveCount(1);
  await guest.page.getByRole("button", { name: "Name ändern" }).click();
  const sheet = guest.page.getByRole("dialog", { name: "Name ändern" });
  const field = sheet.getByLabel("Dein Name");
  await expect(field).toHaveValue("Gast-123456");
  await field.fill("Arschloch");
  await sheet.getByRole("button", { name: "Speichern" }).click();
  await expect(sheet.getByText("Name nicht erlaubt.")).toBeVisible();
  await field.fill("Ben");
  await sheet.getByRole("button", { name: "Speichern" }).click();
  await expect(sheet).toBeHidden();
  for (const player of [host, guest]) await expect(player.lobbyPlayer("Ben")).toBeVisible();
  expect(await guest.page.evaluate(() => localStorage.getItem("qm.name"))).toBe("Ben");
});

test("Einstellungen schnell durchtippen: kein „Zu viele Versuche“, alle sehen den letzten Stand (ADR-042)", async ({
  players,
}) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await host.page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  const sheet = host.page.getByRole("dialog", { name: "Einstellungen" });
  const more = sheet.getByRole("button", { name: "Runden erhöhen" });
  const moreQuestions = sheet.getByRole("button", { name: "Fragen pro Kategorie erhöhen" });
  for (let tap = 0; tap < 7; tap++) await more.click();
  for (let tap = 0; tap < 7; tap++) await moreQuestions.click();
  await expect(sheet.getByRole("group", { name: "Runden" }).locator("output")).toHaveText("10");
  await sheet.getByRole("button", { name: "Fertig" }).click();
  for (const player of [host, guest]) {
    await expect(player.page.getByTestId("lobby-summary")).toContainText("10 Runden · 10 Fragen je Kat.");
  }
  await expect(host.toast("Zu viele Versuche. Warte kurz.")).toHaveCount(0);
});

test("„Weiter“ per Host: Auflösung und Zwischenstand warten, nur der Host schaltet weiter (ADR-045)", async ({
  players,
}) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await host.changeSettings({
    Runden: 1,
    "Fragen pro Kategorie": 1,
    "Nach jeder Frage": 0,
    "Nach dem Zwischenstand": 0,
  });
  await host.startGame();
  const all = [host, guest];
  await playQuicklyUntil(all, "answer-reveal");
  // Die Auflösung bleibt stehen: Host sieht „Weiter“, der Gast „Warte auf Mia …“.
  await expect(host.page.getByTestId("game-continue")).toBeVisible();
  await expect(guest.page.getByTestId("game-continue-waiting")).toHaveText("Warte auf Mia …");
  await expect(guest.page.getByTestId("game-continue")).toHaveCount(0);
  await host.page.waitForTimeout(1_500);
  await expect(stageOverlay(host.page, "answer-reveal")).toBeVisible();
  await host.page.getByTestId("game-continue").click();
  // Zug 2 (nach dem automatischen Zug-Ergebnis): die Auflösung wartet wieder auf den Host.
  await expect(host.hudProgress).toHaveText(/Zug 2\/2/);
  await playQuicklyUntil(all, "answer-reveal");
  await expect(guest.page.getByTestId("game-continue-waiting")).toBeVisible();
  await host.page.getByTestId("game-continue").click();
  // Danach der Zwischenstand – er wartet ebenfalls auf den Host.
  for (const player of all) await waitForOverlay(player, "round-board");
  await expect(guest.page.getByTestId("game-continue-waiting")).toHaveText("Warte auf Mia …");
  await host.page.getByTestId("game-continue").click();
  for (const player of all) await waitForOverlay(player, "game-over");
});

test("Regeln in der Lobby: Sheet statt Seitenwechsel, die Lobby bleibt verbunden (ADR-052)", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  const lobbyUrl = guest.page.url();
  await guest.page.getByTestId("rules-link").click();
  const sheet = guest.page.getByRole("dialog", { name: "Regeln" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("rules-list").getByRole("listitem").first()).toBeVisible();
  expect(guest.page.url()).toBe(lobbyUrl);
  expect(guest.page.context().pages()).toHaveLength(1);
  await sheet.getByTestId("rules-sheet-close").click();
  await expect(sheet).toBeHidden();
  // Noch in der Lobby und verbunden: der Host sieht Ben weiter, Ben die Lobby.
  await expect(guest.page.getByTestId("lobby-screen")).toBeVisible();
  await expect(host.page.getByTestId("lobby-players").getByText("Ben", { exact: true })).toBeVisible();
});

test("Regeln am Spielende: Das Sheet übersteht den Wechsel in die Lobby, danach Fokus auf „Regeln“ (ADR-052)", async ({
  players,
}) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await host.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
  await host.startGame();
  await playQuicklyUntil([host, guest], "game-over");
  await waitForOverlay(guest, "game-over");
  await stageOverlay(guest.page, "game-over").getByTestId("rules-link").click();
  const sheet = guest.page.getByRole("dialog", { name: "Regeln" });
  await expect(sheet).toBeVisible();
  // Nach dem Ergebnis zurück in die Lobby (ADR-038) – das Sheet bleibt offen, sein Auslöser ist mit dem Spiel weg.
  await expect(guest.page.getByTestId("lobby-last-game")).toBeVisible({ timeout: 15_000 });
  await expect(sheet).toBeVisible();
  await guest.page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // Fokus nicht auf <body> (WCAG 2.4.3): „Regeln“ der Lobby übernimmt ihn, Tab geht von dort weiter.
  await expect(guest.page.getByTestId("lobby-screen").getByTestId("rules-link")).toBeFocused();
});

test("Startseite am Handy: „Als App installieren“ ist immer da, auf dem iPhone mit Anleitung (ADR-054)", async ({
  players,
}, testInfo) => {
  const mia = await players.create("Mia");
  await mia.openStart();
  const row = mia.page.getByTestId("install-row");
  await expect(row).toBeVisible();
  const method = await row.getAttribute("data-method");
  // iPhone (jeder Browser): Installieren nur über „Teilen“ → Anleitung; Android: Dialog oder Menü-Anleitung.
  if (testInfo.project.name.startsWith("iphone")) expect(method).toBe("ios");
  else expect(["prompt", "android"]).toContain(method);
  if (method === "prompt") return;
  await mia.page.getByTestId("install-app").click();
  const sheet = mia.page.getByRole("dialog", { name: "App installieren" });
  const steps = sheet.getByTestId("install-steps").getByRole("listitem");
  await expect(steps).toHaveCount(3);
  await expect(steps.first()).toContainText(method === "ios" ? "„Teilen“" : "Menü");
  await sheet.getByTestId("install-sheet-close").click();
  await expect(sheet).toBeHidden();
});
