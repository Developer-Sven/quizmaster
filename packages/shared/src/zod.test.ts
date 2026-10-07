/**
 * zod-Fassade (zod.ts): englische Meldungen, keine Namespace-/Locale-Re-Exporte und kein direkter `zod`-Import in
 * den client-erreichbaren Modulen des Haupt-Exports – sonst landen wieder alle ~40 Locales im Lobby-Chunk (Messung
 * im Bundle-Review: 89,9 → 31,6 KB gzip).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as facade from "./zod.ts";

const SRC = import.meta.dirname;

/** Module des Haupt-Exports (`index.ts` re-exportiert sie) – client-erreichbar. */
function clientModules(): string[] {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  return [...index.matchAll(/export \* from "\.\/([a-z-]+)\.ts";/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

describe("zod-Fassade", () => {
  it("liefert die genutzten Bausteine mit englischen Meldungen", () => {
    const schema = facade.strictObject({ name: facade.string().max(3), kind: facade.enum(["a", "b"]) });
    const tooLong = schema.safeParse({ name: "abcd", kind: "a" });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toMatch(/^Too big/);
    expect(schema.safeParse({ name: "ab", kind: "a", extra: 1 }).error?.issues[0]?.code).toBe("unrecognized_keys");
    expect(facade.null().safeParse(null).success).toBe(true);
    expect(facade.uuid().safeParse("nicht-uuid").success).toBe(false);
  });

  it("re-exportiert weder den Namespace noch Locales oder die globale Konfiguration", () => {
    const names = Object.keys(facade);
    for (const forbidden of ["z", "default", "locales", "config", "core"]) expect(names).not.toContain(forbidden);
    expect(names.length).toBeLessThan(30);
  });

  it("wird von allen client-erreichbaren Modulen statt `zod` verwendet", () => {
    const modules = clientModules();
    expect(modules).toEqual(expect.arrayContaining(["ack", "events", "schemas", "primitives"]));
    const offenders = modules.filter((name) =>
      /from "zod(\/[a-z]+)?"/.test(readFileSync(join(SRC, `${name}.ts`), "utf8")),
    );
    expect(offenders).toEqual([]);
    // Nur die Fassade selbst importiert zod (Tests und server-only Unterpfade ausgenommen).
    const direct = readdirSync(SRC).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        file !== "zod.ts" &&
        /from "zod"/.test(readFileSync(join(SRC, file), "utf8")),
    );
    expect(direct).toEqual([]);
  });
});
