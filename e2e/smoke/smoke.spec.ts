/**
 * Smoke-Test gegen eine laufende Instanz – Produktionsabnahme (docs/11 §Manuelle Abnahme, automatisierbarer Teil;
 * docs/12 §Deployment „Smoke-Test“). Läuft nur über `pnpm --filter e2e test:smoke` (playwright.smoke.config.ts),
 * nie in `pnpm test:e2e` oder der CI.
 *
 * 1. Kaltstart unter Slow-4G-Drosselung (docs/01: Öffnen → Lobby < 10 s; docs/07: LCP < 1,8 s), Beitritt per
 *    `/j/<code>` vom zweiten Gerät, ein Spiel (1 Runde × 1 Frage je Kategorie) bis zum Spielende bei beiden,
 *    danach verlassen beide die Lobby; axe auf Beitreten, Lobby, Spielende und der Startseite danach.
 * 2. Startseite: Sicherheits-Header (docs/06), Nonce je Anfrage neu und an den Skripten der Seite; axe.
 * 3. Installierbarkeit (docs/10): Chromium ohne Einwände, Manifest + Icons, Service Worker aktiv.
 *
 * Über alle Tests: 0 CSP-Verstöße, 0 Konsolenfehler, 0 Seitenfehler (Fixture `smoke`). Der echte Katalog ist
 * unbekannt – geantwortet wird immer mit der ersten Antwort, nie mit Wissen über die richtige.
 */
import { dirname, relative } from "node:path";
import type { TestInfo } from "@playwright/test";
import { playUntilGameOver, stageOverlay } from "../tests/support/game.ts";
import { lobbyCodeFromUrl } from "../tests/support/player.ts";
import { checkScreen } from "../tests/support/screen-checks.ts";
import { countByOverlay, stageEvents } from "../tests/support/stage-recorder.ts";
import { COLD_START_SLO_MS, measureColdStart, START_LCP_SLO_MS } from "./cold-start.ts";
import { expect, type SmokeFixture, type SmokePerson, test } from "./fixtures.ts";
import { cspNonce, evaluatePageHeaders, type HeaderCheck, headerValues, parseCsp } from "./headers.ts";
import { chromiumInstallability, fetchManifest, type PwaReport, waitForActiveServiceWorker } from "./pwa.ts";
import type { AxeSection, GamePlayer, GameSection, HeadersSection } from "./report.ts";
import { isPlayEnabled } from "./settings.ts";

const PLAY = isPlayEnabled(process.env);
const ROUNDS = 1;
const QUESTIONS_PER_CATEGORY = 1;
/** 2 Personen × 1 Runde × 1 Frage: mit `normal`-Timing höchstens ~1 min (docs/05), dazu Puffer für das Netz. */
const GAME_TIMEOUT_MS = 180_000;

/** axe (vorhandene Hilfe `checkScreen`: axe + Layout-Regeln) auf dem aktuellen Screen, Screenshot als Artefakt. */
async function axeScreen(smoke: SmokeFixture, person: SmokePerson, screen: string, testInfo: TestInfo): Promise<void> {
  await test.step(`axe: ${screen}`, async () => {
    const result = await checkScreen(person.page, screen, testInfo, { screenshot: false });
    const file = testInfo.outputPath("screens", `${screen}.png`);
    await person.page.screenshot({ path: file });
    await testInfo.attach(`screen-${screen}.png`, { path: file, contentType: "image/png" });
    const { layout } = result;
    const section: AxeSection = {
      screen,
      person: person.name,
      device: person.device,
      violations: result.axe.violations,
      incomplete: result.axe.incomplete.length,
      passes: result.axe.passes,
      layout: [
        ...layout.horizontalScroll.map((entry) => `horizontales Scrollen: ${entry}`),
        ...(layout.primaryActions.length > 1 ? [`${layout.primaryActions.length} Hauptaktionen`] : []),
        ...layout.emojis.map((emoji) => `Emoji: ${emoji}`),
        ...layout.arbitraryClasses.map((name) => `beliebiger Wert in Klasse: ${name}`),
      ],
      screenshot: relative(dirname(testInfo.project.outputDir), file),
    };
    await smoke.record("axe", section);
    // Abnahme: keine Befunde (checkScreen meldet ernste/kritische bereits einzeln, hier alle Schweregrade).
    expect
      .soft(
        result.axe.violations.map((finding) => `${finding.id} (${finding.impact})`),
        `${screen}: axe-Befunde`,
      )
      .toEqual([]);
  });
}

