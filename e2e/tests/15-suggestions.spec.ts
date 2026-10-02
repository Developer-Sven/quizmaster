/**
 * Vorschläge für die Einstellungen (ADR-053): Ben stellt im Einstellungen-Sheet einen Vorschlag zusammen, Mia sieht
 * ihn in der Lobby, prüft ihn, passt an und übernimmt; Ablehnen, Zurückziehen und „Vorschläge aus“.
 */

import { expect, test } from "./support/fixtures.ts";
import type { Player } from "./support/player.ts";

/** Ben öffnet die Einstellungen, ändert per Stepper-Tipp und sendet den Vorschlag. */
async function suggest(guest: Player, button: string): Promise<void> {
  await guest.page.getByRole("button", { name: "Einstellungen ansehen" }).click();
  const draft = guest.page.getByRole("dialog", { name: "Einstellungen" });
  await draft.getByRole("button", { name: button }).click();
  await draft.getByTestId("settings-suggest").click();
  await expect(draft).toBeHidden();
  await expect(guest.page.getByTestId("lobby-own-suggestion")).toContainText("Dein Vorschlag liegt bei Mia.");
}

test("Ben schlägt vor, Mia passt an und übernimmt, beide sehen den neuen Stand (ADR-053)", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);

  await guest.page.getByRole("button", { name: "Einstellungen ansehen" }).click();
  const draft = guest.page.getByRole("dialog", { name: "Einstellungen" });
  await expect(draft.getByTestId("settings-intro")).toHaveText("Deine Änderungen gehen als Vorschlag an Mia.");
  const send = draft.getByTestId("settings-suggest");
  await expect(send).toHaveAttribute("aria-disabled", "true");
  await draft.getByRole("button", { name: "Runden erhöhen" }).click();
  // Geändert: Wert orange, darunter der aktuelle Stand – sonst ändert sich noch nichts.
  await expect(draft.getByRole("group", { name: "Runden" }).getByTestId("stepper-note")).toHaveText("Aktuell: 3");
  await expect(guest.page.getByTestId("lobby-summary")).toContainText("3 Runden");
  await send.click();
  await expect(draft).toBeHidden();
  await expect(guest.toast("Vorschlag gesendet.")).toBeAttached();
  await expect(guest.page.getByTestId("lobby-own-suggestion")).toContainText("Dein Vorschlag liegt bei Mia.");

  await expect(host.toast("Ben hat einen Vorschlag gemacht.")).toBeAttached();
  const row = host.page.getByTestId("lobby-suggestion");
  await expect(row).toContainText("Von Ben");
  await expect(row).toContainText("Runden: 4");
  await row.click();
  const review = host.page.getByRole("dialog", { name: "Vorschlag von Ben" });
  await expect(review.getByRole("group", { name: "Runden" }).locator("output")).toHaveText("4");
  await expect(review.getByRole("group", { name: "Runden" }).getByTestId("stepper-note")).toHaveText("Aktuell: 3");
  // Mia passt vor dem Übernehmen noch an.
  await review.getByRole("button", { name: "Fragen pro Kategorie erhöhen" }).click();
  await review.getByTestId("suggestion-accept").click();
  await expect(review).toBeHidden();

  for (const player of [host, guest]) {
    await expect(player.page.getByTestId("lobby-summary")).toContainText("4 Runden · 4 Fragen je Kat.");
  }
  await expect(guest.toast("Mia hat deinen Vorschlag übernommen.")).toBeAttached();
  await expect(guest.page.getByTestId("lobby-own-suggestion")).toHaveCount(0);
  await expect(host.page.getByTestId("lobby-suggestions")).toHaveCount(0);
});

test("Ablehnen, Zurückziehen und Vorschläge ausschalten (ADR-053)", async ({ players }) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);

  // Ablehnen: der Stand bleibt, Ben erfährt es.
  await suggest(guest, "Zeit pro Frage erhöhen");
  await host.page.getByTestId("lobby-suggestion").click();
  const review = host.page.getByRole("dialog", { name: "Vorschlag von Ben" });
  await review.getByTestId("suggestion-decline").click();
  await expect(review).toBeHidden();
  await expect(guest.toast("Mia hat deinen Vorschlag abgelehnt.")).toBeAttached();
  await expect(guest.page.getByTestId("lobby-summary-extras")).toHaveCount(0);

  // Zurückziehen: Mias Liste leert sich.
  await suggest(guest, "Zeit pro Frage erhöhen");
  await expect(host.page.getByTestId("lobby-suggestion")).toHaveCount(1);
  await guest.page.getByTestId("lobby-withdraw-suggestion").click();
  await expect(guest.page.getByTestId("lobby-own-suggestion")).toHaveCount(0);
  await expect(host.page.getByTestId("lobby-suggestions")).toHaveCount(0);

  // Vorschläge aus: der offene Vorschlag verfällt, Bens Sheet ist wieder nur lesbar.
  await suggest(guest, "Runden verringern");
  await host.setSuggestions(false);
  await expect(guest.toast("Vorschläge sind jetzt aus.")).toBeAttached();
  await expect(guest.page.getByTestId("lobby-own-suggestion")).toHaveCount(0);
  await guest.page.getByRole("button", { name: "Einstellungen ansehen" }).click();
  const view = guest.page.getByRole("dialog", { name: "Einstellungen" });
  await expect(view.getByText("Nur Mia kann die Einstellungen ändern.")).toBeVisible();
  await expect(view.getByRole("button", { name: "Runden erhöhen" })).toHaveAttribute("aria-disabled", "true");
});
