/**
 * Szenario 9 (docs/11): A11y-Check (axe) in jeder Phase – plus die automatisierbaren Punkte der Design-Abnahme
 * (docs/09 §13): kein horizontales Scrollen bei 360 × 740 und 430 × 932 (Projekte `a11y-360`/`a11y-430`),
 * höchstens eine orange Hauptaktion, keine Emojis, keine beliebigen Werte in Klassen, längste Frage (140 Zeichen)
 * und Antworten (40 Zeichen) passen. Jede Phase wird als Screenshot abgelegt (DoD Phase 3).
 *
 * Läuft gegen den Normal-Stack (`GAME_TIMING=normal`, Fixtures als Langtext-Variante): Phasen in
 * Originallänge, damit axe jede Phase sicher trifft. Zusätzlich die Host-Modi (ADR-045/049) mit 8 Personen und ein
 * komplettes Spiel mit reduzierter Bewegung.
 */
import type { Locator, TestInfo } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { stageOverlay } from "./support/game.ts";
import { UNKNOWN_PAGE_PATH } from "./support/monitor.ts";
import { CHUNK_FAILURE_ERRORS, failLazyChunks, OFFLINE_ERRORS } from "./support/network.ts";
import {
  type AnswerPlan,
  answer,
  answerByKeyboard,
  type OverlayName,
  openAnswers,
  pickByKeyboard,
  pickFirstCategory,
  pickRoles,
  pickUntilQuestion,
  playQuicklyUntil,
  waitForOverlay,
} from "./support/phases.ts";
import type { Player } from "./support/player.ts";
import {
  checkScreen,
  checkTextZoom,
  PLAYER_STRIP_SCROLL,
  questionTextFit,
  setTextZoom,
} from "./support/screen-checks.ts";
import { countByOverlay, stageEvents } from "./support/stage-recorder.ts";

/** Länge der Langtext-Variante (e2e/stack/long-texts.ts = Höchstwerte des Katalog-Schemas). */
const LONGEST_PROMPT = 140;
const LONGEST_ANSWER = 40;

/** Phase prüfen: Overlay steht → axe + Layout + Screenshot; das Overlay muss währenddessen stehen bleiben. */
async function checkPhase(
  player: Player,
  overlay: OverlayName,
  name: string,
  testInfo: TestInfo,
  options: { screenshot?: boolean } = {},
): Promise<Locator> {
  const locator = await waitForOverlay(player, overlay);
  await checkScreen(player.page, name, testInfo, { stays: locator, ...options });
  return locator;
}

/** Frage bzw. Auflösung: Langtext passt (nichts abgeschnitten, nichts ragt über den Rand). */
async function checkLongQuestion(
  player: Player,
  overlay: "question" | "answer-reveal",
  name: string,
  testInfo: TestInfo,
): Promise<void> {
  const fit = await questionTextFit(stageOverlay(player.page, overlay));
  await testInfo.attach(`text-fit-${name}.json`, {
    body: JSON.stringify(fit, null, 2),
    contentType: "application/json",
  });
  expect.soft(fit.promptLength, `${name}: Fragetext ist die Langtext-Variante`).toBe(LONGEST_PROMPT);
  expect.soft(fit.longestAnswer, `${name}: Antworten sind die Langtext-Variante`).toBe(LONGEST_ANSWER);
  expect.soft(fit.clipped, `${name}: Text abgeschnitten oder über den Rand`).toEqual([]);
  // docs/09 §5: Antworttext bis 2 Zeilen – bei üblichen Wortlängen auch mit 40 Zeichen (ein einzelnes langes
  // Kompositum darf eine dritte Zeile erzwingen, abgeschnitten wird auch dann nichts).
  for (const { text, lines } of fit.answers) {
    if (text.split(" ").every((word) => word.length <= 12)) {
      expect.soft(lines, `${name}: „${text}“ in höchstens 2 Zeilen`).toBeLessThanOrEqual(2);
    }
  }
  for (const { text, height } of fit.answers) {
    expect.soft(height, `${name}: Antwort „${text}“ mindestens 64 px hoch (docs/09 §12)`).toBeGreaterThanOrEqual(64);
  }
  if (!fit.answersInViewport) {
    testInfo.annotations.push({ type: "info", description: `${name}: letzte Antwort erst nach Scrollen sichtbar` });
  }
}

