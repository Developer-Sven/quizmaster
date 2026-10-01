import { PHASES, type Phase } from "@quizmaster/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SKIP_WAITING } from "../../sw/protocol";
import {
  type ContainerLike,
  createUpdateController,
  type RegistrationLike,
  registrationPlan,
  statusBannerKind,
  UPDATE_RELOAD_FALLBACK_MS,
  updateBannerAllowed,
  type WorkerLike,
} from "./service-worker";
import { UpdateBanner } from "./update-banner";

class FakeWorker extends EventTarget implements WorkerLike {
  state = "installing";
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  moveTo(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;

  async update(): Promise<void> {}

  /** Browser findet eine neue Version: `installing` + `updatefound`, nach dem Install wartet sie. */
  findUpdate(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
    return worker;
  }

  finishInstall(worker: FakeWorker): void {
    this.installing = null;
    this.waiting = worker;
    worker.moveTo("installed");
  }
}

class FakeContainer extends EventTarget implements ContainerLike {
  readonly controller: unknown;

  constructor(controller: unknown) {
    super();
    this.controller = controller;
  }

  async register(): Promise<RegistrationLike> {
    return new FakeRegistration();
  }

  async getRegistrations(): Promise<readonly { unregister(): Promise<boolean> }[]> {
    return [];
  }
}

function setup(controller: unknown = { state: "activated" }) {
  const reload = vi.fn();
  const timers: (() => void)[] = [];
  const setTimer = vi.fn((callback: () => void, ms: number) => {
    expect(ms).toBe(UPDATE_RELOAD_FALLBACK_MS);
    timers.push(callback);
  });
  const updates = createUpdateController({ reload, setTimer });
  const registration = new FakeRegistration();
  const container = new FakeContainer(controller);
  const changes = vi.fn();
  updates.subscribe(changes);
  return { updates, registration, container, reload, timers, changes };
}

describe("Update-Fluss (docs/10)", () => {
  it("meldet beim ersten Install kein Update (noch keine ältere Version steuert die Seite)", () => {
    const { updates, registration, container } = setup(null);
    updates.watch(registration, container);
    registration.finishInstall(registration.findUpdate());
    expect(updates.isWaiting()).toBe(false);
    // clientsClaim übernimmt die Seite → controllerchange, aber kein Reload
    updates.handleControllerChange();
  });

  it("meldet eine neue, wartende Version und benachrichtigt Abonnenten", () => {
    const { updates, registration, container, changes } = setup();
    updates.watch(registration, container);
    const next = registration.findUpdate();
    expect(updates.isWaiting()).toBe(false);
    registration.finishInstall(next);
    expect(updates.isWaiting()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("erkennt eine schon wartende Version beim Registrieren (früherer Besuch)", () => {
    const { updates, registration, container } = setup();
    const waiting = new FakeWorker();
    waiting.state = "installed";
    registration.waiting = waiting;
    updates.watch(registration, container);
    expect(updates.isWaiting()).toBe(true);
  });

  it("„Aktualisieren“: SKIP_WAITING an den wartenden SW, Reload erst nach controllerchange – genau einmal", () => {
    const { updates, registration, container, reload, timers } = setup();
    updates.watch(registration, container);
    const next = registration.findUpdate();
    registration.finishInstall(next);

    updates.applyUpdate();
    expect(next.messages).toEqual([{ type: SKIP_WAITING }]);
    expect(reload).not.toHaveBeenCalled();

    next.moveTo("activated");
    updates.handleControllerChange();
    updates.handleControllerChange();
    timers.forEach((timer) => {
      timer();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(updates.isWaiting()).toBe(false);
  });

  it("lädt nach Frist trotzdem neu, wenn controllerchange ausbleibt", () => {
    const { updates, registration, container, reload, timers } = setup();
    updates.watch(registration, container);
    registration.finishInstall(registration.findUpdate());
    updates.applyUpdate();
    expect(timers).toHaveLength(1);
    timers[0]?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ohne wartenden SW (z. B. UPDATE_REQUIRED) lädt „Aktualisieren“ einfach neu", () => {
    const { updates, reload, timers } = setup();
    updates.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
  });

  it("verwirft das Angebot, wenn ein anderer Tab aktualisiert hat oder die Version verworfen wurde", () => {
    const { updates, registration, container, reload } = setup();
    updates.watch(registration, container);
    const first = registration.findUpdate();
    registration.finishInstall(first);
    first.moveTo("activated");
    expect(updates.isWaiting()).toBe(false);
    // controllerchange aus dem anderen Tab: hier kein Reload (niemand hat „Aktualisieren“ getippt)
    updates.handleControllerChange();
    expect(reload).not.toHaveBeenCalled();

    const second = registration.findUpdate();
    registration.finishInstall(second);
    second.moveTo("redundant");
    expect(updates.isWaiting()).toBe(false);
  });

  it("folgt einer noch neueren Version, ohne dass die alte das Banner zurücksetzt", () => {
    const { updates, registration, container } = setup();
    updates.watch(registration, container);
    const older = registration.findUpdate();
    registration.finishInstall(older);
    const newer = registration.findUpdate();
    registration.finishInstall(newer);
    older.moveTo("redundant");
    expect(updates.isWaiting()).toBe(true);
    updates.applyUpdate();
    expect(newer.messages).toEqual([{ type: SKIP_WAITING }]);
    expect(older.messages).toEqual([]);
  });
});

describe("Update-Banner je Phase (nie im laufenden Spiel)", () => {
  const running = PHASES.filter((phase) => phase !== "lobby" && phase !== "game_over");

  it("erlaubt das Banner auf Start (keine Lobby), in der Lobby und ab game_over", () => {
    expect(updateBannerAllowed(null)).toBe(true);
    expect(updateBannerAllowed("lobby")).toBe(true);
    expect(updateBannerAllowed("game_over")).toBe(true);
  });

  it("unterdrückt es in jeder laufenden Spielphase", () => {
    expect(running).toEqual(["intro", "category_pick", "question", "reveal", "turn_summary", "round_board"]);
    for (const phase of running) expect(updateBannerAllowed(phase), phase).toBe(false);
  });

  it("zeigt höchstens ein Banner: Update vor Wartung, UPDATE_REQUIRED immer", () => {
    const kind = (
      phase: Phase | null,
      flags: Partial<Record<"updateRequired" | "updateWaiting" | "maintenance", boolean>>,
    ) => statusBannerKind({ updateRequired: false, updateWaiting: false, maintenance: false, phase, ...flags });

    for (const phase of [null, ...PHASES] as const) {
      expect(kind(phase, {}), String(phase)).toBeNull();
      expect(kind(phase, { updateRequired: true }), String(phase)).toBe("update");
      expect(kind(phase, { maintenance: true }), String(phase)).toBe("maintenance");
      expect(kind(phase, { updateWaiting: true }), String(phase)).toBe(updateBannerAllowed(phase) ? "update" : null);
      expect(kind(phase, { updateWaiting: true, maintenance: true }), String(phase)).toBe(
        updateBannerAllowed(phase) ? "update" : "maintenance",
      );
    }
  });
});

describe("Registrierung", () => {
  it("nur in Produktion, in next dev nur per Flag (ohne Next-Cache), sonst aufräumen", () => {
    expect(registrationPlan({ production: true, devFlag: false })).toEqual({ kind: "register", url: "/sw.js" });
    expect(registrationPlan({ production: true, devFlag: true })).toEqual({ kind: "register", url: "/sw.js" });
    expect(registrationPlan({ production: false, devFlag: true })).toEqual({ kind: "register", url: "/sw.js?dev" });
    expect(registrationPlan({ production: false, devFlag: false })).toEqual({ kind: "unregister" });
  });
});

describe("UpdateBanner", () => {
  it("bleibt ohne wartende Version leer und zeigt bei UPDATE_REQUIRED „Neue Version verfügbar“ + „Aktualisieren“", () => {
    expect(renderToStaticMarkup(createElement(UpdateBanner))).toBe("");
    const html = renderToStaticMarkup(createElement(UpdateBanner, { required: true }));
    expect(html).toContain('data-testid="update-banner"');
    expect(html).toContain("Neue Version verfügbar");
    expect(html).toMatch(/<button[^>]*>.*Aktualisieren/);
  });
});
