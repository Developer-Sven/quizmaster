/**
 * Szenario 7 (docs/11): Fehlerfälle beim Beitreten – falscher Code, volle Lobby, laufendes Spiel
 * (docs/09 §6: Fehler inline unter dem Code; ungültige Codes in der URL → „Lobby nicht gefunden“).
 */
import { expect, test } from "./support/fixtures.ts";

/** Gültiges Format, aber (praktisch sicher) keine aktive Lobby. */
const UNKNOWN_CODE = "ZZZZ22";

test("falscher Code: Hinweis unter dem Code, ungültige Links zeigen „Lobby nicht gefunden“", async ({ players }) => {
  const guest = await players.create("Ben");

  await guest.typeCodeOnStart(UNKNOWN_CODE);
  await expect(guest.page.getByRole("alert").filter({ hasText: "Lobby nicht gefunden." })).toBeVisible();
  await expect(guest.page).toHaveURL((url) => url.pathname === "/");

  // Kurzlink mit gültigem Format, aber ohne Lobby: Fehler unter dem Code.
  await guest.openJoinLink(`/j/${UNKNOWN_CODE}`);
  await guest.page.getByRole("button", { name: "Beitreten" }).click();
  await expect(guest.page.getByTestId("join-error")).toHaveText("Lobby nicht gefunden.");

  // Ungültiges Format in der URL: 404-Seite mit Weg zur Startseite.
  for (const path of ["/j/abc", "/lobby/OOOO00"]) {
    const response = await guest.page.goto(path);
    expect(response?.status()).toBe(404);
    const view = guest.page.getByTestId("lobby-not-found");
    await expect(view.getByRole("heading", { name: "Lobby nicht gefunden." })).toBeVisible();
    await expect(view.getByRole("link", { name: "Zur Startseite" })).toHaveAttribute("href", "/");
  }

  // Lobby-Seite eines unbekannten Codes ohne Mitgliedschaft → Beitreten-Seite.
  await guest.page.goto(`/lobby/${UNKNOWN_CODE}`);
  await guest.page.waitForURL(`**/j/${UNKNOWN_CODE}`);
  await expect(guest.page.getByTestId("join-screen")).toBeVisible();
});

test("volle Lobby: Beitritt abgelehnt", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const late = await players.create("Lea");
  const code = await host.createLobby();
  await host.changeSettings({ "Personen maximal": 2 });
  await guest.joinByCode(code);
  await expect(host.page.getByRole("heading", { name: "Spieler 2/2" })).toBeVisible();

  await late.typeCodeOnStart(code);
  await expect(late.page.getByRole("alert").filter({ hasText: "Die Lobby ist voll." })).toBeVisible();
  await expect(late.page).toHaveURL((url) => url.pathname === "/");

  await late.openJoinLink(`/j/${code}`);
  await late.page.getByRole("button", { name: "Beitreten" }).click();
  await expect(late.page.getByTestId("join-error")).toHaveText("Die Lobby ist voll.");
  await expect(host.lobbyPlayers).toHaveCount(2);
});

test("laufendes Spiel: Beitritt abgelehnt", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const late = await players.create("Lea");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await host.startGame();
  await expect(guest.gameScreen).toBeVisible();

  await late.typeCodeOnStart(code);
  await expect(late.page.getByRole("alert").filter({ hasText: "Das Spiel läuft bereits." })).toBeVisible();
  await expect(late.page).toHaveURL((url) => url.pathname === "/");

  await late.openJoinLink(`/j/${code}`);
  await late.page.getByRole("button", { name: "Beitreten" }).click();
  await expect(late.page.getByTestId("join-error")).toHaveText("Das Spiel läuft bereits.");
  await expect(host.stripPlayers).toHaveCount(2);
});
