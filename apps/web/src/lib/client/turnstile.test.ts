/**
 * Turnstile im Browser (lib/client/turnstile.ts) gegen eine nachgebaute Seite und eine nachgebaute
 * Turnstile-API: Skript lazy und einmal laden (mit CSP-Nonce), Fehler beim Laden, Widget-Optionen (Managed,
 * interaction-only, Deutsch, dunkel), Statuswechsel inkl. Bestätigung, Fehler/Ablauf/Zeitüberschreitung, Tokens
 * nur einmal (je Lösung neues Widget, danach entfernt), Lösungen nacheinander, Aufräumen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTurnstileSolver,
  loadTurnstile,
  pageNonce,
  resetTurnstileLoaderForTests,
  TURNSTILE_SCRIPT_URL,
  type TurnstileApi,
  type TurnstileRenderOptions,
  type TurnstileStatus,
} from "./turnstile";

class FakeScript extends EventTarget {
  src = "";
  async = false;
  nonce = "";
  removed = false;
  remove(): void {
    this.removed = true;
  }
}

function fakePage(options: { nonce?: string } = {}) {
  const appended: FakeScript[] = [];
  const existing = Object.assign(new FakeScript(), { nonce: options.nonce ?? "" });
  const doc = {
    createElement: () => new FakeScript(),
    head: {
      appendChild: (script: FakeScript) => {
        appended.push(script);
        return script;
      },
    },
    querySelectorAll: () => [existing],
  };
  return { doc: doc as unknown as Document, appended };
}

/** Nachbau von `window.turnstile`: merkt sich Render-Optionen und entfernte Widgets. */
function fakeApi() {
  const renders: Array<{ id: string; container: unknown; options: TurnstileRenderOptions }> = [];
  const removed: string[] = [];
  const api: TurnstileApi = {
    render(container, options) {
      const id = `w${renders.length + 1}`;
      renders.push({ id, container, options });
      return id;
    },
    remove(id) {
      removed.push(id);
    },
  };
  const last = () => {
    const entry = renders.at(-1);
    if (entry === undefined) throw new Error("kein Widget gerendert");
    return entry.options;
  };
  return { api, renders, removed, last };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  resetTurnstileLoaderForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Skript laden", () => {
  it("lädt api.js einmal (explicit render, async, mit Nonce der Seite); gleichzeitige Aufrufe teilen sich das Laden", async () => {
    const { doc, appended } = fakePage({ nonce: "n0nce" });
    const win: { turnstile?: TurnstileApi } = {};
    const first = loadTurnstile({ doc, win });
    const second = loadTurnstile({ doc, win });
    expect(appended).toHaveLength(1);
    const script = appended[0] as FakeScript;
    expect(script.src).toBe(TURNSTILE_SCRIPT_URL);
    expect(script.src).toMatch(/^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit$/);
    expect(script.async).toBe(true);
    expect(script.nonce).toBe("n0nce");
    win.turnstile = fakeApi().api;
    script.dispatchEvent(new Event("load"));
    await expect(first).resolves.toBe(win.turnstile);
    await expect(second).resolves.toBe(win.turnstile);
    // Schon geladen: kein zweites Skript.
    await expect(loadTurnstile({ doc, win })).resolves.toBe(win.turnstile);
    expect(appended).toHaveLength(1);
  });

  it("Ladefehler, fehlende API und Zeitüberschreitung → Fehler; danach darf neu geladen werden", async () => {
    const { doc, appended } = fakePage();
    const win: { turnstile?: TurnstileApi } = {};
    const failed = loadTurnstile({ doc, win });
    (appended[0] as FakeScript).dispatchEvent(new Event("error"));
    await expect(failed).rejects.toThrow(/nicht ladbar/);
    expect((appended[0] as FakeScript).removed).toBe(true);

    const noApi = loadTurnstile({ doc, win });
    (appended[1] as FakeScript).dispatchEvent(new Event("load"));
    await expect(noApi).rejects.toThrow(/ohne API/);

    const slow = loadTurnstile({ doc, win, timeoutMs: 1_000 });
    const expectation = expect(slow).rejects.toThrow(/Zeitüberschreitung/);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
    expect(appended).toHaveLength(3);
  });

  it("pageNonce liest die Nonce-Eigenschaft eines Skripts der Seite (oder null)", () => {
    expect(pageNonce(fakePage({ nonce: "abc" }).doc)).toBe("abc");
    expect(pageNonce(fakePage().doc)).toBeNull();
  });
});