/** Spielende: „Lobby verlassen“ in der Aktionsleiste und bestätigen → Startseite. */
async function leaveAfterGame(person: SmokePerson): Promise<void> {
  await person.page.getByTestId("game-over-leave").click();
  const dialog = person.page.getByRole("alertdialog", { name: "Lobby verlassen?" });
  await dialog.getByRole("button", { name: "Verlassen" }).click();
  await person.page.waitForURL((url) => url.pathname === "/");
}

/** Schritt, dessen Fehler den Test scheitern lässt, die folgenden Schritte aber nicht verhindert. */
async function softStep<T>(title: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await test.step(title, run);
  } catch (error) {
    expect.soft(error instanceof Error ? error.message : String(error), `${title} fehlgeschlagen`).toBeNull();
    return fallback;
  }
}

const FLOW_TITLE = PLAY
  ? "Kaltstart unter Slow 4G, Beitritt per Link, Spiel zu zweit, axe"
  : "Kaltstart unter Slow 4G, Beitritt per Link, Lobby zu zweit ohne Spiel, axe";

test(FLOW_TITLE, async ({ smoke }, testInfo) => {
  test.setTimeout(PLAY ? 300_000 : 180_000);
  // Kaltstart: frischer Kontext ohne Cache; ohne Service Worker, damit die Drosselung jede Anfrage trifft.
  const host = await smoke.person("Smoke Mia", "Pixel 7", { serviceWorkers: "block" });
  const cold = await test.step("Kaltstart: Öffnen → Lobby erstellt und sichtbar (Slow 4G, CPU 4×)", () =>
    measureColdStart(host.page, host.name));
  const code = cold.code;
  await smoke.record("lobby", { code, createdAt: new Date().toISOString() });
  await smoke.record("cold-start", cold);
  expect(lobbyCodeFromUrl(host.page.url()), "Lobby-Code in der Adresse").toBe(code);
  await expect(host.lobbyPlayer(host.name)).toBeVisible();
  expect
    .soft(cold.openToLobbyMs, `Kaltstart Öffnen → Lobby sichtbar (Ziel < ${COLD_START_SLO_MS} ms, docs/01)`)
    .toBeLessThan(COLD_START_SLO_MS);
  if (cold.lcpMs === null) {
    // Nur möglich, wenn die Lobby als neues Dokument lädt – dann fehlt der LCP-Eintrag der Startseite.
    testInfo.annotations.push({ type: "info", description: "LCP der Startseite nicht gemessen" });
  } else {
    expect.soft(cold.lcpMs, `LCP Startseite (Ziel < ${START_LCP_SLO_MS} ms, docs/07)`).toBeLessThan(START_LCP_SLO_MS);
  }

  const guest = await smoke.person("Smoke Ben", "iPhone 15");
  await test.step("Beitritt per /j/<code> vom zweiten Gerät", async () => {
    await guest.openJoinLink(`/j/${code}`);
    await axeScreen(smoke, guest, "beitreten", testInfo);
    await guest.page.getByRole("button", { name: "Beitreten" }).click();
    await guest.page.waitForURL(`**/lobby/${code}`);
    await expect(guest.lobbyScreen).toBeVisible();
    await expect(host.lobbyPlayers).toHaveCount(2);
    await expect(guest.lobbyPlayers).toHaveCount(2);
  });
  await axeScreen(smoke, host, "lobby-host", testInfo);
  await axeScreen(smoke, guest, "lobby-gast", testInfo);

  const people: [SmokePerson, SmokePerson] = [host, guest];
  const players: GamePlayer[] = people.map((person) => ({
    name: person.name,
    device: person.device,
    host: person === host,
    finished: false,
    picks: 0,
    answers: 0,
    missedAnswers: 0,
    headline: null,
    left: false,
  }));
  const game: GameSection = {
    code,
    played: false,
    skipReason: PLAY ? null : "SMOKE_PLAY=0",
    rounds: ROUNDS,
    questionsPerCategory: QUESTIONS_PER_CATEGORY,
    durationMs: null,
    players,
  };
  try {
    if (PLAY) {
      await test.step(`Spiel: ${ROUNDS} Runde × ${QUESTIONS_PER_CATEGORY} Frage je Kategorie bis zum Spielende`, async () => {
        await host.changeSettings({ Runden: ROUNDS, "Fragen pro Kategorie": QUESTIONS_PER_CATEGORY });
        await expect(guest.page.getByTestId("lobby-summary")).toContainText("1 Runde · 1 Frage je Kat.");
        const begin = Date.now();
        await host.startGame();
        game.played = true;
        // Wer dran ist, wählt die erste Kategorie; geantwortet wird immer mit der ersten Antwort.
        const results = await Promise.all(
          people.map((person) => playUntilGameOver(person, { answer: "first", timeoutMs: GAME_TIMEOUT_MS })),
        );
        game.durationMs = Date.now() - begin;
        for (const [index, person] of people.entries()) {
          const result = results[index];
          const entry = players[index];
          if (!result || !entry) continue;
          await expect(stageOverlay(person.page, "game-over"), `${person.name}: Spielende sichtbar`).toBeVisible();
          entry.finished = result.finished;
          entry.picks = result.picks.length;
          entry.answers = result.answers;
          entry.missedAnswers = result.missedAnswers;
          entry.headline = (await person.page.getByTestId("game-over-headline").textContent())?.trim() ?? null;
          const overlays = countByOverlay(await stageEvents(person.page));
          expect.soft(overlays["overlay-game-over"], `${person.name}: Spielende genau einmal`).toBe(1);
        }
      });
      await axeScreen(smoke, host, "spielende-host", testInfo);
      await axeScreen(smoke, guest, "spielende-gast", testInfo);
      await test.step("beide verlassen die Lobby", async () => {
        for (const person of [guest, host]) {
          await leaveAfterGame(person);
          const entry = players.find((player) => player.name === person.name);
          if (entry) entry.left = true;
        }
      });
    } else {
      await test.step("beide verlassen die Lobby (ohne Spiel)", async () => {
        for (const person of [guest, host]) {
          await person.leaveLobby();
          const entry = players.find((player) => player.name === person.name);
          if (entry) entry.left = true;
        }
      });
    }
  } finally {
    await smoke.record("game", game);
  }
  // Zurück auf der Startseite (nach dem ersten beendeten Spiel ggf. mit „Als App installieren“, docs/10).
  await expect(guest.page.getByLabel("Dein Name")).toBeVisible();
  await axeScreen(smoke, guest, PLAY ? "start-nach-spiel" : "start-nach-lobby", testInfo);
});

