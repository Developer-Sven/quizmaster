/**
 * Datensparsamkeit (ADR-058): Der Dienst entfernt den IP-Schlüssel von Meldungen und Bewertungen, die älter als
 * `RETENTION.feedbackOriginMs` sind – erster Lauf kurz nach dem Start, dann stündlich, nie überlappend; Fehler werden
 * geloggt und gezählt. (Die Abfragen selbst prüft `packages/db/src/repos/quality.test.ts` gegen die Test-DB.)
 */
import { Writable } from "node:stream";
import { RETENTION } from "@quizmaster/shared/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.ts";
import { createMetrics } from "../../src/metrics.ts";
import {
  createOriginRetention,
  ORIGIN_RETENTION_FIRST_RUN_MS,
  ORIGIN_RETENTION_INTERVAL_MS,
  type OriginRetentionDeps,
} from "../../src/services/origin-retention.ts";
import { metricValue } from "../helpers/index.ts";

const now = Date.parse("2026-10-07T10:00:00Z");

function setup(
  forget: { reports?: () => Promise<number>; ratings?: () => Promise<number> } = {},
  timing: { intervalMs?: number; firstRunMs?: number } = {},
) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      callback();
    },
  });
  const calls: Date[] = [];
  const repos = {
    reports: {
      async forgetOrigins(before: Date) {
        calls.push(before);
        return forget.reports ? forget.reports() : 2;
      },
    },
    ratings: {
      async forgetOrigins(before: Date) {
        calls.push(before);
        return forget.ratings ? forget.ratings() : 3;
      },
    },
  } as unknown as OriginRetentionDeps["repos"];
  const metrics = createMetrics({ socketCount: () => 0 });
  const retention = createOriginRetention({
    repos,
    clock: { now: () => now },
    logger: createLogger({ level: "debug", destination }),
    metrics,
    ...timing,
  });
  return { retention, calls, lines, metrics };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Herkunft nach 30 Tagen entfernen (ADR-058)", () => {
  it("ein Lauf: Grenze = jetzt − 30 Tage für Meldungen und Bewertungen, Anzahl im Log", async () => {
    const { retention, calls, lines } = setup();
    expect(await retention.runOnce()).toEqual({ reports: 2, ratings: 3 });
    expect(calls).toEqual([new Date(now - RETENTION.feedbackOriginMs), new Date(now - RETENTION.feedbackOriginMs)]);
    expect(RETENTION.feedbackOriginMs).toBe(30 * 24 * 60 * 60 * 1_000);
    const log = JSON.parse(lines.find((line) => line.includes("Herkunft älterer")) ?? "{}");
    expect(log).toMatchObject({ reports: 2, ratings: 3 });
  });

  it("geplant: erster Lauf nach einer Minute, dann stündlich; stop beendet die Läufe", async () => {
    vi.useFakeTimers();
    const { retention, calls } = setup();
    retention.start();
    retention.start(); // idempotent
    await vi.advanceTimersByTimeAsync(ORIGIN_RETENTION_FIRST_RUN_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(ORIGIN_RETENTION_INTERVAL_MS);
    expect(calls).toHaveLength(4);
    retention.stop();
    await vi.advanceTimersByTimeAsync(3 * ORIGIN_RETENTION_INTERVAL_MS);
    expect(calls).toHaveLength(4);
  });

  it("überlappt nie; ein Fehler wird geloggt und gezählt, der nächste Lauf versucht es erneut", async () => {
    vi.useFakeTimers();
    let release: (count: number) => void = () => undefined;
    let attempt = 0;
    // Takt 10 s, also unter der Frist je Lauf (30 s): Ein hängender Lauf blockiert die nächsten Takte.
    const { retention, calls, lines, metrics } = setup(
      {
        reports: () => {
          attempt += 1;
          if (attempt === 1) return Promise.reject(new Error("Netzwerk weg"));
          return new Promise<number>((resolve) => {
            release = resolve;
          });
        },
      },
      { firstRunMs: 1_000, intervalMs: 10_000 },
    );
    retention.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.some((line) => line.includes("nicht entfernt – nächster Lauf versucht es erneut"))).toBe(true);
    expect(await metricValue(metrics, "qm_mongo_errors_total", { operation: "origin_retention" })).toBe(1);
    // Zweiter Lauf (Takt bei 10 s) hängt – der Takt bei 20 s startet keinen parallelen.
    await vi.advanceTimersByTimeAsync(10_000);
    const pending = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(pending);
    // Fertig: Der hängende Lauf macht mit den Bewertungen weiter, der nächste Takt läuft wieder.
    release(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBeGreaterThanOrEqual(pending + 2);
    retention.stop();
  });
});
