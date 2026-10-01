import { describe, expect, it } from "vitest";
import {
  createWakeLockController,
  type VisibilitySource,
  type WakeLockLike,
  type WakeLockSentinelLike,
} from "./wake-lock";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Seite mit umschaltbarer Sichtbarkeit (wie `document`). */
class FakeDocument implements VisibilitySource {
  visibilityState = "visible";
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }
  setVisibility(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: "release", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "release", listener: () => void): void {
    this.listeners.delete(listener);
  }
  async release(): Promise<void> {
    this.released = true;
  }
  /** Der Browser gibt die Sperre selbst frei (Seite verborgen). */
  systemRelease(): void {
    this.released = true;
    for (const listener of [...this.listeners]) listener();
  }
}

function setup(options: { fail?: boolean; supported?: boolean } = {}) {
  const sentinels: FakeSentinel[] = [];
  const warnings: string[] = [];
  const document = new FakeDocument();
  let requests = 0;
  const wakeLock: WakeLockLike = {
    async request() {
      requests += 1;
      if (options.fail) throw new DOMException("denied", "NotAllowedError");
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    },
  };
  const controller = createWakeLockController({
    wakeLock: options.supported === false ? null : wakeLock,
    document,
    warn: (message) => warnings.push(message),
  });
  return { controller, document, sentinels, warnings, requests: () => requests };
}

describe("Wake Lock während des Spiels (docs/10 §App-Gefühl)", () => {
  it("fordert die Sperre an, solange das Spiel läuft, und gibt sie beim Verlassen frei", async () => {
    const { controller, sentinels, requests } = setup();
    controller.setActive(true);
    controller.setActive(true);
    await flush();
    expect(requests()).toBe(1);
    expect(controller.held).toBe(true);
    controller.setActive(false);
    expect(controller.held).toBe(false);
    expect(sentinels[0]?.released).toBe(true);
  });

  it("fordert nach der Rückkehr in den Vordergrund (visibilitychange) erneut an", async () => {
    const { controller, document, sentinels, requests } = setup();
    controller.setActive(true);
    await flush();
    document.setVisibility("hidden");
    sentinels[0]?.systemRelease();
    expect(controller.held).toBe(false);
    document.setVisibility("visible");
    await flush();
    expect(requests()).toBe(2);
    expect(controller.held).toBe(true);
  });

  it("fordert bei verborgener Seite nicht an und nach dem Aufräumen gar nicht mehr", async () => {
    const { controller, document, requests } = setup();
    document.visibilityState = "hidden";
    controller.setActive(true);
    await flush();
    expect(requests()).toBe(0);
    controller.dispose();
    expect(document.listenerCount).toBe(0);
    document.setVisibility("visible");
    await flush();
    expect(requests()).toBe(0);
  });

  it("gibt eine Sperre sofort zurück, die erst nach dem Spielende ankommt", async () => {
    const { controller, sentinels } = setup();
    controller.setActive(true);
    controller.setActive(false);
    await flush();
    expect(sentinels[0]?.released).toBe(true);
    expect(controller.held).toBe(false);
  });

  it("läuft ohne API weiter und meldet eine Ablehnung (Energiesparmodus) als Hinweis", async () => {
    const unsupported = setup({ supported: false });
    unsupported.controller.setActive(true);
    await flush();
    expect(unsupported.controller.held).toBe(false);

    const denied = setup({ fail: true });
    denied.controller.setActive(true);
    await flush();
    expect(denied.controller.held).toBe(false);
    expect(denied.warnings).toEqual(["Bildschirmsperre nicht verhindert: NotAllowedError"]);
  });
});
