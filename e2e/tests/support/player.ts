/**
 * Eine Person im E2E-Test: eigener Browser-Kontext (eigene Gast-Session) und Seite, dazu die Abläufe der
 * Oberfläche (docs/09 §6) über rollenbasierte Locator – Texte wie in `apps/web/src/i18n/de.ts`.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Lobby-Pfad mit gültigem Code (Alphabet ohne I, L, O, 0, 1 – docs/05 §Lobby-Codes). */
export const LOBBY_URL = /\/lobby\/([ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6})$/;

/** Code aus der Lobby-URL. */
export function lobbyCodeFromUrl(url: string): string {
  const match = LOBBY_URL.exec(new URL(url).pathname);
  if (!match?.[1]) throw new Error(`Keine Lobby-URL: ${url}`);
  return match[1];
}

/** „ABC234“ → „abc 234“ (Kleinbuchstaben mit Leerzeichen, wie jemand ihn abtippt). */
export function sloppyCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`.toLowerCase();
}

export type SettingLabel = "Runden" | "Fragen pro Kategorie" | "Personen maximal";

export class Player {
  readonly page: Page;
  readonly name: string;

  constructor(page: Page, name: string) {
    this.page = page;
    this.name = name;
  }

  // --- Bereiche -------------------------------------------------------------------------------------

  get lobbyScreen(): Locator {
    return this.page.getByTestId("lobby-screen");
  }

  get gameScreen(): Locator {
    return this.page.getByTestId("game-screen");
  }

  /** Zeilen der Spielerliste in der Lobby. */
  get lobbyPlayers(): Locator {
    return this.page.getByTestId("lobby-player");
  }

  lobbyPlayer(name: string): Locator {
    return this.lobbyPlayers.filter({ hasText: name });
  }

  /** Aktionsleisten-Hinweis „Warte auf Mia …“. */
  get waitingNote(): Locator {
    return this.page.getByTestId("lobby-waiting");
  }

  get startButton(): Locator {
    return this.page.getByRole("button", { name: "Spiel starten" });
  }

  get hudProgress(): Locator {
    return this.page.getByTestId("hud-progress");
  }

  /** Einträge im Spielerstreifen (eigene Person zuerst). */
  get stripPlayers(): Locator {
    return this.page.getByTestId("strip-player");
  }

  /** Hinweis-Toast (Live-Region `status`, docs/09 §7.10). */
  toast(text: string | RegExp): Locator {
    return this.page.getByRole("status").filter({ hasText: text });
  }

  // --- Startseite und Beitreten ---------------------------------------------------------------------

  /** Wartet, bis React ein Element hydriert hat (sonst gehen frühe Eingaben/Klicks verloren). */
  async waitForHydration(locator: Locator): Promise<void> {
    await expect(locator).toBeVisible();
    await expect
      .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactFiber$"))), {
        message: "Seite wird hydriert",
      })
      .toBe(true);
  }

  async openStart(): Promise<void> {
    await this.page.goto("/");
    await this.waitForHydration(this.page.getByLabel("Dein Name"));
  }

  /** Startseite: Name eintragen und „Lobby erstellen“ → Lobby-Seite. Liefert den Code. */
  async createLobby(): Promise<string> {
    await this.openStart();
    await this.page.getByLabel("Dein Name").fill(this.name);
    await this.page.getByRole("button", { name: "Lobby erstellen" }).click();
    await this.page.waitForURL(LOBBY_URL);
    await expect(this.lobbyScreen).toBeVisible();
    return lobbyCodeFromUrl(this.page.url());
  }

  /** Startseite: Name eintragen und den Code zeichenweise tippen (Auto-Beitritt beim 6. Zeichen). */
  async typeCodeOnStart(typed: string): Promise<void> {
    await this.openStart();
    await this.page.getByLabel("Dein Name").fill(this.name);
    await this.page.getByLabel("Lobby-Code").pressSequentially(typed, { delay: 30 });
  }

  /** Beitritt per Code-Eingabe auf der Startseite. */
  async joinByCode(code: string, typed: string = code): Promise<void> {
    await this.typeCodeOnStart(typed);
    await this.page.waitForURL(`**/lobby/${code}`);
    await expect(this.lobbyScreen).toBeVisible();
  }

  /** Kurzlink `/j/<code>` öffnen und Namen eintragen (ohne abzuschicken). */
  async openJoinLink(path: string): Promise<void> {
    await this.page.goto(path);
    await this.waitForHydration(this.page.getByLabel("Dein Name"));
    await this.page.getByLabel("Dein Name").fill(this.name);
  }

  /** Beitritt per Kurzlink `/j/<code>`. */
  async joinByLink(code: string, path = `/j/${code}`): Promise<void> {
    await this.openJoinLink(path);
    await this.page.getByRole("button", { name: "Beitreten" }).click();
    await this.page.waitForURL(`**/lobby/${code}`);
    await expect(this.lobbyScreen).toBeVisible();
  }

  // --- Lobby ----------------------------------------------------------------------------------------

  /** Einstellungen-Sheet öffnen, Werte setzen (Stepper), „Fertig“. */
  async changeSettings(values: Partial<Record<SettingLabel, number>>): Promise<void> {
    await this.page.getByRole("button", { name: "Einstellungen" }).click();
    const sheet = this.page.getByRole("dialog", { name: "Einstellungen" });
    await expect(sheet).toBeVisible();
    for (const [label, target] of Object.entries(values) as [SettingLabel, number][]) {
      const stepper = sheet.getByRole("group", { name: label });
      const output = stepper.locator("output");
      for (let guard = 0; guard < 10; guard++) {
        const current = Number(await output.textContent());
        if (current === target) break;
        const button = current > target ? `${label} verringern` : `${label} erhöhen`;
        await stepper.getByRole("button", { name: button }).click();
        await expect(output).not.toHaveText(String(current));
      }
      await expect(output).toHaveText(String(target));
    }
    await sheet.getByRole("button", { name: "Fertig" }).click();
    await expect(sheet).toBeHidden();
  }

  async addBot(): Promise<void> {
    await this.page.getByRole("button", { name: "Bot hinzufügen" }).click();
  }

  /** Host: „Spiel starten“ → Spiel-Screen. */
  async startGame(): Promise<void> {
    await expect(this.startButton).toBeEnabled();
    await this.startButton.click();
    await expect(this.gameScreen).toBeVisible();
  }

  /** Lobby über „Lobby verlassen“ (Kopfzeile) und den Bestätigungsdialog verlassen → Startseite. */
  async leaveLobby(): Promise<void> {
    await this.page.getByRole("button", { name: "Lobby verlassen" }).click();
    const dialog = this.page.getByRole("alertdialog", { name: "Lobby verlassen?" });
    await dialog.getByRole("button", { name: "Verlassen" }).click();
    await this.page.waitForURL((url) => url.pathname === "/");
  }

  /** Host: Person über „<Name> entfernen“ und den Dialog aus der Lobby entfernen. */
  async kick(name: string): Promise<void> {
    await this.page.getByRole("button", { name: `${name} entfernen` }).click();
    const dialog = this.page.getByRole("alertdialog", { name: `${name} entfernen?` });
    await dialog.getByRole("button", { name: "Entfernen" }).click();
    await expect(dialog).toBeHidden();
  }

  // --- Spiel ----------------------------------------------------------------------------------------

  /** Im Spiel über „Aufgeben“ (HUD) und „Spiel verlassen?“ → Startseite. */
  async resign(): Promise<void> {
    await this.page.getByRole("button", { name: "Aufgeben" }).click();
    const dialog = this.page.getByRole("alertdialog", { name: "Spiel verlassen?" });
    await expect(dialog).toContainText("Du giltst dann als aufgegeben.");
    await dialog.getByRole("button", { name: "Verlassen" }).click();
    await this.page.waitForURL((url) => url.pathname === "/");
  }

  /** Eigener Eintrag im Spielerstreifen (eigene Person steht immer zuerst). */
  get selfStripEntry(): Locator {
    return this.stripPlayers.first();
  }

  /** Punkte eines Streifen-Eintrags (Screenreader-Text „3 Punkte“ – unabhängig von der Zähl-Animation). */
  async scoreOf(entry: Locator): Promise<number> {
    const text = await entry.getByText(/^\d+ Punkte?$/).textContent();
    const match = /^(\d+)/.exec(text ?? "");
    if (!match?.[1]) throw new Error(`Keine Punkte im Spielerstreifen von ${this.name}`);
    return Number(match[1]);
  }

  async ownScore(): Promise<number> {
    return this.scoreOf(this.selfStripEntry);
  }

  /** Rangliste am Spielende als Textzeilen (Platz, Name, Status, Punkte). */
  async rankingLines(): Promise<string[]> {
    const items = this.page.getByRole("list", { name: "Rangliste" }).getByRole("listitem");
    return (await items.allInnerTexts()).map((line) => line.replace(/\s+/g, " ").trim());
  }
}
