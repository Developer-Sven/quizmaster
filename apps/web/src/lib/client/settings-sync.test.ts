import { DEFAULT_LOBBY_SETTINGS, type LobbySettings, type SettingsUpdate } from "@quizmaster/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmitResult } from "./realtime-client";
import { SETTINGS_SYNC_TIMING, SettingsSync } from "./settings-sync";

const BASE: LobbySettings = { ...DEFAULT_LOBBY_SETTINGS };

function setup(send?: (update: SettingsUpdate) => Promise<EmitResult<null>>) {
  const sent: SettingsUpdate[] = [];
  const drafts: Partial<LobbySettings>[] = [];
  const rejected: string[] = [];
  const sync = new SettingsSync(BASE, {
    send:
      send ??
      ((update) => {
        sent.push(update);
        return Promise.resolve({ ok: true, data: null });
      }),
    onDraft: (draft) => drafts.push(draft),
    onRejected: (code) => rejected.push(code),
  });
  return { sync, sent, drafts, rejected };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsSync: Stepper-Tipps gebündelt senden (ADR-042)", () => {
  it("zeigt jeden Tipp sofort und sendet nach einer Pause nur den letzten Stand", async () => {
    const { sync, sent, drafts } = setup();
    sync.change({ rounds: 4 });
    sync.change({ rounds: 5 });
    sync.change({ questionsPerCategory: 4 });
    expect(drafts.at(-1)).toEqual({ rounds: 5, questionsPerCategory: 4 });
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(sent).toEqual([{ rounds: 5, questionsPerCategory: 4 }]);
  });

  it("sendet bei Dauertippen spätestens jede Sekunde – höchstens 40 je 10 s (Server-Limit)", async () => {
    const { sync, sent } = setup();
    for (let tap = 0; tap < 50; tap++) {
      sync.change({ rounds: (tap % 10) + 1 });
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(sent.length).toBeGreaterThanOrEqual(9);
    expect(sent.length).toBeLessThanOrEqual(12);
    // Unabhängig vom Takt: nie öfter als alle 350 ms.
    const fast = setup();
    for (let tap = 0; tap < 100; tap++) {
      fast.sync.change({ rounds: (tap % 10) + 1 });
      await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs + 10);
    }
    expect(fast.sent.length).toBeLessThanOrEqual(Math.ceil((100 * (SETTINGS_SYNC_TIMING.idleMs + 10)) / 350));
  });

  it("hält den Entwurf, bis der Server ihn bestätigt – kein Zurückspringen zwischen Ack und lobby:state", async () => {
    const { sync, drafts } = setup();
    sync.change({ rounds: 6 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(drafts.at(-1)).toEqual({ rounds: 6 });
    sync.serverChanged({ ...BASE, rounds: 6 });
    expect(drafts.at(-1)).toEqual({});
  });

  it("nach bestätigtem Senden gilt der nächste Server-Stand – auch wenn er abweicht (nichts bleibt hängen)", async () => {
    const { sync, drafts } = setup();
    sync.change({ rounds: 6 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    sync.serverChanged({ ...BASE, rounds: 5 });
    expect(drafts.at(-1)).toEqual({});
  });

  it("schickt nichts, was dem Server-Stand entspricht (hin und zurück getippt)", async () => {
    const { sync, sent, drafts } = setup();
    sync.change({ rounds: 4 });
    sync.change({ rounds: 3 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(sent).toEqual([]);
    expect(drafts.at(-1)).toEqual({});
  });

  it("Änderungen während des Sendens gehen danach hinterher (immer der neueste Wert)", async () => {
    let resolve: (value: EmitResult<null>) => void = () => undefined;
    const sent: SettingsUpdate[] = [];
    const { sync } = setup((update) => {
      sent.push(update);
      return new Promise((done) => {
        resolve = done;
      });
    });
    sync.change({ rounds: 4 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    sync.change({ rounds: 7 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ rounds: 4 }]);
    resolve({ ok: true, data: null });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(sent).toEqual([{ rounds: 4 }, { rounds: 7 }]);
  });

  it("RATE_LIMITED: still später erneut (nach retryAfterMs), ohne Fehlermeldung", async () => {
    const results: EmitResult<null>[] = [
      { ok: false, code: "RATE_LIMITED", retryAfterMs: 2_000 },
      { ok: true, data: null },
    ];
    const sent: SettingsUpdate[] = [];
    const { sync, rejected } = setup((update) => {
      sent.push(update);
      return Promise.resolve(results.shift() ?? { ok: true, data: null });
    });
    sync.change({ maxPlayers: 6 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([{ maxPlayers: 6 }, { maxPlayers: 6 }]);
    expect(rejected).toEqual([]);
  });

  it("abgelehnt (z. B. Personen maximal unter der Personenzahl): Entwurf fällt weg, Aufrufer holt den Server-Stand", async () => {
    const { sync, drafts, rejected } = setup(() => Promise.resolve({ ok: false, code: "INVALID_OPTION" }));
    sync.change({ maxPlayers: 2 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(rejected).toEqual(["INVALID_OPTION"]);
    expect(drafts.at(-1)).toEqual({});
  });

  it("flush(): offene Tipps sofort senden – vor „Spiel starten“ und beim Schließen des Sheets", async () => {
    const { sync, sent } = setup();
    sync.change({ rounds: 8 });
    await sync.flush();
    expect(sent).toEqual([{ rounds: 8 }]);
    // Nichts offen: kein weiteres Senden, auch nicht nach Ablauf der Pause.
    await sync.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ rounds: 8 }]);
  });

  it("flush() wartet ein laufendes Senden ab und schickt den neuesten Stand hinterher", async () => {
    let resolve: (value: EmitResult<null>) => void = () => undefined;
    const sent: SettingsUpdate[] = [];
    const { sync } = setup((update) => {
      sent.push(update);
      return new Promise((done) => {
        resolve = done;
      });
    });
    sync.change({ rounds: 4 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    sync.change({ rounds: 9 });
    let flushed = false;
    const flushing = sync.flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    resolve({ ok: true, data: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ rounds: 4 }, { rounds: 9 }]);
    resolve({ ok: true, data: null });
    await flushing;
    expect(flushed).toBe(true);
  });

  /**
   * Ack vor Zustand (so sendet der Server): Während ein Senden läuft, tippt der Host auf den alten Wert zurück.
   * Nach dem Ack gilt der gesendete Wert als „gleich auf dem Server“ – der zurückgetippte alte Wert muss also
   * hinterher, obwohl er dem (noch alten) Server-Stand entspricht.
   */
  function slowServer() {
    const sent: SettingsUpdate[] = [];
    const acks: ((value: EmitResult<null>) => void)[] = [];
    const drafts: Partial<LobbySettings>[] = [];
    const sync = new SettingsSync(BASE, {
      send: (update) => {
        sent.push(update);
        return new Promise((done) => {
          acks.push(done);
        });
      },
      onDraft: (draft) => drafts.push(draft),
      onRejected: () => undefined,
    });
    /** Ack des ältesten offenen Sendens, danach (wie der Server) der Zustand mit diesen Werten. */
    const ackThenState = async (server: LobbySettings) => {
      acks.shift()?.({ ok: true, data: null });
      await vi.advanceTimersByTimeAsync(0);
      sync.serverChanged(server);
    };
    return { sync, sent, drafts, ackThenState };
  }

  it("Ack vor Zustand: ein während des Sendens zurückgetippter Wert wird nachgesendet (Timer feuert im Senden)", async () => {
    const { sync, sent, drafts, ackThenState } = slowServer();
    sync.change({ rounds: BASE.rounds + 1 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(sent).toEqual([{ rounds: BASE.rounds + 1 }]);
    sync.change({ rounds: BASE.rounds });
    // Der Timer für den zurückgetippten Wert läuft ab, während das erste Senden noch auf sein Ack wartet.
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs + 50);
    await ackThenState({ ...BASE, rounds: BASE.rounds + 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([{ rounds: BASE.rounds + 1 }, { rounds: BASE.rounds }]);
    await ackThenState({ ...BASE, rounds: BASE.rounds });
    expect(drafts.at(-1)).toEqual({});
  });

  it("Ack vor Zustand: flush() im Sendefenster wartet, bis der zurückgetippte Wert beim Server ist", async () => {
    const { sync, sent, ackThenState } = slowServer();
    sync.change({ rounds: BASE.rounds + 1 });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    sync.change({ rounds: BASE.rounds });
    let flushed = false;
    const flushing = sync.flush().then(() => {
      flushed = true;
    });
    await ackThenState({ ...BASE, rounds: BASE.rounds + 1 });
    // Nicht fertig: Der zurückgetippte Wert ist unterwegs, der Server hat noch den gesendeten.
    expect(sent).toEqual([{ rounds: BASE.rounds + 1 }, { rounds: BASE.rounds }]);
    expect(flushed).toBe(false);
    await ackThenState({ ...BASE, rounds: BASE.rounds });
    await flushing;
    expect(flushed).toBe(true);
  });

  it("kommt immer zur Ruhe: Entwurf leer, Server hat den letzten Tipp (zufällige Latenz, Limits, flush)", async () => {
    // Deterministischer Zufall (mulberry32): jeder Seed ist ein reproduzierbarer Ablauf.
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      let server: LobbySettings = { ...BASE };
      let shown: LobbySettings = { ...BASE };
      // Socket.IO: eine Leitung, Reihenfolge bleibt (Ack vor Zustand, Antworten in Sendereihenfolge).
      let lineFreeAt = 0;
      const deliver = (latencyMs: number, run: () => void) => {
        lineFreeAt = Math.max(lineFreeAt, Date.now() + latencyMs);
        setTimeout(run, lineFreeAt - Date.now());
      };
      const sync: SettingsSync = new SettingsSync(server, {
        send: (update) =>
          new Promise((resolve) => {
            const limited = next() < 0.15;
            deliver(Math.floor(next() * 500), () => {
              if (limited) {
                resolve({ ok: false, code: "RATE_LIMITED", retryAfterMs: Math.floor(next() * 1_500) });
                return;
              }
              server = { ...server, ...update };
              resolve({ ok: true, data: null });
              const state = server;
              deliver(1, () => sync.serverChanged(state));
            });
          }),
        onDraft: (draft) => {
          shown = { ...server, ...draft };
        },
        onRejected: () => undefined,
      });
      let wanted = BASE.rounds;
      for (let step = 0; step < 30; step++) {
        wanted = Math.min(10, Math.max(1, wanted + (next() < 0.5 ? -1 : 1)));
        sync.change({ rounds: wanted });
        if (next() < 0.1) void sync.flush();
        await vi.advanceTimersByTimeAsync(Math.floor(next() * 700));
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.rounds, `Seed ${seed}`).toBe(wanted);
      expect(shown.rounds, `Seed ${seed}`).toBe(wanted);
      sync.dispose();
    }
  });

  it("Kategorie-Listen und Wahrheitswerte: gleiche Inhalte gelten als bestätigt (ADR-046/048)", async () => {
    const { sync, sent, drafts } = setup();
    sync.change({ categoryIds: ["sport", "musik"], hostPlays: false });
    await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_TIMING.idleMs);
    expect(sent).toEqual([{ categoryIds: ["sport", "musik"], hostPlays: false }]);
    // Neues Array-Objekt mit gleichem Inhalt vom Server: bestätigt, Entwurf leer.
    sync.serverChanged({ ...BASE, categoryIds: ["sport", "musik"], hostPlays: false });
    expect(drafts.at(-1)).toEqual({});
  });

  it("nach dispose() wird nichts mehr gesendet", async () => {
    const { sync, sent } = setup();
    sync.change({ rounds: 9 });
    sync.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([]);
  });
});
