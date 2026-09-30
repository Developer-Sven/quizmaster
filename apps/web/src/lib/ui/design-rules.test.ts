import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Automatisierte Design-Abnahme (docs/09 §13) über apps/web/src: nur Tokens (keine beliebigen
 * Tailwind-Werte, keine Hex-Farben in UI-Code), keine Emojis, kein Lila/Violett/Indigo, keine
 * Verläufe, keine Unschärfe, keine Glows, keine Farbmischung, Icons nur über lib/ui/icons.
 */
const SRC = fileURLToPath(new URL("../../", import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(SRC)
  .filter((path) => /\.(ts|tsx|css)$/.test(path))
  .map((path) => ({ path: relative(SRC, path).split(sep).join("/"), source: readFileSync(path, "utf8") }));

/** Next-Metadaten-Bilder (Icons, OG) erzeugen Grafiken, keine Oberfläche. */
const IMAGE_ROUTES = /(^|\/)(icon|apple-icon|opengraph-image|twitter-image)\.tsx$/;

/** UI-Code: TSX sowie components/ und lib/ui/ – ohne Tests und ohne den Token-Spiegel. */
function isUiCode(path: string): boolean {
  if (path.endsWith(".test.ts") || path === "lib/ui/tokens.ts" || IMAGE_ROUTES.test(path)) return false;
  return path.endsWith(".tsx") || path.startsWith("components/") || path.startsWith("lib/ui/");
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Inhalte von String- und Template-Literalen (dort stehen Klassen). */
function stringLiterals(source: string): string[] {
  const literals = withoutComments(source).match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  return literals.map((literal) => literal.slice(1, -1));
}

function classTokens(source: string): string[] {
  return stringLiterals(source).flatMap((literal) => literal.split(/\s+/).filter(Boolean));
}

function violations(check: (path: string, source: string) => string[]): string[] {
  return files.flatMap(({ path, source }) => check(path, source).map((finding) => `${path}: ${finding}`));
}

/** Beliebige Werte (`w-[13px]`, `data-[x]:…`), Eigenschaften (`[mask-type:x]`) und Varianten (`[&>svg]:…`). */
const ARBITRARY = [
  /^(?:[\w-]+:)*!?-?[a-z][\w-]*-\[[^\]]+\]/i,
  /^(?:[\w-]+:)*!?\[[a-z-]+:[^\]]+\]$/i,
  /^\[[^\]]*&[^\]]*\]:/,
];
const HEX_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i;
const FORBIDDEN_HUE = /(?:^|[:-])(?:purple|violet|indigo|fuchsia|magenta|pink)(?:-\d{2,3})?(?:\/\d+)?$/i;
const GRADIENT = /(?:^|:)(?:bg-(?:gradient|linear|radial|conic)|from|via|to)-/;
const BLUR = /(?:^|:)(?:backdrop-)?blur(?:-|$)/;
const GLOW = /(?:^|:)(?:drop-shadow|text-shadow|inset-shadow)(?:-|$)|(?:^|:)shadow-(?!level-2$|none$)/;
const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}/u;
const TYPOGRAPHIC = new Set(["©", "®", "™"]);

describe("Design-Abnahme docs/09 §13", () => {
  it("findet UI-Dateien", () => {
    expect(files.some(({ path }) => path === "app/globals.css")).toBe(true);
    expect(files.filter(({ path }) => path.startsWith("components/ui/")).length).toBeGreaterThanOrEqual(25);
  });

  it("nutzt in UI-Code keine beliebigen Tailwind-Werte ([…])", () => {
    const found = violations((path, source) =>
      isUiCode(path) && !path.endsWith(".css")
        ? classTokens(source).filter((token) => ARBITRARY.some((rule) => rule.test(token)))
        : [],
    );
    expect(found).toEqual([]);
  });

  it("nutzt Hex-Farben nur in globals.css und im Token-Spiegel", () => {
    const found = violations((path, source) =>
      isUiCode(path) && !path.endsWith(".css")
        ? stringLiterals(source).filter((literal) => HEX_COLOR.test(literal))
        : [],
    );
    expect(found).toEqual([]);
  });

  it("enthält keine Emojis", () => {
    const found = violations((_path, source) =>
      [...source].filter((char) => EMOJI.test(char) && !TYPOGRAPHIC.has(char)).map((char) => `Emoji ${char}`),
    );
    expect(found).toEqual([]);
  });

  it("hat kein Lila/Violett/Indigo, keine Verläufe, keine Unschärfe und keine Glows in Klassen", () => {
    const found = violations((path, source) =>
      isUiCode(path) && !path.endsWith(".css")
        ? classTokens(source).filter((token) => [FORBIDDEN_HUE, GRADIENT, BLUR, GLOW].some((rule) => rule.test(token)))
        : [],
    );
    expect(found).toEqual([]);
  });

  it("hat keine Farbmischung, Verläufe, Unschärfe oder Glows in CSS", () => {
    const forbiddenCss =
      /color-mix\(|gradient\(|blur\(|backdrop-filter|drop-shadow\(|text-shadow\s*:|\b(?:purple|violet|indigo|fuchsia|magenta)\b/i;
    const found = violations((path, source) => {
      if (path.endsWith(".test.ts")) return [];
      const code = path.endsWith(".css") ? withoutComments(source) : stringLiterals(source).join("\n");
      const match = forbiddenCss.exec(code);
      return match ? [match[0]] : [];
    });
    expect(found).toEqual([]);
  });

  it("importiert Icons nur über lib/ui/icons (Kategorie-Icons: lib/ui/category)", () => {
    const allowed = new Set(["lib/ui/icons.ts", "lib/ui/category.ts"]);
    const found = violations((path, source) =>
      !allowed.has(path) && /from\s+["']lucide-react["']/.test(source) ? ["direkter lucide-react-Import"] : [],
    );
    expect(found).toEqual([]);
  });
});
