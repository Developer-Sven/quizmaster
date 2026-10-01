/**
 * Szenario 6 (docs/11): Host entfernt eine Person → sie sieht den Hinweis und kann nicht erneut beitreten
 * (Sperre der guestId für diese Lobby, docs/05 `kicked`, Fehler `KICKED`).
 */
import { expect, test } from "./support/fixtures.ts";

test("Kick: Hinweis für die entfernte Person, erneuter Beitritt verboten", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await expect(host.lobbyPlayers).toHaveCount(2);

  await host.kick("Ben");

  // Gekickte Person: Hinweis statt Lobby, Weg zur Startseite.
  const notice = guest.page.getByTestId("lobby-exit");
  await expect(notice.getByRole("heading", { name: "Du wurdest aus der Lobby entfernt." })).toBeVisible();
  await expect(guest.lobbyScreen).toHaveCount(0);
  // Host: Person weg.
  await expect(host.lobbyPlayers).toHaveCount(1);
  await expect(host.lobbyPlayer("Ben")).toHaveCount(0);

  // Erneuter Beitritt per Code (Startseite) → Fehler unter dem Code, bleibt auf der Startseite.
  await notice.getByRole("link", { name: "Zur Startseite" }).click();
  await guest.page.waitForURL((url) => url.pathname === "/");
  await guest.typeCodeOnStart(code);
  await expect(guest.page.getByRole("alert").filter({ hasText: "Du wurdest aus der Lobby entfernt." })).toBeVisible();
  await expect(guest.page).toHaveURL((url) => url.pathname === "/");

  // Auch per Kurzlink nicht.
  await guest.openJoinLink(`/j/${code}`);
  await guest.page.getByRole("button", { name: "Beitreten" }).click();
  await expect(guest.page.getByTestId("join-error")).toHaveText("Du wurdest aus der Lobby entfernt.");
  await expect(guest.page).toHaveURL((url) => url.pathname === `/j/${code}`);
  await expect(host.lobbyPlayers).toHaveCount(1);
});
