import { afterEach, describe, expect, it, vi } from "vitest";

/** Minimaler Image-Ersatz (Node-Testumgebung ohne DOM). */
class FakeImage {
  static created: FakeImage[] = [];
  static fail = false;
  decoding = "auto";
  src = "";
  constructor() {
    FakeImage.created.push(this);
  }
  decode(): Promise<void> {
    return FakeImage.fail ? Promise.reject(new Error("decode")) : Promise.resolve();
  }
}

async function load() {
  vi.resetModules();
  vi.stubGlobal("window", {});
  vi.stubGlobal("Image", FakeImage);
  return import("./flag-preload");
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeImage.created = [];
  FakeImage.fail = false;
});

describe("preloadFlag", () => {
  it("lädt jede gültige Flagge einmal und ignoriert andere Medien", async () => {
    const { preloadFlag, flagUrl } = await load();
    preloadFlag({ kind: "flag", code: "de" });
    preloadFlag({ kind: "flag", code: "de" });
    preloadFlag({ kind: "flag", code: "gb-sct" });
    preloadFlag(null);
    preloadFlag(undefined);
    preloadFlag({ kind: "flag", code: "../../etc" });
    expect(FakeImage.created.map((image) => image.src)).toEqual([flagUrl("de"), flagUrl("gb-sct")]);
    expect(FakeImage.created[0]?.decoding).toBe("async");
  });

  it("gibt die Flagge nach einem Fehler für einen neuen Versuch frei", async () => {
    const { preloadFlag } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    FakeImage.fail = true;
    preloadFlag({ kind: "flag", code: "fr" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    FakeImage.fail = false;
    preloadFlag({ kind: "flag", code: "fr" });
    expect(FakeImage.created).toHaveLength(2);
  });
});
