/**
 * Lobby-Mitgliedschaft im Speicher (lib/client/storage.ts): `/lobby/<code>` darf nur dann ohne Verbindung zur
 * Beitreten-Seite, wenn sicher feststeht, dass hier kein Mitglied ankommt – also nur mit funktionierendem Speicher
 * (lesen UND schreiben). Sonst entschiede ein vergessener Merker (privater Modus, volles Kontingent, gesperrte
 * Website-Daten) gegen ein echtes Mitglied, und es käme nach jedem Beitritt wieder auf die Beitreten-Seite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isKnownNonMember, readMembership, writeMembership } from "./storage";

function memoryStorage(options: { failWrites?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.failWrites) throw new DOMException("Kontingent überschritten", "QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isKnownNonMember (Erstaufruf von /lobby/<code>)", () => {
  it("funktionierender Speicher ohne bzw. mit anderer Mitgliedschaft → sicher kein Mitglied", () => {
    const store = memoryStorage();
    vi.stubGlobal("window", { localStorage: store });
    expect(isKnownNonMember("ABC234")).toBe(true);
    writeMembership("XYZ789");
    expect(isKnownNonMember("ABC234")).toBe(true);
    // Die Prüfung hinterlässt nichts außer der Mitgliedschaft selbst.
    expect([...store.data.keys()]).toEqual(["qm.lobby"]);
  });

  it("gemerkte Mitgliedschaft für genau diesen Code → Mitglied (Lobby laden)", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    writeMembership("ABC234");
    expect(readMembership()).toBe("ABC234");
    expect(isKnownNonMember("ABC234")).toBe(false);
  });

  it("Speicher nicht beschreibbar oder gar nicht erreichbar → unbekannt (der Server entscheidet)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("window", { localStorage: memoryStorage({ failWrites: true }) });
    expect(isKnownNonMember("ABC234")).toBe(false);

    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("Website-Daten gesperrt", "SecurityError");
      },
    });
    expect(isKnownNonMember("ABC234")).toBe(false);
  });

  it("auf dem Server (kein window) → unbekannt", () => {
    expect(isKnownNonMember("ABC234")).toBe(false);
  });
});