test("Startseite: Sicherheits-Header (docs/06) und axe", async ({ smoke, baseURL }, testInfo) => {
  const person = await smoke.person("Start-Check", "Pixel 7", { serviceWorkers: "block" });
  const https = new URL(baseURL ?? "http://invalid").protocol === "https:";
  const first = await person.page.goto("/");
  if (!first) throw new Error("Startseite: keine Antwort");
  const headers = await first.headersArray();
  const evaluation = evaluatePageHeaders(headers, { https });
  const checks: HeaderCheck[] = [
    {
      id: "status",
      label: "Startseite",
      ok: first.status() === 200 && (headerValues(headers, "content-type")[0] ?? "").startsWith("text/html"),
      actual: `${first.status()} ${headerValues(headers, "content-type")[0] ?? ""}`.trim(),
      expected: "200 text/html",
    },
    ...evaluation.checks,
  ];

  // Next versieht seine Skripte mit der Nonce aus der CSP (ADR-008) – jede gesetzte Nonce muss die des Headers sein.
  const scriptNonces = await person.page.evaluate(() =>
    [...document.scripts].map((script) => script.nonce).filter((nonce) => nonce !== ""),
  );
  const foreign = scriptNonces.filter((nonce) => nonce !== evaluation.nonce).length;
  checks.push({
    id: "csp-nonce-scripts",
    label: "CSP: Skripte tragen die Nonce des Headers",
    ok: evaluation.nonce !== null && scriptNonces.length > 0 && foreign === 0,
    actual: `${scriptNonces.length} Skripte mit Nonce, ${foreign} mit fremder Nonce`,
    expected: "mindestens ein Skript, alle mit der Nonce aus dem Header",
  });

  // Eine zweite Anfrage muss eine neue Nonce bekommen – sonst liefert ein Cache (CDN, Proxy) das HTML erneut aus.
  const second = await person.page.goto("/");
  if (!second) throw new Error("Startseite (zweiter Abruf): keine Antwort");
  const secondHeaders = await second.headersArray();
  const secondNonce = cspNonce(parseCsp(headerValues(secondHeaders, "content-security-policy")[0] ?? ""));
  checks.push({
    id: "csp-nonce-fresh",
    label: "CSP: neue Nonce je Anfrage",
    ok: evaluation.nonce !== null && secondNonce !== null && secondNonce !== evaluation.nonce,
    actual:
      secondNonce === null
        ? null
        : secondNonce === evaluation.nonce
          ? "gleiche Nonce zweimal (aus einem Cache?)"
          : "neu",
    expected: "je Anfrage neu (HTML nie aus einem Cache, ADR-008)",
  });

  const info = (name: string) => headerValues(headers, name).join(", ") || null;
  const section: HeadersSection = {
    url: first.url(),
    status: first.status(),
    checks,
    info: {
      cspHeaders: String(evaluation.cspHeaders),
      "x-robots-tag": info("x-robots-tag"),
      "cf-cache-status": info("cf-cache-status"),
      server: info("server"),
    },
  };
  await smoke.record("headers", section);
  for (const check of checks) {
    expect
      .soft(check.ok, `${check.label}: erwartet ${check.expected}, gefunden ${check.actual ?? "(fehlt)"}`)
      .toBe(true);
  }

  // axe auf der bedienbaren Startseite – unabhängig davon, ob Sessions/Lobbys angelegt werden können.
  await person.waitForHydration(person.page.getByLabel("Dein Name"));
  await axeScreen(smoke, person, "start", testInfo);
});

