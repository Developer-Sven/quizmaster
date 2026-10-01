import { resolveRobots as robotsTxt } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import { resolveRobots as robotsMetaContent } from "next/dist/lib/metadata/resolvers/resolve-basics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearWebEnvCache, WEB_ENV_KEYS } from "../env";
import { CRAWL_DISALLOWED_PATHS, robotsFile, rootMetadata } from "../lib/server/site-metadata";
import { testEnvSource } from "../lib/server/test-support";
import manifest from "./manifest";
import robots from "./robots";

/** `connection()` braucht einen Next-Request – im Test genügt die Reihenfolge: erst warten, dann Env lesen. */
const connection = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection,
}));

/** Env des Prozesses wie zur Laufzeit (SEARCH_INDEXING `undefined` = nicht gesetzt). */
function stubRuntimeEnv(searchIndexing: string | undefined): void {
  for (const key of WEB_ENV_KEYS) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(testEnvSource({ SEARCH_INDEXING: searchIndexing }))) {
    vi.stubEnv(key, value);
  }
  clearWebEnvCache();
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearWebEnvCache();
  connection.mockReset();
  connection.mockImplementation(async () => {});
});

const PRIVATE_ROBOTS_TXT = "User-Agent: *\nDisallow: /\n\n";

const PUBLIC_ROBOTS_TXT = [
  "User-Agent: *",
  "Allow: /",
  "Disallow: /lobby/",
  "Disallow: /j/",
  "Disallow: /api/",
  "Disallow: /dev/",
  "Disallow: /offline",
  "",
  "",
].join("\n");

describe("robots.txt je nach SEARCH_INDEXING (ADR-030)", () => {
  it("sperrt bei false alles (Disallow: /)", () => {
    expect(robotsTxt(robotsFile({ searchIndexing: false }))).toBe(PRIVATE_ROBOTS_TXT);
  });

  it("gibt bei true die Seite frei – ohne Lobbys, Kurzlinks, API, Entwicklungs- und Offline-Seite", () => {
    expect(robotsTxt(robotsFile({ searchIndexing: true }))).toBe(PUBLIC_ROBOTS_TXT);
    expect(CRAWL_DISALLOWED_PATHS).toEqual(["/lobby/", "/j/", "/api/", "/dev/", "/offline"]);
  });

  it("liest den Schalter zur Laufzeit – Standard (nicht gesetzt) und false sperren, true gibt frei", async () => {
    for (const [value, expected] of [
      [undefined, PRIVATE_ROBOTS_TXT],
      ["false", PRIVATE_ROBOTS_TXT],
      ["true", PUBLIC_ROBOTS_TXT],
    ] as const) {
      stubRuntimeEnv(value);
      expect(robotsTxt(await robots()), `SEARCH_INDEXING=${value}`).toBe(expected);
    }
    expect(connection).toHaveBeenCalledTimes(3);
  });

  it("wartet erst auf den Request: beim Build (ohne Env) bricht connection() ab, bevor die Env gelesen wird", async () => {
    for (const key of WEB_ENV_KEYS) vi.stubEnv(key, undefined);
    clearWebEnvCache();
    const bailout = new Error("dynamic usage");
    connection.mockRejectedValueOnce(bailout);
    await expect(robots()).rejects.toBe(bailout);
  });
});

describe("Metadaten des Wurzel-Layouts", () => {
  it("setzt robots-Meta noindex, nofollow, solange SEARCH_INDEXING aus ist – sonst kein robots-Tag", () => {
    const hidden = rootMetadata({ searchIndexing: false });
    expect(hidden.robots).toEqual({ index: false, follow: false });
    expect(robotsMetaContent(hidden.robots)?.basic).toBe("noindex, nofollow");
    expect(rootMetadata({ searchIndexing: true })).not.toHaveProperty("robots");
  });

  it("heißt „quizmaster“, Unterseiten „Regeln – quizmaster“, Beschreibung wie im Manifest", () => {
    const metadata = rootMetadata({ searchIndexing: false });
    expect(metadata.title).toEqual({ default: "quizmaster", template: "%s – quizmaster" });
    expect(metadata.description).toBe(manifest().description);
    expect(metadata.description).toBe("Quiz-Duelle live mit Freund:innen – ohne Anmeldung.");
    expect(metadata.applicationName).toBe("quizmaster");
    expect(metadata.appleWebApp).toEqual({ capable: true, title: "quizmaster", statusBarStyle: "black-translucent" });
  });
});
