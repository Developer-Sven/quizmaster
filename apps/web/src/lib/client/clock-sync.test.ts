import { CLOCK_SYNC } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { type ClockSample, createClockSync, offsetFromSamples } from "./clock-sync";

describe("offsetFromSamples", () => {
  it("rechnet offset = serverNow − (t0 + rtt/2)", () => {
    // Senden bei 1.000, Ack bei 1.100 (rtt 100) → Server-Mitte bei Client 1.050; Server meldet 6.050
    expect(offsetFromSamples([{ t0: 1_000, t1: 1_100, serverNow: 6_050 }])).toBe(5_000);
  });

  it("nimmt den Median und ist robust gegen Ausreißer", () => {
    const samples: ClockSample[] = [
      { t0: 0, t1: 100, serverNow: 5_050 }, // 5.000
      { t0: 400, t1: 480, serverNow: 5_440 }, // 5.000
      { t0: 800, t1: 2_800, serverNow: 7_600 }, // 5.800 (langsame Messung)
      { t0: 3_100, t1: 3_160, serverNow: 8_120 }, // 4.990
      { t0: 3_500, t1: 3_600, serverNow: 8_560 }, // 5.010
    ];
    expect(offsetFromSamples(samples)).toBe(5_000);
  });

  it("mittelt bei gerader Anzahl die beiden mittleren Werte", () => {
    const samples: ClockSample[] = [
      { t0: 0, t1: 0, serverNow: 100 },
      { t0: 0, t1: 0, serverNow: 200 },
    ];
    expect(offsetFromSamples(samples)).toBe(150);
  });

  it("verwirft ungültige Messungen und liefert ohne Messung null", () => {
    expect(offsetFromSamples([])).toBeNull();
    expect(offsetFromSamples([{ t0: 500, t1: 100, serverNow: 1_000 }])).toBeNull();
    expect(offsetFromSamples([{ t0: 0, t1: 10, serverNow: Number.NaN }])).toBeNull();
  });
});

/** Simulierte Uhr und Netz: Server geht `trueOffset` vor, jede Anfrage dauert `rtt` (symmetrisch). */
function simulation(trueOffset: number, rtt: number) {
  let clientTime = 10_000;
  const sent: number[] = [];
  let intervalRun: (() => void) | null = null;
  let intervalMs = 0;
  let cancelled = false;
  const offsets: number[] = [];
  const sync = createClockSync({
    now: () => clientTime,
    wait: async (ms) => {
      clientTime += ms;
    },
    every: (ms, run) => {
      intervalMs = ms;
      intervalRun = run;
      return () => {
        cancelled = true;
      };
    },
    requestServerTime: async (t0) => {
      sent.push(t0);
      clientTime += rtt;
      return t0 + rtt / 2 + trueOffset;
    },
    onOffset: (offset) => offsets.push(offset),
  });
  return {
    sync,
    sent,
    offsets,
    get intervalMs() {
      return intervalMs;
    },
    get cancelled() {
      return cancelled;
    },
    tick() {
      intervalRun?.();
    },
  };
}

describe("createClockSync", () => {
  it("misst 5× im Abstand von 300 ms und meldet den Median-Offset", async () => {
    const sim = simulation(4_321, 80);
    await expect(sim.sync.syncNow()).resolves.toBe(4_321);
    expect(sim.sent).toHaveLength(CLOCK_SYNC.samples);
    const gaps = sim.sent.slice(1).map((t0, index) => t0 - (sim.sent[index] ?? 0));
    // zwischen zwei Sendezeitpunkten: Ack (80 ms) + 300 ms Pause
    expect(gaps).toEqual([380, 380, 380, 380]);
    expect(sim.offsets).toEqual([4_321]);
  });

  it("teilt eine laufende Messreihe statt eine zweite zu starten", async () => {
    const sim = simulation(-250, 40);
    const first = sim.sync.syncNow();
    const second = sim.sync.syncNow();
    expect(second).toBe(first);
    await first;
    expect(sim.sent).toHaveLength(CLOCK_SYNC.samples);
  });

  it("wiederholt alle 60 s und stoppt sauber", async () => {
    const sim = simulation(1_000, 20);
    sim.sync.start();
    sim.sync.start(); // idempotent
    expect(sim.intervalMs).toBe(CLOCK_SYNC.resyncIntervalMs);
    expect(sim.sync.running).toBe(true);
    await sim.sync.syncNow();
    sim.tick();
    await sim.sync.syncNow();
    expect(sim.offsets).toEqual([1_000, 1_000]);
    sim.sync.stop();
    expect(sim.cancelled).toBe(true);
    expect(sim.sync.running).toBe(false);
  });

  it("überspringt Messungen ohne Ack und meldet ohne gültige Messung nichts", async () => {
    let calls = 0;
    const offsets: number[] = [];
    const sync = createClockSync({
      now: () => 0,
      wait: async () => {},
      requestServerTime: async () => {
        calls += 1;
        return calls === 3 ? 700 : null;
      },
      onOffset: (offset) => offsets.push(offset),
    });
    await expect(sync.syncNow()).resolves.toBe(700);
    expect(offsets).toEqual([700]);

    const silent: number[] = [];
    const none = createClockSync({
      wait: async () => {},
      requestServerTime: async () => null,
      onOffset: (offset) => silent.push(offset),
    });
    await expect(none.syncNow()).resolves.toBeNull();
    expect(silent).toEqual([]);
  });

  it("meldet nach stop() keinen Offset einer laufenden Messreihe mehr", async () => {
    const offsets: number[] = [];
    let calls = 0;
    const sync = createClockSync({
      now: () => 0,
      wait: async () => {},
      requestServerTime: async () => {
        calls += 1;
        if (calls === 2) sync.stop();
        return 100;
      },
      onOffset: (offset) => offsets.push(offset),
    });
    await expect(sync.syncNow()).resolves.toBeNull();
    expect(calls).toBe(2);
    expect(offsets).toEqual([]);
  });
});
