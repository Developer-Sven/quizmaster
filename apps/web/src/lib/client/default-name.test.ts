import { checkName } from "@quizmaster/shared/moderation";
import { describe, expect, it } from "vitest";
import { defaultGuestName, isUsableDefaultDigits } from "./default-name";

/** Zufallsquelle, die nacheinander genau diese Ziffernfolgen liefert (Intervallmitte gegen Rundungsfehler). */
function digitsInOrder(...suffixes: number[]): () => number {
  return () => ((suffixes.shift() ?? 531_204) + 0.5) / 1_000_000;
}

/** Wie der Server Namen prüft (Format, reserviert, Moderation – docs/06). */
function serverAccepts(name: string): boolean {
  return checkName(name).ok;
}

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

describe("defaultGuestName und die Namensprüfung des Servers", () => {
  it("meidet Ziffern, die die Moderation als Wort liest (Leetspeak: 455 → ass, 717 → tit, 55 am Rand)", () => {
    const rejected = [2_455, 12_555, 552_220, 22_255, 2_717, 711_172, 1_488];
    for (const suffix of rejected) expect(serverAccepts(`Gast-${String(suffix).padStart(6, "0")}`)).toBe(false);
    expect(defaultGuestName(digitsInOrder(...rejected))).toBe("Gast-531204");
  });

  it("jeder mögliche Standardname besteht die Prüfung – auch der Notfallname", { timeout: 60_000 }, () => {
    expect(serverAccepts("Gast-123456")).toBe(true);
    // Buchstaben entstehen nur aus 0, 1, 3, 4, 5, 7 (Leetspeak, docs/06): alle 6^6 Folgen daraus vollständig,
    // dazu jede 97. Zahl des ganzen Bereichs. Die volle Prüfung aller 10^6 Folgen lief einmalig (ADR-039).
    const letterDigits = ["0", "1", "3", "4", "5", "7"];
    const candidates: string[] = [];
    for (let n = 0; n < 6 ** 6; n++) {
      let digits = "";
      for (let rest = n, i = 0; i < 6; i++, rest = Math.floor(rest / 6)) digits += letterDigits[rest % 6];
      candidates.push(digits);
    }
    for (let n = 0; n < 1_000_000; n += 97) candidates.push(String(n).padStart(6, "0"));
    const wrong = candidates.filter((digits) => isUsableDefaultDigits(digits) && !serverAccepts(`Gast-${digits}`));
    expect(wrong).toEqual([]);
    expect(candidates.filter(isUsableDefaultDigits).length).toBeGreaterThan(candidates.length / 2);
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
    // Früher erzeugter Standardname, den der Server ablehnt → neuer Standardname, gleich gemerkt.
    data.set("qm.name", "Gast-002455");
    const replaced = rememberedOrDefaultName();
    expect(replaced).toMatch(/^Gast-\d{6}$/);
    expect(replaced).not.toBe("Gast-002455");
    expect(data.get("qm.name")).toBe(replaced);
    vi.unstubAllGlobals();
  });
});
