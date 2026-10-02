/**
 * Szenario 1 (docs/11): Host erstellt eine Lobby, ein Gast tritt per Code bei, beide sehen sich live,
 * der Host startet das Spiel.
 */
import { expect, test } from "./support/fixtures.ts";

test("Host erstellt Lobby, Gast tritt per Code bei, beide sehen sich live, Host startet", async ({
  players,
}, testInfo) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  // Jede Person nutzt den Mobil-Viewport des Projekts (Pixel 7 bzw. iPhone-Größe).
  for (const player of [host, guest]) {
    expect(player.page.viewportSize()).toEqual(testInfo.project.use.viewport);
    expect(await player.page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  }

  const code = await host.createLobby();
  await expect(host.page.getByTestId("lobby-code")).toHaveText(`${code.slice(0, 3)} ${code.slice(3)}`);
  await expect(host.lobbyPlayers).toHaveCount(1);
  await expect(host.lobbyPlayer("Mia")).toHaveAttribute("data-host", "true");
  // Allein kann der Host nicht starten (mindestens 2 verbundene Personen).
  await expect(host.startButton).toHaveAttribute("aria-disabled", "true");

  await guest.joinByCode(code);

  // Beide sehen sich live – ohne Neuladen.
  for (const player of [host, guest]) {
    await expect(player.page.getByRole("heading", { name: "Spieler 2/8" })).toBeVisible();
    await expect(player.lobbyPlayer("Mia")).toHaveAttribute("data-host", "true");
    await expect(player.lobbyPlayer("Ben")).toHaveAttribute("data-host", "false");
  }
  await expect(guest.waitingNote).toHaveText("Warte auf Mia …");
  await expect(guest.startButton).toHaveCount(0);
  // Gäste sehen die Einstellungen, ändern aber nichts (ADR-050).
  await expect(guest.page.getByRole("button", { name: "Einstellungen", exact: true })).toHaveCount(0);
  await guest.page.getByRole("button", { name: "Einstellungen ansehen" }).click();
  const view = guest.page.getByRole("dialog", { name: "Einstellungen" });
  await expect(view.getByText("Nur Mia kann die Einstellungen ändern.")).toBeVisible();
  await expect(view.getByRole("button", { name: "Runden erhöhen" })).toHaveAttribute("aria-disabled", "true");
  await expect(view.getByRole("group", { name: "Zeit pro Frage" }).locator("output")).toHaveText("20 s");
  await expect(view.getByText("Mia spielt mit")).toBeVisible();
  await view.getByTestId("settings-categories-row").click();
  await expect(guest.page.getByTestId("settings-categories").getByRole("button")).toHaveCount(0);
  await guest.page.getByTestId("settings-categories-done").click();
  await guest.page.getByTestId("settings-done").click();
  await expect(view).toBeHidden();

  // Neu laden behält den Platz (docs/13 Phase 1 DoD): gleiche Person, kein zusätzlicher Eintrag.
  const benId = await guest.lobbyPlayer("Ben").getAttribute("data-player-id");
  await guest.page.reload();
  await expect(guest.lobbyScreen).toBeVisible();
  await expect(guest.lobbyPlayers).toHaveCount(2);
  await expect(guest.lobbyPlayer("Ben")).toHaveAttribute("data-player-id", benId ?? "");
  await expect(host.lobbyPlayers).toHaveCount(2);
  await expect(host.lobbyPlayer("Ben")).toHaveAttribute("data-player-id", benId ?? "");

  await host.startGame();
  for (const player of [host, guest]) {
    await expect(player.gameScreen).toBeVisible();
    await expect(player.hudProgress).toHaveText(/^Runde 1\/3 · Zug 1\/2$/);
    await expect(player.stripPlayers).toHaveCount(2);
  }
});
