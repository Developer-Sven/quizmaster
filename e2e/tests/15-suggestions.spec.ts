/**
 * Vorschläge für die Einstellungen (ADR-053): Ben stellt im Einstellungen-Sheet einen Vorschlag zusammen, Mia sieht
 * ihn in der Lobby, prüft ihn, passt an und übernimmt; Ablehnen, Zurückziehen und „Vorschläge aus“.
 */

import { expect, test } from "./support/fixtures.ts";
import type { Player } from "./support/player.ts";
import { axeReport, BLOCKING_IMPACTS } from "./support/screen-checks.ts";

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
  // Referenz-Viewport (docs/09 §4): „Zurückziehen“ bleibt einzeilig, der Hinweis daneben bricht um.
  await guest.page.setViewportSize({ width: 360, height: 740 });
  const withdraw = guest.page.getByTestId("lobby-withdraw-suggestion");
  await expect(withdraw).toBeVisible();
  const box = await withdraw.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(48);
  await withdraw.click();
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

  // Nur lesbar (ADR-050, docs/09 §12): Die Unteransicht „Kategorien“ besteht aus statischen Zeilen. Die Auswahl hören
  // auch Screenreader, und der Inhalt bleibt per Tastatur scrollbar (axe „scrollable-region-focusable“).
  await view.getByTestId("settings-categories-row").click();
  const categories = guest.page.getByRole("dialog", { name: "Kategorien" });
  const body = categories.getByTestId("sheet-body");
  await expect(body.getByText("Alle Kategorien")).toBeVisible();
  await expect(body.getByText("ausgewählt", { exact: true })).toHaveCount(1);
  const scrolls = await body.evaluate((element) => element.scrollHeight > element.clientHeight + 1);
  if (scrolls) {
    await expect(body).toHaveAttribute("tabindex", "0");
    await expect(body).toHaveAccessibleName("Kategorien");
  }
  const axe = await axeReport(guest.page);
  expect(axe.violations.filter((finding) => BLOCKING_IMPACTS.includes(finding.impact))).toEqual([]);
});

test("Vorschlag, der nur die Reihenfolge der Kategorien ändert: beide sehen, was sich ändert (ADR-053/056)", async ({
  players,
}) => {
  const host = await players.create("Mia");
  const guest = await players.create("Ben");
  const code = await host.createLobby();
  await guest.joinByCode(code);

  // Mia: drei Kategorien der Reihe nach.
  await host.page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  const settings = host.page.getByRole("dialog", { name: "Einstellungen" });
  await settings.getByTestId("settings-categories-row").click();
  const rows = host.page.getByTestId("settings-categories").locator('[data-testid^="settings-category-"]');
  const names: string[] = [];
  for (const index of [0, 1, 2]) {
    const row = rows.nth(index);
    names.push(((await row.textContent()) ?? "").trim());
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");
  }
  await host.page.getByRole("button", { name: /^Der Reihe nach, ohne Wahl/ }).click();
  const [first, second, third] = names;
  const before = `1. ${first} · 2. ${second} · 3. ${third}`;
  const after = `1. ${second} · 2. ${third} · 3. ${first}`;
  await expect(host.page.getByTestId("settings-category-order")).toHaveText(`Reihenfolge: ${before}`);
  await host.page.getByTestId("settings-categories-done").click();
  await settings.getByRole("button", { name: "Fertig" }).click();
  await expect(settings).toBeHidden();

  // Ben nimmt die erste Kategorie heraus und wieder hinein – sie rückt ans Ende, sonst bleibt alles gleich.
  await guest.page.getByRole("button", { name: "Einstellungen ansehen" }).click();
  const draft = guest.page.getByRole("dialog", { name: "Einstellungen" });
  await draft.getByTestId("settings-categories-row").click();
  const firstRow = guest.page
    .getByTestId("settings-categories")
    .getByRole("button", { name: first ?? "", exact: true });
  await firstRow.click();
  await expect(firstRow).toHaveAttribute("aria-pressed", "false");
  await firstRow.click();
  await expect(firstRow).toHaveAttribute("aria-pressed", "true");
  await expect(guest.page.getByTestId("settings-category-order")).toHaveText(`Reihenfolge: ${after}`);
  await expect(guest.page.getByTestId("settings-category-order-note")).toHaveText(`Aktuell: ${before}`);
  await guest.page.getByTestId("settings-categories-done").click();
  await expect(draft.getByTestId("settings-categories-row")).toContainText(`Aktuell: ${before}`);
  await draft.getByTestId("settings-suggest").click();
  await expect(draft).toBeHidden();

  // Mia sieht in der Lobby und im Prüfen-Sheet die neue Reihenfolge.
  const row = host.page.getByTestId("lobby-suggestion");
  await expect(row).toContainText(`Kategorien: ${after}`);
  await row.click();
  const review = host.page.getByRole("dialog", { name: "Vorschlag von Ben" });
  await expect(review.getByTestId("settings-categories-row")).toContainText(`Aktuell: ${before}`);
  await review.getByTestId("suggestion-accept").click();
  await expect(review).toBeHidden();
  await expect(guest.toast("Mia hat deinen Vorschlag übernommen.")).toBeAttached();
});