describe("Prüfung lösen", () => {
  function setup(options: { solveTimeoutMs?: number } = {}) {
    const turnstile = fakeApi();
    const load = vi.fn(async () => turnstile.api);
    const solver = createTurnstileSolver({ siteKey: "1x00000000000000000000AA", load, ...options });
    const statuses: TurnstileStatus[] = [];
    solver.subscribe(() => statuses.push(solver.getStatus()));
    const container = { id: "container" } as unknown as HTMLElement;
    solver.attach(container);
    return { solver, turnstile, load, statuses, container };
  }

  it("rendert ein Managed-Widget (interaction-only, dunkel, Deutsch, flexibel, ohne Auto-Wiederholung) und liefert das Token", async () => {
    const { solver, turnstile, statuses, container } = setup();
    const token = solver.solve("session");
    await flush();
    expect(turnstile.renders).toHaveLength(1);
    expect(turnstile.renders[0]?.container).toBe(container);
    expect(turnstile.last()).toMatchObject({
      sitekey: "1x00000000000000000000AA",
      action: "session",
      appearance: "interaction-only",
      theme: "dark",
      language: "de",
      size: "flexible",
      retry: "never",
      "refresh-expired": "never",
    });
    turnstile.last().callback?.("XXXX.DUMMY.TOKEN.XXXX");
    await expect(token).resolves.toBe("XXXX.DUMMY.TOKEN.XXXX");
    expect(turnstile.removed).toEqual(["w1"]);
    expect(statuses).toEqual(["loading", "running", "idle"]);
  });

  it("Bestätigung nötig → Status interactive, danach wieder running", async () => {
    const { solver, turnstile } = setup();
    const token = solver.solve("join");
    await flush();
    turnstile.last()["before-interactive-callback"]?.();
    expect(solver.getStatus()).toBe("interactive");
    turnstile.last()["after-interactive-callback"]?.();
    expect(solver.getStatus()).toBe("running");
    turnstile.last().callback?.("t");
    await expect(token).resolves.toBe("t");
    expect(turnstile.last().action).toBe("join");
  });

  it("Widget-Fehler, Ablauf, nicht bestätigt, nicht unterstützt → null + Status error (Fehler als behandelt gemeldet)", async () => {
    const { solver, turnstile } = setup();
    for (const trigger of [
      (options: TurnstileRenderOptions) => expect(options["error-callback"]?.("110200")).toBe(true),
      (options: TurnstileRenderOptions) => options["expired-callback"]?.(),
      (options: TurnstileRenderOptions) => options["timeout-callback"]?.(),
      (options: TurnstileRenderOptions) => options["unsupported-callback"]?.(),
    ]) {
      const token = solver.solve("session");
      await flush();
      trigger(turnstile.last());
      await expect(token).resolves.toBeNull();
      expect(solver.getStatus()).toBe("error");
    }
    expect(turnstile.removed).toEqual(["w1", "w2", "w3", "w4"]);
  });

  it("Frist abgelaufen → null; späte Rückrufe ändern nichts mehr", async () => {
    const { solver, turnstile } = setup({ solveTimeoutMs: 5_000 });
    const token = solver.solve("session");
    await flush();
    const options = turnstile.last();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(token).resolves.toBeNull();
    options.callback?.("zu-spät");
    options["before-interactive-callback"]?.();
    expect(solver.getStatus()).toBe("error");
  });

  it("Skript nicht ladbar oder kein Container → null + error", async () => {
    const failing = createTurnstileSolver({ siteKey: "k", load: async () => Promise.reject(new Error("offline")) });
    failing.attach({} as HTMLElement);
    await expect(failing.solve("session")).resolves.toBeNull();
    expect(failing.getStatus()).toBe("error");
    const { solver } = setup();
    solver.attach(null);
    await expect(solver.solve("session")).resolves.toBeNull();
    expect(solver.getStatus()).toBe("error");
  });

  it("Lösungen laufen nacheinander: je Token ein eigenes Widget (Tokens gelten nur einmal)", async () => {
    const { solver, turnstile } = setup();
    const first = solver.solve("session");
    const second = solver.solve("join");
    await flush();
    expect(turnstile.renders).toHaveLength(1);
    turnstile.last().callback?.("eins");
    await expect(first).resolves.toBe("eins");
    await flush();
    expect(turnstile.renders).toHaveLength(2);
    turnstile.last().callback?.("zwei");
    await expect(second).resolves.toBe("zwei");
  });

  it("suspend bricht eine laufende Prüfung ab und lehnt weitere ab; resume (z. B. StrictMode) macht sie wieder nutzbar", async () => {
    const { solver, turnstile, load } = setup();
    const running = solver.solve("session");
    await flush();
    solver.suspend();
    await expect(running).resolves.toBeNull();
    expect(solver.getStatus()).toBe("idle");
    expect(turnstile.removed).toEqual(["w1"]);
    await expect(solver.solve("session")).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    solver.resume();
    const again = solver.solve("session");
    await flush();
    turnstile.last().callback?.("wieder");
    await expect(again).resolves.toBe("wieder");
  });
});
