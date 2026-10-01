/**
 * Abnahme-Prüfungen je Screen bzw. Spielphase (docs/11 Szenario 9 „A11y-Check (axe) in jeder Phase“, docs/09 §12
 * und die automatisierbaren Punkte der Checkliste §13):
 *
 * - axe (`@axe-core/playwright`, WCAG 2.0–2.2 A/AA + Best Practices): keine ernsten oder kritischen Befunde,
 * - kein horizontales Scrollen (Dokument und jeder Scroll-Container),
 * - höchstens eine orange Hauptaktion (`Button`/`ButtonLink` mit `variant="primary"`) – bei offenem Modal zählt
 *   nur die oberste Ebene,
 * - keine Emojis im sichtbaren Text, keine beliebigen Tailwind-Werte (`[…]`) oder Hex-Farben in Klassen,
 * - Fragen: Fragetext und Antworten passen (nichts abgeschnitten, nichts ragt über den Rand); jede Antwort hat in
 *   allen Zuständen dieselbe Zeilenzahl, die letzte steht auf der Bühne vollständig über dem Spielerstreifen.
 *
 * Befunde werden per `expect.soft` gemeldet (ein Lauf zeigt alle Probleme) und als JSON an den Test gehängt;
 * dazu ein Screenshot je Screen und Viewport (`<name>-<breite>x<höhe>.png`, siehe {@link screenshotDir}).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

/** Regelsätze für axe: WCAG 2.0–2.2 A/AA und axe-Best-Practices (docs/09 §12: WCAG 2.2 AA). */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] as const;

/** Diese Auswirkungen lassen den Test scheitern (docs/11: „keine ernsten Befunde“). */
export const BLOCKING_IMPACTS: readonly string[] = ["serious", "critical"];

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/**
 * Ablage der Screenshots: `E2E_SCREENSHOT_DIR`, sonst lokal `docs/screenshots/w3` (docs/ ist das lokale
 * Spezifikations-Repo, DoD Phase 3), sonst (z. B. CI ohne docs/) neben den Test-Artefakten.
 */
export function screenshotDir(testInfo: TestInfo): string {
  const configured = process.env.E2E_SCREENSHOT_DIR;
  if (configured) return resolve(configured);
  if (existsSync(join(REPO_ROOT, "docs"))) return join(REPO_ROOT, "docs", "screenshots", "w3");
  return join(testInfo.project.outputDir, "screenshots");
}

export interface AxeFinding {
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

export interface AxeReport {
  /** Verstöße aller Schweregrade (blockierend sind nur {@link BLOCKING_IMPACTS}) */
  violations: AxeFinding[];
  /** von axe nicht entscheidbar („needs review“) – nur zur Information */
  incomplete: AxeFinding[];
  /** Anzahl bestandener Regeln (Beleg, dass axe wirklich geprüft hat) */
  passes: number;
}

function findingsOf(entries: AxeResults["violations"]): AxeFinding[] {
  return entries.map((entry) => ({
    id: entry.id,
    impact: entry.impact ?? "unbekannt",
    help: entry.help,
    targets: entry.nodes.slice(0, 5).map((node) => node.target.join(" ")),
  }));
}

/** axe über die ganze Seite. */
export async function axeReport(page: Page): Promise<AxeReport> {
  const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
  return {
    violations: findingsOf(results.violations),
    incomplete: findingsOf(results.incomplete),
    passes: results.passes.length,
  };
}

/**
 * Wartet, bis Ein-/Ausblendungen ruhen (sonst misst axe Kontraste mitten in einer Überblendung): keine
 * endliche CSS-/WAAPI-Animation läuft mehr (Timer, Lade- und Warte-Indikatoren laufen bewusst weiter) und die
 * Inline-Stile von motion (opacity/transform) ändern sich nicht mehr. Höchstens `timeoutMs`.
 */
export async function waitForStill(page: Page, timeoutMs = 2_000): Promise<boolean> {
  return page.evaluate(async (limit) => {
    const endless = /^(timer-|spin$|pulse$)/;
    const busy = () =>
      document.getAnimations().some((animation) => {
        if (animation.playState !== "running") return false;
        if (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) {
          if (endless.test(animation.animationName)) return false;
        }
        const end = animation.effect?.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      });
    const signature = () =>
      [...document.querySelectorAll<HTMLElement>("[style]")]
        .map((element) => `${element.style.opacity}|${element.style.transform}|${element.style.visibility}`)
        .join(";");
    const deadline = performance.now() + limit;
    let last = signature();
    while (performance.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 120));
      const next = signature();
      if (next === last && !busy()) return true;
      last = next;
    }
    return false;
  }, timeoutMs);
}

