/**
 * Parameter des Lasttests (docs/07 §Lasttest): `--lobbies 400 --players 8 --duration 10m --ramp 2m --target ws://…`
 * plus Betriebsparameter (Prozesse, CPU-Kerne des lokalen Servers, Spiel-Einstellungen). Rein (unit-getestet).
 */
import { parseArgs } from "node:util";
import { type GameTimingMode, SETTINGS_BOUNDS } from "@quizmaster/shared";

export const LOADTEST_USAGE = `pnpm loadtest [--lobbies 125] [--players 8] [--duration 4m] [--ramp 60s] [--target <url>]
  [--workers 2] [--cpus 0,1] [--rounds 1] [--questions 1] [--no-rematch] [--catalog fixtures|content]
  [--timing normal|fast] [--port 4521] [--origin <url>] [--realtime-entry <pfad>] [--json <datei>] [--report <datei>]
  [--label <text>]

  Ohne --target startet der Lasttest selbst eine Realtime-Instanz (Prod-Build dist/index.mjs, per taskset auf
  --cpus, Test-DB mit Präfix, RATE_LIMIT_MODE=relaxed, GAME_TIMING=normal). Mit --target braucht er die Secrets der
  Instanz in LOADTEST_TICKET_SECRET (und optional LOADTEST_METRICS_TOKEN) – nie gegen Produktion.`;

export interface LoadtestConfig {
  lobbies: number;
  players: number;
  durationMs: number;
  rampMs: number;
  /** Basis-URL einer laufenden Instanz (http/https/ws/wss) – `null` = lokale Instanz starten. */
  target: string | null;
  workers: number;
  /** CPU-Liste für `taskset` (lokale Instanz), z. B. „0,1“ = 2 vCPU laut docs/07. */
  cpus: string;
  rounds: number;
  questionsPerCategory: number;
  rematch: boolean;
  catalog: "fixtures" | "content";
  timing: GameTimingMode;
  /** Port der lokalen Instanz. */
  port: number;
  /** Origin für den Handshake (muss in APP_ORIGIN der Instanz stehen). */
  origin: string | null;
  realtimeEntry: string | null;
  json: string | null;
  report: string | null;
  label: string | null;
}

export class ConfigError extends Error {}

/** „90s“, „4m“, „2m30s“, „1h“, „1500ms“ oder reine Sekunden → Millisekunden. */
export function parseDuration(raw: string): number {
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value) {
    throw new ConfigError(`Dauer „${raw}“: z. B. 90s, 4m, 2m30s`);
  }
  const factor: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Math.round(parts.reduce((sum, part) => sum + Number(part[1]) * (factor[part[2] ?? "s"] ?? 0), 0));
}

function integer(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`--${name}: ganze Zahl erwartet`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`--${name}: ${min}–${max} erwartet`);
  return value;
}

function httpBase(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw.replace(/^ws(s?):/, "http$1:"));
  } catch {
    throw new ConfigError(`--${name}: URL erwartet`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError(`--${name}: http(s)/ws(s) erwartet`);
  return url.origin;
}

export function parseLoadtestArgs(args: readonly string[]): LoadtestConfig | "help" {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        lobbies: { type: "string" },
        players: { type: "string" },
        duration: { type: "string" },
        ramp: { type: "string" },
        target: { type: "string" },
        workers: { type: "string" },
        cpus: { type: "string" },
        rounds: { type: "string" },
        questions: { type: "string" },
        "no-rematch": { type: "boolean" },
        catalog: { type: "string" },
        timing: { type: "string" },
        port: { type: "string" },
        origin: { type: "string" },
        "realtime-entry": { type: "string" },
        json: { type: "string" },
        report: { type: "string" },
        label: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  if (values.help === true) return "help";
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  const durationMs = parseDuration(text("duration") ?? "4m");
  const rampMs = parseDuration(text("ramp") ?? "60s");
  if (durationMs < 10_000 || durationMs > 60 * 60_000) throw new ConfigError("--duration: 10 s bis 60 min");
  if (rampMs >= durationMs) throw new ConfigError("--ramp muss kürzer als --duration sein");
  const cpus = text("cpus") ?? "0,1";
  if (!/^\d+(?:[,-]\d+)*$/.test(cpus)) throw new ConfigError("--cpus: z. B. 0,1 oder 2-3");
  const catalog = text("catalog") ?? "fixtures";
  if (catalog !== "fixtures" && catalog !== "content") throw new ConfigError("--catalog: fixtures oder content");
  const timing = text("timing") ?? "normal";
  if (timing !== "normal" && timing !== "fast") throw new ConfigError("--timing: normal oder fast");
  const target = text("target");
  const origin = text("origin");
  return {
    lobbies: integer(text("lobbies"), 125, "lobbies", 1, 10_000),
    players: integer(text("players"), 8, "players", 2, 8),
    durationMs,
    rampMs,
    target: target === undefined ? null : httpBase(target, "target"),
    workers: integer(text("workers"), 2, "workers", 2, 32),
    cpus,
    rounds: integer(text("rounds"), 1, "rounds", SETTINGS_BOUNDS.rounds.min, SETTINGS_BOUNDS.rounds.max),
    questionsPerCategory: integer(
      text("questions"),
      1,
      "questions",
      SETTINGS_BOUNDS.questionsPerCategory.min,
      SETTINGS_BOUNDS.questionsPerCategory.max,
    ),
    rematch: values["no-rematch"] !== true,
    catalog,
    timing,
    port: integer(text("port"), 4521, "port", 1_024, 65_535),
    origin: origin === undefined ? null : httpBase(origin, "origin"),
    realtimeEntry: text("realtime-entry") ?? null,
    json: text("json") ?? null,
    report: text("report") ?? null,
    label: text("label") ?? null,
  };
}

/** Lobbys reihum auf die Prozesse verteilt, Startzeitpunkte gleichmäßig über die Rampe. */
export function planLobbies(
  config: Pick<LoadtestConfig, "lobbies" | "workers" | "rampMs">,
  startAt: number,
): Array<Array<{ index: number; startAt: number }>> {
  const plan = Array.from({ length: config.workers }, () => [] as Array<{ index: number; startAt: number }>);
  for (let index = 0; index < config.lobbies; index++) {
    const offset = config.lobbies === 1 ? 0 : Math.round((config.rampMs * index) / (config.lobbies - 1));
    plan[index % config.workers]?.push({ index, startAt: startAt + offset });
  }
  return plan;
}
