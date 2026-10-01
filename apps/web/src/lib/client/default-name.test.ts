import { describe, expect, it } from "vitest";
import { defaultGuestName } from "./default-name";

describe("defaultGuestName (ADR-039)", () => {
  it("liefert „Gast-“ und 6 Ziffern, auch mit führenden Nullen", () => {
    expect(defaultGuestName(() => 0.000_042)).toBe("Gast-000042");
    expect(defaultGuestName(() => 0.427_153)).toBe("Gast-427153");
    for (let i = 0; i < 200; i++) expect(defaultGuestName()).toMatch(/^Gast-\d{6}$/);
  });

  it("meidet „88“ (NS-Codes wie 1488 sperrt die Moderation) und gibt nie auf", () => {
    const values = [0.148_812, 0.88, 0.531_204];
    expect(defaultGuestName(() => values.shift() ?? 0.5)).toBe("Gast-531204");
    expect(defaultGuestName(() => 0.888_888)).toBe("Gast-123456");
  });
});

describe("rememberedOrDefaultName", () => {
  it("nimmt den gemerkten Namen, sonst einen neuen Standardnamen und merkt ihn sich", async () => {
    const { vi } = await import("vitest");
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
      },
    });
    const { rememberedOrDefaultName } = await import("./default-name");
    const first = rememberedOrDefaultName();
    expect(first).toMatch(/^Gast-\d{6}$/);
    expect(rememberedOrDefaultName()).toBe(first);
    data.set("qm.name", "Mia");
    expect(rememberedOrDefaultName()).toBe("Mia");
    vi.unstubAllGlobals();
  });
});
