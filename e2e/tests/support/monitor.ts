/**
 * Browser-Überwachung je Test (docs/11 E2E, docs/06 CSP): sammelt CSP-Verstöße (Konsole + Event
 * `securitypolicyviolation`), unbehandelte Fehler (`pageerror`), Abstürze und unerwartete Konsolenfehler aller
 * Seiten eines Tests. Das Fixture prüft am Testende, dass die Liste leer ist, und hängt das Konsolenprotokoll an.
 */
import type { BrowserContext, ConsoleMessage, Page } from "@playwright/test";

export type BrowserProblemKind = "csp" | "pageerror" | "console" | "crash";

export interface BrowserProblem {
  kind: BrowserProblemKind;
  /** Name der Person/Seite, z. B. „Mia“ */
  page: string;
  text: string;
}

/** Vom Browser selbst gemeldete CSP-Verstöße (Chromium: „Refused to … Content Security Policy …“). */
const CSP_PATTERN = /Content Security Policy|Refused to (load|execute|apply|connect|frame|create|evaluate)/i;

interface BenignConsoleError {
  text: RegExp;
  /** optional: nur für diese Ressource/Seite */
  url?: RegExp;
}

/** Absichtlich unbekannter Pfad für die 404-Seite (Szenario 9). */
export const UNKNOWN_PAGE_PATH = "/e2e-unbekannte-seite";

/**
 * Konsolenfehler, die keine App-Fehler sind: absichtliche 404-Seiten (ungültiger Code in der URL, unbekannter
 * Pfad {@link UNKNOWN_PAGE_PATH}) und der Hinweis des Browsers, wenn eine Seite neu lädt, während ihr
 * WebSocket noch verbindet.
 */
const BENIGN_CONSOLE_ERRORS: readonly BenignConsoleError[] = [
  { text: /the server responded with a status of 404/, url: /\/((j|lobby)\/[^/?#]+|e2e-unbekannte-seite)$/ },
  { text: /WebSocket is closed before the connection is established/ },
];

/** Name der Brücke zwischen Seite und Test (Init-Skript → `exposeBinding`). */
const CSP_BINDING = "__qmReportCspViolation";

export class BrowserMonitor {
  readonly problems: BrowserProblem[] = [];
  /** Alle Konsolenmeldungen (für den Anhang am Test). */
  readonly console: string[] = [];

  /**
   * Überwacht alle Seiten eines Kontexts (vor dem Öffnen der ersten Seite aufrufen). `expectedErrors`: Konsolen-
   * fehler, die der Test für diese Person absichtlich herbeiführt (z. B. abgebrochene Downloads) – sie landen
   * im Protokoll, zählen aber nicht als Problem.
   */
  async watchContext(context: BrowserContext, label: string, expectedErrors: readonly RegExp[] = []): Promise<void> {
    await context.exposeBinding(CSP_BINDING, (_source, detail: unknown) => {
      this.problems.push({ kind: "csp", page: label, text: `securitypolicyviolation: ${String(detail)}` });
    });
    await context.addInitScript((binding: string) => {
      document.addEventListener("securitypolicyviolation", (event) => {
        const report = (window as unknown as Record<string, ((detail: string) => void) | undefined>)[binding];
        report?.(`${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`);
      });
    }, CSP_BINDING);
    context.on("page", (page) => this.watchPage(page, label, expectedErrors));
  }

  private watchPage(page: Page, label: string, expectedErrors: readonly RegExp[]): void {
    page.on("console", (message) => this.onConsole(message, label, expectedErrors));
    page.on("pageerror", (error) => {
      this.problems.push({ kind: "pageerror", page: label, text: `${error.name}: ${error.message}` });
    });
    page.on("crash", () => this.problems.push({ kind: "crash", page: label, text: "Seite abgestürzt" }));
  }

  private onConsole(message: ConsoleMessage, label: string, expectedErrors: readonly RegExp[]): void {
    const text = message.text();
    const url = message.location().url;
    this.console.push(`[${label}] ${message.type()}: ${text}${url ? ` (${url})` : ""}`);
    if (CSP_PATTERN.test(text)) {
      this.problems.push({ kind: "csp", page: label, text });
      return;
    }
    if (message.type() !== "error") return;
    const benign =
      BENIGN_CONSOLE_ERRORS.some((rule) => rule.text.test(text) && (rule.url === undefined || rule.url.test(url))) ||
      expectedErrors.some((pattern) => pattern.test(text));
    if (!benign) this.problems.push({ kind: "console", page: label, text: `${text}${url ? ` (${url})` : ""}` });
  }
}
