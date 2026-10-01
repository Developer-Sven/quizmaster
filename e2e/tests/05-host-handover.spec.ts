/**
 * Szenario 5 (docs/11): Host verlässt die Lobby → Host-Übergabe an die nächste Person (Beitrittsreihenfolge),
 * Hinweis per Toast (docs/09 §7.10). Zusätzlich: Host trennt sich (Tab zu) → Übergabe nach der Frist
 * (`GAME_TIMING=fast`: 2 s, docs/05 §Timings).
 */
import { expect, test } from "./support/fixtures.ts";

test("Host verlässt die Lobby → Host-Übergabe", async ({ players }) => {
  const mia = await players.create("Mia");
  const ben = await players.create("Ben");
  const lea = await players.create("Lea");
  const code = await mia.createLobby();
  await ben.joinByCode(code);
  await lea.joinByCode(code);
  await expect(lea.waitingNote).toHaveText("Warte auf Mia …");

  await mia.leaveLobby();
  // Hinweis per Toast (3 s) bei allen Verbliebenen – gleichzeitig prüfen, bevor er wieder verschwindet.
  await Promise.all([ben, lea].map((player) => expect(player.toast("Ben ist jetzt Host.")).toBeAttached()));
  await expect(mia.page.getByRole("button", { name: "Lobby erstellen" })).toBeVisible();

  // Ben ist als Nächster beigetreten und übernimmt: Start-Button und Einstellungen, Krone in der Liste.
  for (const player of [ben, lea]) {
    await expect(player.lobbyPlayers).toHaveCount(2);
    await expect(player.lobbyPlayer("Mia")).toHaveCount(0);
    await expect(player.lobbyPlayer("Ben")).toHaveAttribute("data-host", "true");
  }
  await expect(ben.startButton).toBeEnabled();
  await expect(ben.page.getByRole("button", { name: "Einstellungen" })).toBeVisible();
  await expect(lea.waitingNote).toHaveText("Warte auf Ben …");

  // Der neue Host kann das Spiel starten.
  await ben.startGame();
  await expect(lea.gameScreen).toBeVisible();
});

test("Host trennt sich → Übergabe nach der Frist", async ({ players }) => {
  const mia = await players.create("Mia");
  const ben = await players.create("Ben");
  const code = await mia.createLobby();
  await ben.joinByCode(code);

  await players.close(mia);

  await expect(ben.lobbyPlayer("Ben")).toHaveAttribute("data-host", "true", { timeout: 15_000 });
  await expect(ben.toast("Ben ist jetzt Host.")).toBeAttached();
  await expect(ben.page.getByRole("button", { name: "Einstellungen" })).toBeVisible();
});
