import { describe, expect, it } from "vitest";
import { config, z } from "zod";

describe("instrumentation-client", () => {
  it("schaltet zod in den jitless-Modus (keine eval-Probe unter der CSP) – ohne zod selbst zu importieren", async () => {
    expect(config().jitless).not.toBe(true);
    await import("./instrumentation-client");
    // Dasselbe Konfigurationsobjekt, das `z.config()` liest und ändert.
    expect(config().jitless).toBe(true);
    // Objekt-Schemas funktionieren weiterhin – nur ohne per eval erzeugten Parser.
    const schema = z.strictObject({ code: z.string().length(6) });
    expect(schema.safeParse({ code: "ABC234" }).success).toBe(true);
    expect(schema.safeParse({ code: "ABC234", extra: true }).success).toBe(false);
  });
});