export interface LayoutReport {
  /** Viewport-Breite (CSS-Pixel) */
  width: number;
  /** horizontal scrollbare Bereiche: Dokument oder Scroll-Container mit scrollWidth > clientWidth */
  horizontalScroll: string[];
  /** sichtbare, nicht inerte orange Hauptaktionen der obersten Ebene */
  primaryActions: string[];
  /** Emojis im sichtbaren Text */
  emojis: string[];
  /** Klassen mit beliebigen Werten (`[…]`) oder Hex-Farben */
  arbitraryClasses: string[];
}

/** Layout- und Design-Regeln im gerenderten DOM (docs/09 §1 Regeln 5, 8, 9; §4; §13). */
export async function layoutReport(page: Page, allowHorizontalScroll: readonly string[] = []): Promise<LayoutReport> {
  return page.evaluate((allowed) => {
    const describe = (element: Element) => {
      const testId = element.closest("[data-testid]")?.getAttribute("data-testid");
      const classes = (element.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}${testId ? ` (in ${testId})` : ""}`;
    };
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const root = document.documentElement;
    const horizontalScroll: string[] = [];
    if (root.scrollWidth > root.clientWidth + 1) {
      horizontalScroll.push(`Dokument: scrollWidth ${root.scrollWidth} > ${root.clientWidth}`);
    }
    for (const element of document.body.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const overflowX = getComputedStyle(element).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") continue;
      if (element.scrollWidth <= element.clientWidth + 1) continue;
      if (allowed.some((selector) => element.matches(selector))) continue;
      horizontalScroll.push(`${describe(element)}: scrollWidth ${element.scrollWidth} > ${element.clientWidth}`);
    }

    // Oberste Ebene: offenes Modal (Sheet/Dialog, aria-modal) – sonst die ganze Seite. Inerte (ausblendende)
    // Overlays zählen nicht.
    const modals = [...document.querySelectorAll('[aria-modal="true"]')].filter(visible);
    const scope = modals.at(-1) ?? document.body;
    const primaryActions = [...scope.querySelectorAll("button.bg-primary, a.bg-primary")]
      .filter((element) => visible(element) && element.closest("[inert]") === null)
      .map((element) => (element.textContent ?? "").trim());

    const emojis = [...document.body.innerText.matchAll(/\p{Extended_Pictographic}/gu)].map((match) => match[0]);
    const arbitraryClasses = new Set<string>();
    for (const element of document.querySelectorAll("[class]")) {
      for (const token of (element.getAttribute("class") ?? "").split(/\s+/)) {
        if (token.includes("[") || /#[0-9a-f]{3,8}\b/i.test(token)) arbitraryClasses.add(token);
      }
    }
    return {
      width: window.innerWidth,
      horizontalScroll,
      primaryActions,
      emojis,
      arbitraryClasses: [...arbitraryClasses],
    };
  }, allowHorizontalScroll);
}

export interface TextFit {
  /** Zeichen im Fragetext bzw. in der längsten Antwort */
  promptLength: number;
  longestAnswer: number;
  /** Zeilen des Fragetexts und je Antwort (docs/09 §5: Antworttext bis 2 Zeilen) samt Button-Höhe (≥ 64) */
  promptLines: number;
  answers: { text: string; lines: number; height: number }[];
  /** Elemente, deren Text abgeschnitten ist oder über den Rand ragt */
  clipped: string[];
  /** letzte Antwort vollständig im Viewport (ohne Scrollen sichtbar) – nur zur Information */
  answersInViewport: boolean;
}

/**
 * Passt die (längste) Frage? Fragetext und Antworttexte dürfen weder in ihrem Kasten noch in der Karte
 * abgeschnitten sein und nicht über den Rand ragen (docs/09 §13); dazu die Zeilenzahl je Text.
 */
export async function questionTextFit(overlay: Locator): Promise<TextFit> {
  return overlay.evaluate((root) => {
    const clipped: string[] = [];
    const lines = (element: Element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return Number.isFinite(lineHeight) && lineHeight > 0
        ? Math.round(element.getBoundingClientRect().height / lineHeight)
        : 0;
    };
    const check = (element: Element, label: string) => {
      const box = element.getBoundingClientRect();
      if (element.scrollWidth > element.clientWidth + 1) {
        clipped.push(`${label}: scrollWidth ${element.scrollWidth} > ${element.clientWidth}`);
      }
      if (element.scrollHeight > element.clientHeight + 1 && getComputedStyle(element).overflowY !== "visible") {
        clipped.push(`${label}: scrollHeight ${element.scrollHeight} > ${element.clientHeight}`);
      }
      if (box.right > window.innerWidth + 1 || box.left < -1) {
        clipped.push(`${label}: ragt über den Rand (${box.left}–${box.right})`);
      }
      for (const ancestor of [element.parentElement, element.parentElement?.parentElement]) {
        if (!ancestor || getComputedStyle(ancestor).overflow === "visible") continue;
        const outer = ancestor.getBoundingClientRect();
        if (box.right > outer.right + 1 || box.bottom > outer.bottom + 1) {
          clipped.push(`${label}: von ${ancestor.tagName.toLowerCase()} abgeschnitten`);
        }
      }
    };
    const prompt = root.querySelector("p");
    if (prompt) check(prompt, "Fragetext");
    const answers = [...root.querySelectorAll('[data-testid^="answer-"]')];
    let longestAnswer = 0;
    const answerTexts: { text: string; lines: number; height: number }[] = [];
    for (const [index, answer] of answers.entries()) {
      const text = answer.querySelector("span.flex-1");
      if (!text) continue;
      const own = [...text.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("");
      longestAnswer = Math.max(longestAnswer, own.length);
      answerTexts.push({ text: own, lines: lines(text), height: Math.round(answer.getBoundingClientRect().height) });
      check(text, `Antwort ${index + 1}`);
    }
    const last = answers.at(-1)?.getBoundingClientRect();
    return {
      promptLength: (prompt?.textContent ?? "").length,
      longestAnswer,
      promptLines: prompt ? lines(prompt) : 0,
      answers: answerTexts,
      clipped,
      answersInViewport: last !== undefined && last.bottom <= window.innerHeight,
    };
  });
}

export interface AnswerLines {
  /** eigener Text der Antwort (ohne Screenreader-Zusätze) */
  text: string;
  /** `data-state` in der Auflösung, sonst idle/gesperrt nach `aria-disabled` */
  state: string;
  lines: number;
}

export interface AnswerGeometry {
  /** `data-layout` des Spielscreens: `stage` (Bühne zwischen festen Leisten) oder `flow` (niedriger Viewport) */
  layout: string | null;
  /** Frage mit Bild (Flagge) – dann darf die letzte Antwort unter den Streifen rücken (Bühne scrollt) */
  media: boolean;
  answers: AnswerLines[];
  /** Unterkante der letzten Antwort (D) und Oberkante des Spielerstreifens im Viewport */
  lastAnswerBottom: number;
  stripTop: number | null;
}

/** Antworten der aktuellen Frage bzw. Auflösung: Zeilen je Antwort und Lage der letzten Antwort (D). */
export async function answerGeometry(page: Page): Promise<AnswerGeometry | null> {
  return page.evaluate(() => {
    const overlay = document.querySelector(
      '[data-testid="overlay-question"]:not([data-exiting]), [data-testid="overlay-answer-reveal"]:not([data-exiting])',
    );
    if (!overlay) return null;
    const buttons = [...overlay.querySelectorAll<HTMLElement>('[data-testid^="answer-"]')];
    const answers = buttons.flatMap((button) => {
      const text = button.querySelector("span.flex-1");
      if (!text) return [];
      const own = [...text.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("");
      const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
      const state =
        button.getAttribute("data-state") ?? (button.getAttribute("aria-disabled") === "true" ? "gesperrt" : "idle");
      return [{ text: own, state, lines: Math.round(text.getBoundingClientRect().height / lineHeight) }];
    });
    const strip = document.querySelector('[data-testid="player-strip"]');
    return {
      layout: document.querySelector('[data-testid="game-screen"]')?.getAttribute("data-layout") ?? null,
      media: overlay.querySelector("img") !== null,
      answers,
      lastAnswerBottom: buttons.at(-1)?.getBoundingClientRect().bottom ?? 0,
      stripTop: strip ? strip.getBoundingClientRect().top : null,
    };
  });
}

/**
 * Zeilen je Antworttext und Viewport, wie zuerst gemessen (je Worker): Derselbe Text muss in jedem Zustand gleich
 * viele Zeilen haben – idle, eingeloggt, gedimmt, richtig, falsch (AnswerButton mit festem Icon-Slot).
 */
const answerLinesSeen = new Map<string, { lines: number; state: string; screen: string }>();

/**
 * Frage und Auflösung (ADR-034, AnswerButton): gleiche Zeilenzahl je Antwort in allen Zuständen und – auf der Bühne
 * ohne Bildfrage – die letzte Antwort vollständig über dem Spielerstreifen (Frage und Auflösung stehen gleich).
 */
function checkAnswers(geometry: AnswerGeometry | null, name: string, size: string): void {
  if (!geometry) return;
  for (const answer of geometry.answers) {
    const key = `${size}|${answer.text}`;
    const seen = answerLinesSeen.get(key);
    if (!seen) {
      answerLinesSeen.set(key, { lines: answer.lines, state: answer.state, screen: name });
      continue;
    }
    expect
      .soft(
        answer.lines,
        `${name} (${size}): „${answer.text}“ (${answer.state}) – Zeilen wie in ${seen.screen} (${seen.state})`,
      )
      .toBe(seen.lines);
  }
  if (geometry.layout === "stage" && !geometry.media && geometry.stripTop !== null) {
    expect
      .soft(geometry.lastAnswerBottom, `${name} (${size}): letzte Antwort vollständig über dem Spielerstreifen`)
      .toBeLessThanOrEqual(geometry.stripTop + 0.5);
  }
}

export interface ScreenCheckOptions {
  /** Teil-Locator, der während der Prüfung sichtbar bleiben muss (z. B. das Overlay der Phase) */
  stays?: Locator;
  /** gewollt horizontal scrollbare Bereiche (CSS-Selektoren, docs/09 §4: Tafel ab 5 Personen) */
  allowHorizontalScroll?: readonly string[];
  /** Screenshot speichern (Standard: ja) */
  screenshot?: boolean;
}

export interface ScreenResult {
  name: string;
  axe: AxeReport;
  layout: LayoutReport;
  /** Frage/Auflösung: Zeilen je Antwort und Lage der letzten Antwort (sonst `null`) */
  answers: AnswerGeometry | null;
  /** Bewegungen kamen vor der Prüfung zur Ruhe */
  settled: boolean;
  axeMs: number;
  /** Dauer der ganzen Prüfung (Warten auf Ruhe, axe, Layout, Screenshot) */
  totalMs: number;
}

/**
 * Prüft den aktuellen Screen (axe + Layout/Design) und speichert einen Screenshot `<name>-<B>x<H>.png`.
 * Befunde → `expect.soft`, Details → Anhang `screen-<name>-<B>x<H>.json`.
 */
export async function checkScreen(
  page: Page,
  name: string,
  testInfo: TestInfo,
  options: ScreenCheckOptions = {},
): Promise<ScreenResult> {
  const begin = Date.now();
  const settled = await waitForStill(page);
  const started = Date.now();
  const axe = await axeReport(page);
  const axeMs = Date.now() - started;
  const layout = await layoutReport(page, options.allowHorizontalScroll);
  const answers = await answerGeometry(page);
  const viewport = page.viewportSize();
  const size = viewport ? `${viewport.width}x${viewport.height}` : "unbekannt";
  if (options.screenshot !== false) {
    const dir = screenshotDir(testInfo);
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}-${size}.png`) });
  }
  // Die Prüfung muss die Phase selbst erfasst haben – nicht schon den Übergang zur nächsten.
  const phaseStayed = options.stays === undefined || (await options.stays.count()) === 1;
  const result: ScreenResult = { name, axe, layout, answers, settled, axeMs, totalMs: Date.now() - begin };
  await testInfo.attach(`screen-${name}-${size}.json`, {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(phaseStayed, `${name} (${size}): Phase lief während der Prüfung weiter (${result.totalMs} ms)`).toBe(true);
  const blocking = axe.violations.filter((finding) => BLOCKING_IMPACTS.includes(finding.impact));
  expect.soft(axe.passes, `${name} (${size}): axe hat Regeln geprüft`).toBeGreaterThan(0);
  expect.soft(blocking, `${name} (${size}): ernste/kritische axe-Befunde`).toEqual([]);
  expect.soft(layout.horizontalScroll, `${name} (${size}): horizontales Scrollen`).toEqual([]);
  expect
    .soft(layout.primaryActions.length, `${name} (${size}): orange Hauptaktionen ${layout.primaryActions.join(", ")}`)
    .toBeLessThanOrEqual(1);
  expect.soft(layout.emojis, `${name} (${size}): Emojis`).toEqual([]);
  expect.soft(layout.arbitraryClasses, `${name} (${size}): beliebige Werte/Hex in Klassen`).toEqual([]);
  checkAnswers(answers, name, size);
  return result;
}
