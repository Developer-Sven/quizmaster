import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYER_COLOR_HEX, PLAYER_COLORS } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { DURATION_MS, EASING, QR_CODE_COLORS, THEME_COLOR } from "./tokens";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** Wert einer Custom Property aus globals.css (erste Deklaration, ohne Kommentar). */
function token(name: string): string {
  const match = new RegExp(`${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}:\\s*([^;]+);`).exec(css);
  if (!match?.[1]) throw new Error(`Token ${name} fehlt in globals.css`);
  return match[1].trim().toLowerCase();
}

/** Soll-Werte exakt aus docs/09 §2. */
const SPEC_COLORS = {
  "--color-bg": "#0B1426",
  "--color-surface-1": "#121F38",
  "--color-surface-2": "#1A2A4A",
  "--color-surface-3": "#22365C",
  "--color-line": "#2B4170",
  "--color-line-strong": "#5D76A8",
  "--color-text": "#F4F7FC",
  "--color-text-2": "#A9B6CE",
  "--color-text-3": "#7082A3",
  "--color-primary": "#FF8A1F",
  "--color-primary-hover": "#FF9E47",
  "--color-primary-press": "#E87812",
  "--color-on-primary": "#1B1004",
  "--color-success": "#2FD07A",
  "--color-danger": "#FF5A5F",
  "--color-primary-tint": "#3D2A17",
  "--color-success-tint": "#16402C",
  "--color-danger-tint": "#40221F",
} as const;

const SPEC_PLAYER_COLORS = {
  blue: "#3F9FF3",
  sky: "#9CD3FF",
  cyan: "#35C8DE",
  yellow: "#F7DF45",
  ochre: "#EBB447",
  sand: "#D8C3A5",
  steel: "#97B0C4",
  silver: "#E3E8EF",
} as const;

/** docs/09 §3: Größe / Zeilenhöhe in px, Gewicht. */
const SPEC_TYPE = {
  display: [44, 48, 800],
  wordmark: [36, 40, 800],
  h1: [28, 34, 700],
  code: [28, 32, 700],
  h2: [22, 28, 700],
  title: [20, 26, 700],
  question: [22, 30, 600],
  "question-long": [19, 27, 600],
  answer: [17, 24, 500],
  button: [17, 24, 700],
  body: [16, 24, 400],
  label: [14, 20, 600],
  caption: [12, 16, 500],
} as const;

const remToPx = (value: string) => Number.parseFloat(value) * (value.endsWith("rem") ? 16 : 1);

describe("globals.css – Tokens aus docs/09 §2", () => {
  it("enthält alle Flächen-, Text-, Haupt-, Bedeutungs- und Tönungsfarben exakt", () => {
    for (const [name, value] of Object.entries(SPEC_COLORS)) expect(token(name), name).toBe(value.toLowerCase());
  });

  it("enthält die acht Spielerfarben exakt", () => {
    for (const color of PLAYER_COLORS) {
      expect(token(`--color-player-${color}`)).toBe(SPEC_PLAYER_COLORS[color].toLowerCase());
    }
  });

  it("definiert Radien, Dauer, Easing, Schatten, Scrim und Z-Index wie spezifiziert", () => {
    expect([token("--radius-sm"), token("--radius-md"), token("--radius-lg"), token("--radius-xl")]).toEqual([
      "6px",
      "12px",
      "16px",
      "24px",
    ]);
    expect([
      token("--duration-fast"),
      token("--duration-base"),
      token("--duration-slow"),
      token("--duration-overlay"),
    ]).toEqual(["120ms", "200ms", "320ms", "480ms"]);
    expect(token("--ease-standard")).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(token("--ease-emphasized")).toBe("cubic-bezier(0.3, 0, 0, 1)");
    expect(token("--ease-exit")).toBe("cubic-bezier(0.4, 0, 1, 1)");
    expect(token("--shadow-level-2")).toBe("0 16px 40px rgb(3 8 20 / 0.5)");
    expect(token("--color-scrim")).toBe("rgb(11 20 38 / 0.84)");
    expect([
      token("--z-index-hud"),
      token("--z-index-sheet"),
      token("--z-index-overlay"),
      token("--z-index-toast"),
      token("--z-index-connection"),
    ]).toEqual(["10", "40", "50", "60", "70"]);
  });

  it("setzt Rubik als einzige Schrift und den Lobby-Code-Sperrsatz", () => {
    expect(token("--font-sans")).toBe("var(--font-rubik), system-ui, sans-serif");
    expect(token("--tracking-code")).toBe("0.08em");
  });

  it("bildet die Typografie-Tabelle aus docs/09 §3 ab", () => {
    for (const [style, [size, lineHeight, weight]] of Object.entries(SPEC_TYPE)) {
      expect(remToPx(token(`--text-${style}`)), style).toBe(size);
      expect(remToPx(token(`--text-${style}--line-height`)), style).toBe(lineHeight);
      expect(Number(token(`--text-${style}--font-weight`)), style).toBe(weight);
    }
  });

  it("entfernt Tailwinds Standard-Paletten, Schatten, Unschärfen und Animationen", () => {
    for (const namespace of ["color", "font", "text", "radius", "shadow", "drop-shadow", "blur", "ease", "animate"]) {
      expect(css, namespace).toContain(`--${namespace}-*: initial;`);
    }
  });

  it("hat nur genutzte Animations-Tokens – keine zweite, abweichende Quelle für eine Bewegung (docs/09 §8)", () => {
    // Beispiel: Die Krone am Spielende animiert motion mit 480 ms; ein ungenutzter CSS-Token mit 320 ms widersprach dem.
    const sources = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(?:ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => readFileSync(join(SRC_DIR, file), "utf8"))
      .join("\n");
    const names = [...css.matchAll(/--animate-([a-z0-9-]+):/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(sources, `animate-${name}`).toMatch(new RegExp(`\\banimate-${name}\\b`));
    for (const keyframes of css.matchAll(/@keyframes ([a-z0-9-]+)/g)) {
      expect(css, `@keyframes ${keyframes[1]}`).toMatch(
        new RegExp(`(?:animation|--animate-[a-z0-9-]+):[^;]*\\b${keyframes[1]}\\b`),
      );
    }
  });

  it("legt Seitenrand-Breakpoint (390 px), Inhaltsspalte (480 px) und Dialog (360 px) fest", () => {
    expect(remToPx(token("--breakpoint-xs"))).toBe(390);
    expect(remToPx(token("--container-column"))).toBe(480);
    expect(remToPx(token("--container-dialog"))).toBe(360);
  });
});

describe("tokens.ts und @quizmaster/shared – Spiegel für JavaScript", () => {
  it("stimmt mit globals.css überein", () => {
    expect(THEME_COLOR.toLowerCase()).toBe(token("--color-bg"));
    expect(QR_CODE_COLORS.dark.toLowerCase()).toBe(token("--color-bg"));
    expect(QR_CODE_COLORS.light.toLowerCase()).toBe(token("--color-text"));
    for (const color of PLAYER_COLORS) {
      expect(PLAYER_COLOR_HEX[color].toLowerCase()).toBe(token(`--color-player-${color}`));
    }
    for (const [name, ms] of Object.entries(DURATION_MS)) expect(token(`--duration-${name}`)).toBe(`${ms}ms`);
    for (const [name, curve] of Object.entries(EASING)) {
      expect(token(`--ease-${name}`)).toBe(`cubic-bezier(${curve.join(", ")})`);
    }
  });
});