test.describe("Szenario 9: A11y und Design-Abnahme je Phase", () => {
  test("Start, Beitreten, Fehlerseite, 404, Lobby nicht gefunden, Offline, Entfernt", async ({ players }, testInfo) => {
    const mia = await players.create("Mia");
    await mia.openStart();
    await checkScreen(mia.page, "start", testInfo);
    // Die drei Wege als Gruppe (ADR-043, docs/09 §6): je 16 px zwischen „Lobby erstellen“, „oder“, Code, „oder“ und
    // „QR-Code scannen“ – die Statuszeile „Trete bei …“ kostet im Leerlauf keinen Platz.
    const rhythm = await mia.page.evaluate(() => {
      const box = (element: Element | null | undefined) => element?.getBoundingClientRect() ?? null;
      const create = box(document.querySelector('[data-testid="start-create"]'));
      const code = box(document.querySelector('[data-testid="start-join-status"]')?.parentElement);
      const scan = box(document.querySelector('[data-testid="start-scan"]'));
      const ors = [...document.querySelectorAll("main span")]
        .filter((span) => span.textContent === "oder")
        .map((span) => box(span.parentElement));
      const [orBefore, orAfter] = ors;
      if (!create || !code || !scan || !orBefore || !orAfter) return null;
      return [
        orBefore.top - create.bottom,
        code.top - orBefore.bottom,
        orAfter.top - code.bottom,
        scan.top - orAfter.bottom,
      ];
    });
    expect(rhythm, "Abstände zwischen den drei Wegen").not.toBeNull();
    for (const gap of rhythm ?? []) expect(gap).toBeCloseTo(16, 0);

    // Sichtbarer Fokus (docs/09 §5, §12): per Tab auf „Lobby erstellen“ → 2-px-Ring in primary.
    await mia.page.getByLabel("Dein Name").focus();
    await mia.page.keyboard.press("Tab");
    const ring = await mia.page.evaluate(() => {
      const element = document.activeElement;
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim(),
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
      };
    });
    expect(ring).toEqual({ text: "Lobby erstellen", style: "solid", width: "2px", color: "rgb(255, 138, 31)" });

    // Unbekannter Code: Fehler unter dem Code (Auto-Beitritt beim 6. Zeichen).
    await mia.page.getByLabel("Dein Name").fill(mia.name);
    await mia.page.getByLabel("Lobby-Code").pressSequentially("ZZZZ22", { delay: 30 });
    await expect(mia.page.getByRole("alert").filter({ hasText: "Lobby nicht gefunden." })).toBeVisible();
    await checkScreen(mia.page, "start-fehler", testInfo);

    await mia.openJoinLink("/j/ZZZZ22");
    await checkScreen(mia.page, "beitreten", testInfo);
    await mia.page.getByRole("button", { name: "Beitreten" }).click();
    await expect(mia.page.getByTestId("join-error")).toHaveText("Lobby nicht gefunden.");
    await checkScreen(mia.page, "beitreten-fehler", testInfo);

    const unknown = await mia.page.goto(UNKNOWN_PAGE_PATH);
    expect(unknown?.status()).toBe(404);
    await expect(mia.page.getByTestId("not-found")).toBeVisible();
    await checkScreen(mia.page, "404", testInfo);

    const invalid = await mia.page.goto("/j/abc");
    expect(invalid?.status()).toBe(404);
    await expect(mia.page.getByTestId("lobby-not-found")).toBeVisible();
    await checkScreen(mia.page, "lobby-nicht-gefunden", testInfo);

    // Offline-Seite (Rückfall des Service Workers ohne Netz – der Netzverlust selbst: Szenario 10).
    await mia.page.goto("/offline");
    await expect(mia.page.getByRole("heading", { name: "Du bist offline." })).toBeVisible();
    await checkScreen(mia.page, "offline", testInfo);

    // Unerwarteter Fehler (app/error.tsx): Nachladen eines Chunks scheitert (Netzabbruch direkt nach dem
    // Seitenaufruf). Ist das Netz zurück, muss „Erneut versuchen“ die Seite wiederherstellen.
    const lea = await players.create("Lea", { serviceWorkers: "block", expectedConsoleErrors: CHUNK_FAILURE_ERRORS });
    const restoreNetwork = await failLazyChunks(lea.page, "/lobby/ZZZZ22");
    await lea.page.goto("/lobby/ZZZZ22");
    const errorPage = lea.page.getByTestId("error-page");
    await expect(
      errorPage.getByRole("heading", { name: "Da ist etwas schiefgelaufen. Versuch es noch mal." }),
    ).toBeVisible();
    await checkScreen(lea.page, "fehlerseite", testInfo);
    await restoreNetwork();
    await errorPage.getByRole("button", { name: "Erneut versuchen" }).click();
    // Ohne Mitgliedschaft führt die Lobby-Seite weiter zur Beitreten-Seite.
    await lea.page.waitForURL("**/j/ZZZZ22");
    await expect(lea.page.getByTestId("join-screen")).toBeVisible();

    // Aus der Lobby entfernt: Hinweis-Seite mit Weg zur Startseite.
    const ben = await players.create("Ben");
    const code = await mia.createLobby();
    await ben.joinByCode(code);
    await mia.kick("Ben");
    await expect(ben.page.getByTestId("lobby-exit")).toBeVisible();
    await checkScreen(ben.page, "entfernt", testInfo);
  });

  test("2 Personen: Lobby, Einstellungen, jede Spielphase, Duell-Spielende, Fragen ansehen", async ({
    players,
  }, testInfo) => {
    test.setTimeout(300_000);
    // Wer im 2. Zug zuschaut, geht kurz offline (Verbindungs-Overlay) – Chromium meldet dabei Verbindungsfehler.
    const mia = await players.create("Mia", { expectedConsoleErrors: OFFLINE_ERRORS });
    const ben = await players.create("Ben", { expectedConsoleErrors: OFFLINE_ERRORS });

    // --- Lobby ---------------------------------------------------------------------------------------------
    const code = await mia.createLobby();
    await expect(mia.startButton).toHaveAttribute("aria-disabled", "true");
    await checkScreen(mia.page, "lobby-allein", testInfo);
    await ben.joinByCode(code);
    await expect(mia.lobbyPlayers).toHaveCount(2);
    await checkScreen(mia.page, "lobby-host", testInfo);
    await checkScreen(ben.page, "lobby-gast", testInfo);

    await mia.page.getByRole("button", { name: "QR-Code zeigen" }).click();
    await expect(mia.page.getByTestId("lobby-qr")).toBeVisible();
    await checkScreen(mia.page, "lobby-qr", testInfo);
    await mia.page.getByRole("button", { name: "QR-Code ausblenden" }).click();

    const settingsButton = mia.page.getByRole("button", { name: "Einstellungen", exact: true });
    await settingsButton.click();
    const sheet = mia.page.getByRole("dialog", { name: "Einstellungen" });
    await expect(sheet).toBeVisible();
    await checkScreen(mia.page, "einstellungen", testInfo);
    // Tastatur (docs/09 §12, modale Ebenen): Escape schließt das Sheet, der Fokus kehrt zum Auslöser zurück.
    await mia.page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(settingsButton).toBeFocused();
    await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });

    const leaveButton = mia.page.getByRole("button", { name: "Lobby verlassen" });
    await leaveButton.click();
    const leave = mia.page.getByRole("alertdialog", { name: "Lobby verlassen?" });
    await expect(leave).toBeVisible();
    // Fokus startet auf der sicheren Wahl „Bleiben“ und bleibt per Tab im Dialog (Fokusfalle).
    await expect(leave.getByRole("button", { name: "Bleiben" })).toBeFocused();
    await checkScreen(mia.page, "lobby-verlassen-dialog", testInfo);
    for (let step = 0; step < 3; step++) {
      await mia.page.keyboard.press("Tab");
      expect(await leave.evaluate((dialog) => dialog.contains(document.activeElement)), "Fokus bleibt im Dialog").toBe(
        true,
      );
    }
    await mia.page.keyboard.press("Escape");
    await expect(leave).toBeHidden();
    await expect(leaveButton).toBeFocused();

    await mia.page.getByRole("button", { name: "Ben entfernen" }).click();
    const kick = mia.page.getByRole("alertdialog", { name: "Ben entfernen?" });
    await expect(kick).toBeVisible();
    await checkScreen(mia.page, "entfernen-dialog", testInfo);
    await kick.getByRole("button", { name: "Abbrechen" }).click();
    await expect(kick).toBeHidden();

    // --- Zug 1: alle Phasen ----------------------------------------------------------------------------------
    await mia.startGame();
    await checkPhase(mia, "intro", "intro-2p", testInfo);

    const turn1 = await pickRoles([mia, ben]);
    const watcher1 = turn1.watchers[0];
    if (!watcher1) throw new Error("keine zuschauende Person");
    await Promise.all([
      checkPhase(turn1.picker, "category-pick", "kategoriewahl-waehlen", testInfo),
      checkPhase(watcher1, "category-pick", "kategoriewahl-zuschauen", testInfo),
    ]);
    // Tastatur (docs/09 §12): Die Kachelgruppe hat den Fokus, `1` wählt die erste Kategorie.
    const category = await pickByKeyboard(turn1.picker, 1);
    await checkPhase(mia, "category-reveal", "kategorie-reveal", testInfo);
    await expect(mia.page.getByTestId("category-strip")).toContainText(category);

    await Promise.all([waitForOverlay(mia, "question"), waitForOverlay(ben, "question")]);
    await expect(openAnswers(mia)).toHaveCount(4);
    await checkPhase(mia, "question", "frage", testInfo);
    await checkLongQuestion(mia, "question", "frage", testInfo);
    // Antworten per Tastatur: Mia mit Buchstabe (`A`–`D`), Ben mit Ziffer (`1`–`4`).
    await answerByKeyboard(mia, "correct", "letter");
    await expect(mia.page.getByTestId("question-waiting")).toHaveText("Warte auf 1 weitere …");
    await checkPhase(mia, "question", "eingeloggt", testInfo);
    const benChoice = await answerByKeyboard(ben, "wrong", "digit");

    await Promise.all([
      checkPhase(mia, "answer-reveal", "aufloesung-richtig", testInfo),
      checkPhase(ben, "answer-reveal", "aufloesung-falsch", testInfo),
    ]);
    // Richtig/Falsch-Icons kosten Breite: der Langtext muss auch in der Auflösung passen.
    await checkLongQuestion(ben, "answer-reveal", "aufloesung-falsch", testInfo);
    await expect(stageOverlay(ben.page, "answer-reveal").getByTestId(`answer-${benChoice}`)).toHaveAttribute(
      "data-state",
      "wrong",
    );
    await checkPhase(mia, "turn-summary", "zug-ergebnis", testInfo);

    // --- Zug 2: Aufgeben-Dialog, Verbindungs-Overlay, „Zeit abgelaufen“ --------------------------------------
    const turn2 = await pickRoles([mia, ben]);
    const watcher2 = turn2.watchers[0];
    if (!watcher2) throw new Error("keine zuschauende Person");
    // Aufgeben gibt es nur für Mitspielende ohne Host-Rolle – der Host beendet stattdessen (ADR-051).
    await ben.page.getByRole("button", { name: "Aufgeben" }).click();
    const resign = ben.page.getByRole("alertdialog", { name: "Spiel verlassen?" });
    await expect(resign).toBeVisible();
    await checkScreen(ben.page, "aufgeben-dialog", testInfo);
    await resign.getByRole("button", { name: "Weiterspielen" }).click();
    await expect(resign).toBeHidden();

    // Netzverlust während der Kategoriewahl der anderen Person: Verbindungs-Overlay mit Frist-Countdown.
    await watcher2.page.context().setOffline(true);
    await expect(watcher2.page.getByTestId("connection-overlay")).toBeVisible();
    await expect(watcher2.page.getByTestId("connection-countdown")).toBeVisible();
    await checkScreen(watcher2.page, "verbindung", testInfo);
    await watcher2.page.context().setOffline(false);
    await expect(watcher2.page.getByTestId("connection-overlay")).toBeHidden({ timeout: 15_000 });

    await pickFirstCategory(turn2.picker);
    await Promise.all([waitForOverlay(mia, "question"), waitForOverlay(ben, "question")]);
    await answer(mia, "correct");
    // Ben antwortet nicht: Auflösung erst nach Ablauf der 20 s, mit „Zeit abgelaufen“.
    const timeUp = await waitForOverlay(ben, "answer-reveal", 30_000);
    await expect(timeUp.getByTestId("reveal-time-up")).toBeVisible();
    await checkScreen(ben.page, "aufloesung-zeit-abgelaufen", testInfo, { stays: timeUp });

    // --- Rundentafel und Spielende (Duell) -----------------------------------------------------------------
    await checkPhase(mia, "round-board", "rundentafel-2p", testInfo);
    await Promise.all([
      checkPhase(mia, "game-over", "spielende-2p-gewonnen", testInfo),
      checkPhase(ben, "game-over", "spielende-2p-verloren", testInfo),
    ]);
    await expect(mia.page.getByTestId("game-over-headline")).toHaveText("Gewonnen");
    await expect(ben.page.getByTestId("game-over-headline")).toHaveText("Verloren");

    // --- Nach dem Ergebnis (6 s) zurück in der Lobby: Karte „Letztes Spiel“ (ADR-038) ---------------------
    await expect(ben.page.getByTestId("lobby-last-game")).toBeVisible({ timeout: 15_000 });
    await checkScreen(ben.page, "lobby-nach-spiel", testInfo);
    await ben.page.getByRole("button", { name: "Ergebnis ansehen" }).click();
    const resultSheet = ben.page.getByRole("dialog", { name: "Ergebnis" });
    await expect(resultSheet.getByRole("table")).toBeVisible();
    await checkScreen(ben.page, "spielverlauf", testInfo);
    await resultSheet.getByRole("button", { name: "Schließen" }).click();
    await expect(resultSheet).toBeHidden();

    await ben.page.getByRole("button", { name: "Fragen ansehen" }).click();
    const review = ben.page.getByRole("dialog", { name: "Fragen ansehen" });
    await expect(review.getByTestId("review-item")).toHaveCount(2);
    await checkScreen(ben.page, "fragen-ansehen", testInfo);
    await review.getByTestId("review-item").first().getByRole("button", { name: "Frage melden" }).click();
    const reportView = ben.page.getByRole("dialog", { name: "Frage melden" });
    await expect(reportView.getByTestId("report-reasons")).toBeVisible();
    await checkScreen(ben.page, "frage-melden", testInfo);
    await reportView.getByRole("button", { name: "Mehrdeutig" }).click();
    await expect(ben.toast("Danke, wir prüfen die Frage.")).toBeVisible();
    await checkScreen(ben.page, "frage-gemeldet", testInfo);
  });

  test("3 Personen: Intro mit Reihenfolge, Rundentafel als Tabelle, Podest und Rangliste", async ({
    players,
  }, testInfo) => {
    test.setTimeout(240_000);
    const mia = await players.create("Mia");
    const ben = await players.create("Ben");
    const lea = await players.create("Lea");
    const all = [mia, ben, lea];
    const code = await mia.createLobby();
    await ben.joinByCode(code);
    await lea.joinByLink(code);
    await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
    await expect(mia.lobbyPlayers).toHaveCount(3);
    await checkScreen(lea.page, "lobby-gast-3p", testInfo);

    await mia.startGame();
    await checkPhase(mia, "intro", "intro-3p", testInfo);
    // Verschiedene Plätze für ein echtes Podest: Mia immer richtig, Ben nur bei der ersten Frage, Lea nie.
    const plan: AnswerPlan = (player, index) =>
      player === mia || (player === ben && index === 0) ? "correct" : "wrong";
    const answered = new Map<Player, number>();
    await playQuicklyUntil(all, "turn-summary", { plan, answered });
    await checkPhase(lea, "turn-summary", "zug-ergebnis-3p", testInfo);
    await playQuicklyUntil(all, "round-board", { plan, answered });
    await checkPhase(mia, "round-board", "rundentafel-3p", testInfo);
    await Promise.all(all.map((player) => waitForOverlay(player, "game-over", 30_000)));
    await expect(mia.page.getByRole("list", { name: "Podest" })).toBeVisible();
    await expect(mia.page.getByTestId("game-over-headline")).toHaveText("Gewonnen");
    await expect(ben.page.getByTestId("game-over-headline")).toHaveText("Platz 2");
    await expect(lea.page.getByTestId("game-over-headline")).toHaveText("Platz 3");
    // Das Ergebnis steht 6 s (ADR-038): beide Prüfungen parallel.
    await Promise.all([
      checkPhase(mia, "game-over", "spielende-3p", testInfo),
      checkPhase(lea, "game-over", "spielende-3p-platz-3", testInfo),
    ]);

    // Gegenprobe zum Test mit reduzierter Bewegung: Mit normaler Bewegung starten Overlays verschoben bzw.
    // skaliert (z. B. Avatare im Intro, Podest) – der Detektor des Stage-Recorders erkennt das.
    const events = await stageEvents(mia.page);
    expect(events.filter((event) => event.moving > 0).length, "Overlays mit Startbewegung").toBeGreaterThan(0);
  });

  test("Host-Modi mit 8 Personen: Frage ohne Countdown, Auflösung und Zug-Ergebnis warten auf den Host", async ({
    players,
  }, testInfo) => {
    // „Zeit pro Frage: Host“ (ADR-049) und „Weiter: Host“ (ADR-045) mit der Höchstzahl an Personen und Langtexten:
    // Die Host-Aktion steht in der Zone des Spielerstreifens (ADR-060) – bei 430 × 932 in einer zweiten Zeile unter
    // den Personen, bei 360 × 740 neben bzw. statt ihrer. Antwort D samt Avataren und alle Zeilen des Zug-Ergebnisses
    // bleiben sichtbar (checkScreen prüft Lage und genau eine orange Aktion).
    test.setTimeout(240_000);
    const mia = await players.create("Mia");
    const ben = await players.create("Ben");
    const all = [mia, ben];
    const code = await mia.createLobby();
    await ben.joinByCode(code);
    for (let bot = 1; bot <= 6; bot++) {
      await mia.addBot();
      await expect(mia.lobbyPlayer(`Bot ${bot}`)).toBeVisible();
    }
    await expect(mia.lobbyPlayers).toHaveCount(8);
    await mia.changeSettings({
      Runden: 1,
      "Fragen pro Kategorie": 1,
      "Zeit pro Frage": 0,
      "Nach jeder Frage": 0,
      "Nach jeder Kategorie": 0,
    });
    await mia.startGame();
    await pickUntilQuestion(all);
    // 8 Personen: Der Spielerstreifen scrollt gewollt waagerecht (docs/09 §7).
    const scrolls = { allowHorizontalScroll: [PLAYER_STRIP_SCROLL] };

    // --- Frage ohne Countdown: Mia (Host) „Auflösen (x/8 Antworten)“ unter bzw. statt der Personen, Ben den Streifen ---
    const [miaQuestion, benQuestion] = await Promise.all(all.map((player) => waitForOverlay(player, "question")));
    if (!miaQuestion || !benQuestion) throw new Error("Frage fehlt");
    const resolve = mia.page.getByTestId("player-strip").getByTestId("game-continue");
    await expect(resolve).toHaveText(/^Auflösen \(\d\/8 Antworten\)$/);
    await expect(ben.page.getByTestId("game-continue")).toHaveCount(0);
    await expect(ben.stripPlayers).toHaveCount(8);
    await checkScreen(mia.page, "host-frage-ohne-countdown-8p", testInfo, { stays: miaQuestion, ...scrolls });
    await checkLongQuestion(mia, "question", "host-frage-ohne-countdown-8p", testInfo);
    await checkScreen(ben.page, "gast-frage-ohne-countdown-8p", testInfo, { stays: benQuestion, ...scrolls });

    // Ben antwortet D (Avatar an der letzten Antwort), Mia löst ohne eigene Antwort auf („Zeit abgelaufen“).
    await benQuestion.getByTestId("answer-3").click();
    await expect(openAnswers(ben)).toHaveCount(0);
    await expect(resolve).not.toHaveAttribute("aria-disabled", "true");
    await resolve.click();

    // --- Auflösung wartet auf „Weiter“: Host „Weiter“ unter bzw. neben den Personen, alle anderen „Warte auf Mia …“ ---
    const [miaReveal, benReveal] = await Promise.all(all.map((player) => waitForOverlay(player, "answer-reveal")));
    if (!miaReveal || !benReveal) throw new Error("Auflösung fehlt");
    await expect(mia.page.getByTestId("player-strip").getByTestId("game-continue")).toHaveText("Weiter");
    await expect(ben.page.getByTestId("player-strip").getByTestId("game-continue-waiting")).toHaveText(
      "Warte auf Mia …",
    );
    await expect(mia.stripPlayers).toHaveCount(8);
    await expect(benReveal.getByTestId("answer-3").locator(":scope > span.absolute")).toBeVisible();
    await Promise.all([
      checkScreen(mia.page, "host-aufloesung-8p", testInfo, { stays: miaReveal, ...scrolls }),
      checkScreen(ben.page, "gast-aufloesung-8p-warte", testInfo, { stays: benReveal, ...scrolls }),
    ]);

    // --- Zug-Ergebnis wartet auf „Weiter“: alle 8 Zeilen über dem Spielerstreifen ---
    await mia.page.getByTestId("game-continue").click();
    const [miaSummary, benSummary] = await Promise.all(all.map((player) => waitForOverlay(player, "turn-summary")));
    if (!miaSummary || !benSummary) throw new Error("Zug-Ergebnis fehlt");
    await expect(miaSummary.getByTestId("turn-summary-row")).toHaveCount(8);
    await expect(ben.page.getByTestId("player-strip").getByTestId("game-continue-waiting")).toBeVisible();
    await Promise.all([
      checkScreen(mia.page, "host-zug-ergebnis-8p", testInfo, { stays: miaSummary, ...scrolls }),
      checkScreen(ben.page, "gast-zug-ergebnis-8p", testInfo, { stays: benSummary, ...scrolls }),
    ]);

    // Spiel für alle beenden (ADR-051) – die übrigen Züge braucht die Prüfung nicht.
    await mia.page.getByRole("button", { name: "Spiel beenden" }).click();
    await mia.page
      .getByRole("alertdialog", { name: "Spiel für alle beenden?" })
      .getByRole("button", { name: "Beenden" })
      .click();
    await Promise.all(all.map((player) => waitForOverlay(player, "game-over")));
  });

  for (const count of [3, 4] as const) {
    test(`Host-Aktion mit ${count} Personen: alle Punkte sichtbar, wo Platz ist (ADR-060)`, async ({
      players,
    }, testInfo) => {
      // docs/09 §7: bis 4 Personen verteilt. Ist der Viewport hoch genug (430 × 932), stehen „Auflösen …“, „Weiter“
      // und „Warte auf Mia …“ in einer zweiten Zeile unter den Personen – nichts scrollt. Bei 360 × 740 fehlt der Bühne
      // dafür die Höhe (Antwort D): dann „Weiter“ bzw. der Hinweis neben der Liste (sie scrollt, eigene Person
      // zuerst) und „Auflösen …“ statt der Liste – für Screenreader bleibt der Spielstand (ADR-060).
      test.setTimeout(180_000);
      const tall = testInfo.project.name === "a11y-430";
      const mia = await players.create("Mia");
      const ben = await players.create("Ben");
      const all = [mia, ben];
      const code = await mia.createLobby();
      await ben.joinByCode(code);
      for (let bot = 1; bot <= count - 2; bot++) {
        await mia.addBot();
        await expect(mia.lobbyPlayer(`Bot ${bot}`)).toBeVisible();
      }
      await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1, "Zeit pro Frage": 0, "Nach jeder Frage": 0 });
      await mia.startGame();
      await pickUntilQuestion(all);
      const scrolls = tall ? {} : { allowHorizontalScroll: [PLAYER_STRIP_SCROLL] };

      /** Lage der Zone: Art der Aktion, Liste ohne Scrollen, alle Personen ganz im Viewport. */
      const zone = (player: Player) =>
        player.page.getByTestId("player-strip").evaluate((strip) => {
          const list = strip.querySelector("ul");
          const entries = [...strip.querySelectorAll('[data-testid="strip-player"]')].map((entry) =>
            entry.getBoundingClientRect(),
          );
          const action = strip.querySelector('[data-testid="game-continue"], [data-testid="game-continue-waiting"]');
          return {
            layout: strip.getAttribute("data-action-layout"),
            listScrolls: list !== null && list.scrollWidth > list.clientWidth + 1,
            entriesInView: entries.every((box) => box.left >= 0 && box.right <= window.innerWidth && box.width > 0),
            actionBelowList:
              list !== null &&
              action !== null &&
              action.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 1,
          };
        });

      // --- Frage ohne Countdown: Mia „Auflösen (x/y Antworten)“, Ben nur der Streifen ---
      const [miaQuestion, benQuestion] = await Promise.all(all.map((player) => waitForOverlay(player, "question")));
      if (!miaQuestion || !benQuestion) throw new Error("Frage fehlt");
      await expect(mia.page.getByTestId("player-strip").getByTestId("game-continue")).toHaveText(
        new RegExp(`^Auflösen \\(\\d/${count} Antworten\\)$`),
      );
      await expect(mia.stripPlayers).toHaveCount(count);
      const miaAsks = await zone(mia);
      if (tall) {
        expect(miaAsks).toEqual({ layout: "stacked", listScrolls: false, entriesInView: true, actionBelowList: true });
      } else {
        expect(miaAsks.layout).toBe("instead");
        await expect(mia.page.getByRole("list", { name: "Spielstand" })).toHaveCount(1);
      }
      await checkScreen(mia.page, `host-frage-ohne-countdown-${count}p`, testInfo, { stays: miaQuestion, ...scrolls });
      expect((await zone(ben)).listScrolls, "Ben: Streifen ohne Aktion").toBe(false);

      await benQuestion.getByTestId("answer-3").click();
      await expect(openAnswers(ben)).toHaveCount(0);
      const resolve = mia.page.getByTestId("game-continue");
      await expect(resolve).not.toHaveAttribute("aria-disabled", "true");
      await resolve.click();

      // --- Auflösung wartet: Mia „Weiter“, Ben „Warte auf Mia …“ ---
      const [miaReveal, benReveal] = await Promise.all(all.map((player) => waitForOverlay(player, "answer-reveal")));
      if (!miaReveal || !benReveal) throw new Error("Auflösung fehlt");
      await expect(ben.page.getByTestId("player-strip").getByTestId("game-continue-waiting")).toHaveText(
        "Warte auf Mia …",
      );
      for (const player of all) {
        const shown = await zone(player);
        if (tall) {
          expect(shown, player.name).toEqual({
            layout: "stacked",
            listScrolls: false,
            entriesInView: true,
            actionBelowList: true,
          });
        } else {
          expect(shown.layout, player.name).toBe("beside");
          // Ausnahme (ADR-060): neben der Aktion scrollt die Liste – die eigene Person steht immer ganz vorn.
          await expect(player.selfStripEntry).toBeInViewport({ ratio: 1 });
        }
      }
      await Promise.all([
        checkScreen(mia.page, `host-aufloesung-${count}p`, testInfo, { stays: miaReveal, ...scrolls }),
        checkScreen(ben.page, `gast-aufloesung-${count}p-warte`, testInfo, { stays: benReveal, ...scrolls }),
      ]);
      await mia.page.getByRole("button", { name: "Spiel beenden" }).click();
      await mia.page
        .getByRole("alertdialog", { name: "Spiel für alle beenden?" })
        .getByRole("button", { name: "Beenden" })
        .click();
      await Promise.all(all.map((player) => waitForOverlay(player, "game-over")));
    });
  }

  test("Text-Zoom 200 %: Lobby, Einstellungen, Kategoriewahl und Ergebnis ohne Verlust (WCAG 1.4.4)", async ({
    players,
  }, testInfo) => {
    // docs/09 §12 „Zoom bis 200 % ohne Verlust“: Schrift der Seite 200 % (wie „Schriftgröße“ im Browser) – keine
    // Beschriftung ohne Breite, kein abgeschnittener Name, kein Bedienelement außerhalb des Viewports.
    test.setTimeout(240_000);
    const mia = await players.create("Mia");
    const ben = await players.create("Ben Sommer");
    const lea = await players.create("Lea");
    const all = [mia, ben, lea];
    const code = await mia.createLobby();
    await ben.joinByCode(code);
    await lea.joinByCode(code);
    await expect(mia.lobbyPlayers).toHaveCount(3);
    await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
    for (const player of all) await setTextZoom(player.page, 200);
    await checkTextZoom(mia.page, "lobby-host-textzoom200", testInfo);
    await checkTextZoom(ben.page, "lobby-gast-textzoom200", testInfo);

    const settingsButton = mia.page.getByRole("button", { name: "Einstellungen", exact: true });
    await settingsButton.click();
    const sheet = mia.page.getByRole("dialog", { name: "Einstellungen" });
    await expect(sheet).toBeVisible();
    await checkTextZoom(mia.page, "einstellungen-host-textzoom200", testInfo);
    await mia.page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await mia.startGame();
    const { picker, watchers } = await pickRoles(all);
    const watcher = watchers[0];
    if (!watcher) throw new Error("keine zuschauende Person");
    await Promise.all([
      checkTextZoom(picker.page, "kategoriewahl-waehlen-textzoom200", testInfo),
      checkTextZoom(watcher.page, "kategoriewahl-zuschauen-textzoom200", testInfo),
    ]);
    await playQuicklyUntil(all, "game-over");
    await waitForOverlay(ben, "game-over");
    await checkTextZoom(ben.page, "spielende-textzoom200", testInfo);
  });

  test("reduzierte Bewegung: komplettes Spiel nur mit Überblendungen", async ({ players }, testInfo) => {
    // Einmal genügt (docs/11: „einmal komplett durchspielen“) – im kleinsten Referenz-Viewport.
    test.skip(testInfo.project.name !== "a11y-360", "einmal je Lauf, im 360er-Viewport");
    test.setTimeout(240_000);
    const mia = await players.create("Mia");
    const ben = await players.create("Ben");
    const lea = await players.create("Lea");
    const all = [mia, ben, lea];
    for (const player of all) {
      await player.page.emulateMedia({ reducedMotion: "reduce" });
      expect(await player.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    }
    const code = await mia.createLobby();
    await ben.joinByCode(code);
    await lea.joinByCode(code);
    await mia.changeSettings({ Runden: 1, "Fragen pro Kategorie": 1 });
    await mia.startGame();

    // Jede Phase mit axe (ohne Screenshots – die Bilder liefert der Lauf mit normaler Bewegung).
    const quiet = { screenshot: false };
    await checkPhase(mia, "intro", "reduziert-intro", testInfo, quiet);
    const { picker } = await pickRoles(all);
    await checkPhase(mia, "category-pick", "reduziert-kategoriewahl", testInfo, quiet);
    await pickFirstCategory(picker);
    await checkPhase(mia, "category-reveal", "reduziert-kategorie-reveal", testInfo, quiet);
    await Promise.all(all.map((player) => waitForOverlay(player, "question")));
    await checkPhase(mia, "question", "reduziert-frage", testInfo, quiet);
    await Promise.all(all.map((player) => answer(player, "correct")));
    await checkPhase(mia, "answer-reveal", "reduziert-aufloesung", testInfo, quiet);
    await checkPhase(mia, "turn-summary", "reduziert-zug-ergebnis", testInfo, quiet);
    await playQuicklyUntil(all, "round-board");
    await checkPhase(mia, "round-board", "reduziert-rundentafel", testInfo, quiet);
    await checkPhase(mia, "game-over", "reduziert-spielende", testInfo, quiet);

    // Kein Overlay startet mit einer Bewegung (nur Überblendungen, docs/09 §7 „Bewegungsreduktion“).
    for (const player of all) {
      const events = await stageEvents(player.page);
      const counts = countByOverlay(events);
      expect(counts["overlay-game-over"], `${player.name}: Spielende erreicht`).toBe(1);
      const moving = events.filter((event) => event.moving > 0).map((event) => `${event.testId} (${event.moving})`);
      expect(moving, `${player.name}: Overlays mit Bewegung trotz reduzierter Bewegung`).toEqual([]);
    }
  });
});
