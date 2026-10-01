/**
 * Szenario 3 (docs/11): Beitritt per Link `/j/<code>` und per Code-Eingabe mit Leerzeichen und
 * Kleinbuchstaben (docs/05 §Lobby-Codes: Eingabe wird normalisiert).
 */
import { expect, test } from "./support/fixtures.ts";
import { sloppyCode } from "./support/player.ts";

test("Beitritt per Link /j/<code> und per Code mit Leerzeichen/Kleinbuchstaben", async ({ players }) => {
  const host = await players.create("Mia");
  const byLink = await players.create("Ben");
  const byCode = await players.create("Lea");
  const code = await host.createLobby();

  // Kurzlink: Code steht fest und wird formatiert angezeigt, nur Name + „Beitreten“.
  await byLink.openJoinLink(`/j/${code}`);
  await expect(byLink.page.getByTestId("join-code")).toHaveText(`${code.slice(0, 3)} ${code.slice(3)}`);
  await byLink.page.getByRole("button", { name: "Beitreten" }).click();
  await byLink.page.waitForURL(`**/lobby/${code}`);
  await expect(byLink.lobbyScreen).toBeVisible();

  // Code-Eingabe „abc 234“ (Kleinbuchstaben, Leerzeichen) tritt beim 6. Zeichen automatisch bei.
  await byCode.typeCodeOnStart(sloppyCode(code));
  await expect(byCode.page.getByLabel("Lobby-Code")).toHaveValue(code);
  await byCode.page.waitForURL(`**/lobby/${code}`);
  await expect(byCode.lobbyScreen).toBeVisible();

  for (const player of [host, byLink, byCode]) {
    await expect(player.page.getByRole("heading", { name: "Spieler 3/8" })).toBeVisible();
    await expect(player.lobbyPlayers).toHaveText([/Mia/, /Ben/, /Lea/]);
  }
});

test("Kurzlink in anderer Schreibweise führt zur kanonischen Adresse", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();

  // „/j/abc-234“ → „/j/ABC234“ (Server-Redirect), danach normal beitreten.
  const sloppyPath = `/j/${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()}`;
  await guest.joinByLink(code, sloppyPath);
  await expect(host.lobbyPlayer("Ben")).toBeVisible();
});
