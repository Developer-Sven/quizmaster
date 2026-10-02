/**
 * Schwierigkeit (ADR-055): von–bis, pro Frage oder pro Kategorie, aufsteigend oder zufällig – eingestellt in der
 * Unteransicht „Schwierigkeit“ mit Vorschau; dazu 5 s pro Frage. Das Spiel startet mit diesen Einstellungen.
 */

import { expect, test } from "./support/fixtures.ts";
import { waitForOpenQuestion } from "./support/game.ts";

test("Schwierigkeit 2–3 pro Kategorie zufällig und 5 s pro Frage: klar beschrieben, Spiel startet (ADR-055)", async ({
  players,
}) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);
  await host.changeSettings({ "Zeit pro Frage": 5 });

  await host.page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  const sheet = host.page.getByRole("dialog", { name: "Einstellungen" });
  const row = sheet.getByTestId("settings-difficulty-row");
  await expect(row).toContainText("1–5, pro Frage aufsteigend");
  await row.click();
  const view = host.page.getByRole("dialog", { name: "Schwierigkeit" });
  const preview = view.getByTestId("settings-difficulty-preview");
  await expect(preview).toHaveText("So läuft jede Kategorie: Stufe 1 · 3 · 5");
  await view.getByRole("button", { name: "Von Stufe erhöhen" }).click();
  for (let step = 0; step < 3; step++) await view.getByRole("button", { name: "Bis Stufe verringern" }).click();
  // Von = bis = 2: „von“ kann nicht über „bis“ – beide Tasten an der Grenze aus, keine Verteilung zu wählen.
  await expect(view.getByRole("group", { name: "Bis Stufe" }).locator("output")).toHaveText("2");
  await expect(view.getByRole("button", { name: "Bis Stufe verringern" })).toHaveAttribute("aria-disabled", "true");
  await expect(view.getByRole("button", { name: "Von Stufe erhöhen" })).toHaveAttribute("aria-disabled", "true");
  await expect(view.getByTestId("settings-difficulty-basis")).toHaveCount(0);
  await expect(preview).toHaveText("Alle Fragen haben Stufe 2.");
  await view.getByRole("button", { name: "Bis Stufe erhöhen" }).click();
  await expect(view.getByRole("group", { name: "Von Stufe" }).locator("output")).toHaveText("2");
  await expect(view.getByRole("group", { name: "Bis Stufe" }).locator("output")).toHaveText("3");
  await expect(preview).toHaveText("So läuft jede Kategorie: Stufe 2 · 3 · 3");
  await view.getByRole("button", { name: /^Pro Kategorie/ }).click();
  await expect(preview).toHaveText(/^Kategorien nacheinander: Stufe 2 · 2 · 2 · 3 · 3 · 3$/);
  await view.getByRole("button", { name: /^Zufällig/ }).click();
  await expect(view.getByRole("button", { name: /^Zufällig/ })).toHaveAttribute("aria-pressed", "true");
  await expect(preview).toHaveText("Jede Kategorie bekommt zufällig eine Stufe von 2 bis 3.");
  await view.getByTestId("settings-difficulty-done").click();
  await expect(row).toContainText("2–3, pro Kategorie zufällig");
  await sheet.getByRole("button", { name: "Fertig" }).click();
  await expect(sheet).toBeHidden();

  for (const player of [host, guest]) {
    await expect(player.page.getByTestId("lobby-summary-extras")).toHaveText(
      "Schwierigkeit 2–3, pro Kategorie zufällig · 5 s pro Frage",
    );
  }
  await host.startGame();
  await waitForOpenQuestion(guest);
});
