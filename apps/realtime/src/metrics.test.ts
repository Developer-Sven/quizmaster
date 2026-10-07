/**
 * Betriebsmetriken (docs/07 Checkliste Phase 6, docs/12 §Monitoring): Broadcast-/Event-Größen über den
 * Socket.IO-Encoder, Event-Loop-p99 je Fenster als Histogramm, CPU-Zeit, Startzeit, Wiederaufnahme-Zähler.
 */
import { Server } from "socket.io";
import { describe, expect, it } from "vitest";
import { metricValue } from "../test/helpers/fakes.ts";
import { ACK_LATENCY_BUCKETS, createMetrics, instrumentServerEvents, type RealtimeMetrics } from "./metrics.ts";

/** socket.io-parser: EVENT bzw. ACK. */
const EVENT = 2;
const ACK = 3;

/** Wert einer Histogramm-Teilreihe (`_count`, `_sum`, `_bucket`) mit passenden Labels. */
async function histogramValue(
  metrics: RealtimeMetrics,
  name: string,
  part: "count" | "sum" | "bucket",
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name);
  if (metric === undefined) throw new Error(`Metrik ${name} fehlt`);
  const { values } = await metric.get();
  // Histogramme liefern je Teilreihe `metricName` (in den Typen nur bei MetricValueWithName).
  return values
    .filter((entry) => (entry as { metricName?: string }).metricName === `${name}_${part}`)
    .filter((entry) => Object.entries(labels).every(([key, value]) => String(entry.labels[key]) === value))
    .reduce((sum, entry) => sum + entry.value, 0);
}

describe("Server-Event-Größen", () => {
  it("misst jedes kodierte Server-Event einmal am echten Socket.IO-Encoder", async () => {
    const metrics = createMetrics({ socketCount: () => 0 });
    const io = new Server();
    instrumentServerEvents(io, metrics);
    instrumentServerEvents(io, metrics); // idempotent

    const state = { rev: 3, phase: "lobby", players: [{ id: "p1", name: "Grüße" }] };
    const encoded = io.encoder.encode({ type: EVENT, nsp: "/", data: ["lobby:state", state] });
    io.encoder.encode({ type: EVENT, nsp: "/", data: ["lobby:self", { playerId: "p1" }] });
    io.encoder.encode({ type: ACK, nsp: "/", id: 1, data: [{ ok: true, data: null }] });
    io.encoder.encode({ type: EVENT, nsp: "/", data: ["unbekannt", {}] });

    const bytes = Buffer.byteLength(String(encoded[0]));
    expect(bytes).toBe(Buffer.byteLength(`${EVENT}${JSON.stringify(["lobby:state", state])}`));
    expect(await histogramValue(metrics, "qm_server_event_bytes", "count", { event: "lobby:state" })).toBe(1);
    expect(await histogramValue(metrics, "qm_server_event_bytes", "sum", { event: "lobby:state" })).toBe(bytes);
    expect(await histogramValue(metrics, "qm_server_event_bytes", "count", { event: "lobby:self" })).toBe(1);
    expect(await histogramValue(metrics, "qm_server_event_bytes", "count")).toBe(2);
    expect(await metrics.render()).not.toContain('event="unbekannt"');
  });
});

describe("Prozess- und Event-Loop-Metriken", () => {
  it("liefert Startzeit, CPU-Zeit und je 5-s-Fenster eine p99-Beobachtung", async () => {
    const metrics = createMetrics({ socketCount: () => 7 });
    const startTime = await metricValue(metrics, "qm_process_start_time_seconds");
    expect(Math.abs(startTime - (Date.now() / 1_000 - process.uptime()))).toBeLessThan(2);
    let spin = 0;
    for (let index = 0; index < 2e6; index++) spin += index;
    expect(spin).toBeGreaterThan(0);
    expect(await metricValue(metrics, "qm_process_cpu_seconds_total")).toBeGreaterThan(0);

    metrics.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      metrics.eventLoop.sample();
      expect(await histogramValue(metrics, "qm_event_loop_p99_seconds", "count")).toBe(1);
      expect(await histogramValue(metrics, "qm_event_loop_p99_seconds", "bucket", { le: "0.2" })).toBe(1);
    } finally {
      metrics.stop();
    }
    expect(await metricValue(metrics, "qm_sockets")).toBe(7);
  });

  it("zählt die Wiederaufnahme je Ergebnis und hat SLO-Grenzen als Ack-Buckets", async () => {
    const metrics = createMetrics({ socketCount: () => 0 });
    metrics.lobbiesResumed.inc({ outcome: "resumed" }, 2);
    metrics.lobbiesResumed.inc({ outcome: "closed" });
    expect(await metricValue(metrics, "qm_lobbies_resumed_total", { outcome: "resumed" })).toBe(2);
    expect(await metricValue(metrics, "qm_lobbies_resumed_total", { outcome: "closed" })).toBe(1);
    expect(ACK_LATENCY_BUCKETS).toEqual(expect.arrayContaining([0.01, 0.03]));
  });
});
