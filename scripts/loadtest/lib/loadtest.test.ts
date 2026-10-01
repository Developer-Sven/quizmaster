import { describe, expect, it } from "vitest";
import { ConfigError, parseDuration, parseLoadtestArgs, planLobbies } from "./config.ts";
import { bucketCounts, fractionAtMost, histogramQuantile, parseProm, seriesValue, sumOf } from "./server-metrics.ts";
import {
  emptySamples,
  emptyStats,
  increment,
  MAX_SAMPLES,
  mergeSamples,
  mergeStats,
  ms,
  observe,
  percentile,
  record,
  summarize,
} from "./stats.ts";

describe("Parameter", () => {
  it("liest Dauern in allen Schreibweisen", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("4m")).toBe(240_000);
    expect(parseDuration("2m30s")).toBe(150_000);
    expect(parseDuration("1500ms")).toBe(1_500);
    expect(parseDuration("45")).toBe(45_000);
    expect(() => parseDuration("vier Minuten")).toThrow(ConfigError);
    expect(() => parseDuration("4m x")).toThrow(ConfigError);
  });

  it("hat Standardwerte nach docs/07 und prüft Grenzen", () => {
    const config = parseLoadtestArgs([]);
    expect(config).toMatchObject({
      lobbies: 125,
      players: 8,
      durationMs: 240_000,
      rampMs: 60_000,
      target: null,
      workers: 2,
      cpus: "0,1",
      timing: "normal",
      rematch: true,
    });
    const custom = parseLoadtestArgs([
      "--lobbies",
      "400",
      "--players",
      "8",
      "--duration",
      "10m",
      "--ramp",
      "2m",
      "--target",
      "ws://127.0.0.1:4001/socket.io",
      "--no-rematch",
    ]);
    expect(custom).toMatchObject({
      lobbies: 400,
      durationMs: 600_000,
      rampMs: 120_000,
      target: "http://127.0.0.1:4001",
    });
    expect(custom !== "help" && custom.rematch).toBe(false);
    expect(parseLoadtestArgs(["--help"])).toBe("help");
    for (const args of [
      ["--players", "9"],
      ["--workers", "1"],
      ["--ramp", "5m", "--duration", "4m"],
      ["--cpus", "0;1"],
      ["--target", "ftp://host"],
      ["--catalog", "alles"],
      ["--unbekannt"],
    ]) {
      expect(() => parseLoadtestArgs(args), args.join(" ")).toThrow(ConfigError);
    }
  });

  it("verteilt Lobbys reihum auf die Prozesse und gleichmäßig über die Rampe", () => {
    const plan = planLobbies({ lobbies: 5, workers: 2, rampMs: 4_000 }, 1_000);
    expect(plan).toEqual([
      [
        { index: 0, startAt: 1_000 },
        { index: 2, startAt: 3_000 },
        { index: 4, startAt: 5_000 },
      ],
      [
        { index: 1, startAt: 2_000 },
        { index: 3, startAt: 4_000 },
      ],
    ]);
  });
});

describe("Statistik", () => {
  it("berechnet Perzentile linear interpoliert", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5.5);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile([], 50)).toBeNull();
    const set = emptySamples();
    for (const value of sorted) observe(set, value);
    observe(set, Number.NaN);
    expect(summarize(set)).toMatchObject({ count: 10, mean: 5.5, p50: 5.5, max: 10 });
    expect(ms(1.25)).toBe("1,3");
    expect(ms(null)).toBe("–");
  });

  it("begrenzt Stichproben (Reservoir) und führt Prozesse gewichtet zusammen", () => {
    const big = emptySamples();
    for (let index = 0; index < MAX_SAMPLES + 1_000; index++) observe(big, 1, () => 0.999);
    expect(big.values).toHaveLength(MAX_SAMPLES);
    expect(big.count).toBe(MAX_SAMPLES + 1_000);
    const a = emptySamples();
    const b = emptySamples();
    for (let index = 0; index < 300; index++) observe(a, 10);
    for (let index = 0; index < 100; index++) observe(b, 20);
    const merged = mergeSamples([a, b]);
    expect(merged.count).toBe(400);
    expect(merged.max).toBe(20);
    expect(summarize(merged).mean).toBe((300 * 10 + 100 * 20) / 400);
    const stats = mergeStats([
      { samples: { x: a }, counters: { ok: 2 } },
      { samples: { x: b }, counters: { ok: 3, fehler: 1 } },
    ]);
    expect(stats.counters).toEqual({ ok: 5, fehler: 1 });
    expect(stats.samples.x?.count).toBe(400);
    const own = emptyStats();
    record(own, "ack", 3);
    increment(own, "answers", 2);
    expect(own.samples.ack?.values).toEqual([3]);
    expect(own.counters.answers).toBe(2);
  });
});

describe("/metrics", () => {
  const before = parseProm(
    [
      "# TYPE qm_ack_latency_seconds histogram",
      'qm_ack_latency_seconds_bucket{le="0.001",event="game:answer"} 10',
      'qm_ack_latency_seconds_bucket{le="0.01",event="game:answer"} 10',
      'qm_ack_latency_seconds_bucket{le="+Inf",event="game:answer"} 10',
      'qm_ack_latency_seconds_bucket{le="0.001",event="time:sync"} 5',
      'qm_ack_latency_seconds_bucket{le="0.01",event="time:sync"} 5',
      'qm_ack_latency_seconds_bucket{le="+Inf",event="time:sync"} 5',
      "qm_sockets 3",
      'qm_mongo_errors_total{operation="heartbeat"} 1',
      'qm_mongo_errors_total{operation="lobby_snapshot"} 2',
    ].join("\n"),
  );
  const after = parseProm(
    [
      'qm_ack_latency_seconds_bucket{le="0.001",event="game:answer"} 60',
      'qm_ack_latency_seconds_bucket{le="0.01",event="game:answer"} 110',
      'qm_ack_latency_seconds_bucket{le="+Inf",event="game:answer"} 110',
      'qm_ack_latency_seconds_bucket{le="0.001",event="time:sync"} 5',
      'qm_ack_latency_seconds_bucket{le="0.01",event="time:sync"} 5',
      'qm_ack_latency_seconds_bucket{le="+Inf",event="time:sync"} 5',
      "qm_sockets 1000",
    ].join("\n"),
  );

  it("bildet Bucket-Differenzen und schätzt Quantile wie histogram_quantile", () => {
    const buckets = bucketCounts(after, before, "qm_ack_latency_seconds", { event: "game:answer" });
    expect(buckets).toEqual([
      { le: 0.001, count: 50 },
      { le: 0.01, count: 100 },
      { le: Number.POSITIVE_INFINITY, count: 100 },
    ]);
    expect(histogramQuantile(buckets, 0.5)).toBeCloseTo(0.001, 9);
    expect(histogramQuantile(buckets, 0.75)).toBeCloseTo(0.0055, 9);
    expect(fractionAtMost(buckets, 0.001)).toBe(0.5);
    expect(histogramQuantile([], 0.5)).toBeNull();
    expect(seriesValue(after, "qm_sockets")).toBe(1_000);
    expect(sumOf(before, "qm_mongo_errors_total")).toBe(3);
    expect(sumOf(before, "qm_mongo_errors_total", { operation: "heartbeat" })).toBe(1);
  });
});
