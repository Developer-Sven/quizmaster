/**
 * Browser-Monitor (docs/11, Smoke-Test gegen Produktion): Meldungen aus dem iframe von Cloudflare Turnstile sind
 * keine App-Fehler – CSP-Verstöße zählen aber immer, auch von dort.
 */
import type { BrowserContext, ConsoleMessage, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { BrowserMonitor } from "../tests/support/monitor.ts";

type Listener = (value: unknown) => void;

/** Kontext mit einer Seite, deren `console`-Ereignisse der Test auslöst. */
async function watchedPage(monitor: BrowserMonitor): Promise<(type: string, text: string, url: string) => void> {
  const pageListeners = new Map<string, Listener>();
  const page = { on: (event: string, listener: Listener) => pageListeners.set(event, listener) };
  let onPage: Listener = () => undefined;
  const context = {
    exposeBinding: async () => undefined,
    addInitScript: async () => undefined,
    on: (event: string, listener: Listener) => {
      if (event === "page") onPage = listener;
    },
  };
  await monitor.watchContext(context as unknown as BrowserContext, "Mia");
  onPage(page as unknown as Page);
  return (type, text, url) => {
    const message = { type: () => type, text: () => text, location: () => ({ url, lineNumber: 1, columnNumber: 1 }) };
    pageListeners.get("console")?.(message as unknown as ConsoleMessage);
  };
}

const TURNSTILE = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/x/dark/fbE/new";

describe("Browser-Monitor", () => {
  it("Turnstile-Meldungen im eigenen iframe sind keine Probleme, CSP-Verstöße schon", async () => {
    const monitor = new BrowserMonitor();
    const log = await watchedPage(monitor);
    log("error", "%c%d font-size:0;color:transparent NaN", TURNSTILE);
    expect(monitor.problems).toEqual([]);
    expect(monitor.console).toHaveLength(1);
    log("error", "Refused to load the script because it violates the Content Security Policy", TURNSTILE);
    expect(monitor.problems.map((problem) => problem.kind)).toEqual(["csp"]);
  });

  it("App-Fehler zählen weiter", async () => {
    const monitor = new BrowserMonitor();
    const log = await watchedPage(monitor);
    log("error", "TypeError: x is undefined", "https://quizmaster.dev-sven.de/_next/static/chunks/app.js");
    expect(monitor.problems.map((problem) => problem.kind)).toEqual(["console"]);
  });
});