test("Installierbarkeit: Manifest, Service Worker, Chromium ohne Einwände (docs/10)", async ({ smoke }) => {
  const person = await smoke.person("PWA-Check", "Pixel 7");
  await person.openStart();
  const origin = new URL(person.page.url()).origin;
  const report: PwaReport = {
    manifestUrl: "",
    manifestErrors: [],
    installabilityErrors: [],
    manifest: {
      url: "",
      status: 0,
      contentType: "",
      name: null,
      shortName: null,
      startUrl: null,
      display: null,
      icons: [],
    },
    serviceWorker: { scriptUrl: "", scope: "", state: "", controlling: false },
  };
  try {
    report.serviceWorker = await softStep("Service Worker aktiv und steuert die Seite", report.serviceWorker, () =>
      waitForActiveServiceWorker(person.page),
    );
    const chromium = await softStep(
      "Chromium: Manifest und Installierbarkeit (CDP)",
      { manifestUrl: "", manifestErrors: ["nicht geprüft"], installabilityErrors: ["nicht geprüft"] },
      () => chromiumInstallability(person.page),
    );
    Object.assign(report, chromium);
    report.manifest = await softStep("Manifest und Icons erreichbar", report.manifest, () =>
      fetchManifest(person.page, report.manifestUrl || `${origin}/manifest.webmanifest`),
    );
  } finally {
    await smoke.record("pwa", report);
  }

  expect.soft(report.serviceWorker.state, "Service Worker aktiv").toBe("activated");
  expect.soft(report.serviceWorker.scriptUrl, "Service-Worker-Skript").toBe(`${origin}/sw.js`);
  expect.soft(report.serviceWorker.scope, "Service-Worker-Scope").toBe(`${origin}/`);
  expect.soft(report.manifestUrl, "Manifest laut Chromium").toBe(`${origin}/manifest.webmanifest`);
  expect.soft(report.manifestErrors, "Manifest-Meldungen von Chromium").toEqual([]);
  expect.soft(report.installabilityErrors, "Einwände gegen die Installierbarkeit").toEqual([]);
  expect.soft(report.manifest.status, "Manifest erreichbar").toBe(200);
  expect.soft(report.manifest.contentType, "Manifest-Typ").toContain("application/manifest+json");
  expect.soft(report.manifest.display, "display").toBe("standalone");
  expect.soft(report.manifest.icons.length, "Icons im Manifest").toBeGreaterThan(0);
  for (const icon of report.manifest.icons) {
    expect.soft(`${icon.status} ${icon.contentType}`, `Icon ${icon.src}`).toBe("200 image/png");
  }
});
