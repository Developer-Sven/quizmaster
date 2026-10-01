import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appConfigPatchSchema } from "@quizmaster/db";
import { defaultAppConfig } from "@quizmaster/shared/documents";
import { ipKey } from "@quizmaster/shared/ip";
import { afterAll, describe, expect, it } from "vitest";
import {
  AdminUsageError,
  assertWriteAllowed,
  banExpiry,
  banTarget,
  describeConfig,
  parseConfigAssignments,
  updateBlockedTerms,
} from "./admin.ts";

const SECRET = "s".repeat(40);

describe("parseConfigAssignments", () => {
  it("Kill-Switches → Patch, den das Repository akzeptiert", () => {
    const patch = parseConfigAssignments(["lobbyCreationEnabled=false", "turnstileOnJoin=on", "maxActiveLobbies=500"]);
    expect(patch).toEqual({ lobbyCreationEnabled: false, turnstileOnJoin: true, maxActiveLobbies: 500 });
    expect(appConfigPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("Wartung mit Meldung; beim Ausschalten wird die Meldung entfernt", () => {
    expect(parseConfigAssignments(["maintenance=on", "maintenanceMessage= Kurze Wartung "])).toEqual({
      maintenance: { enabled: true, message: "Kurze Wartung" },
    });
    expect(parseConfigAssignments(["maintenance=off"])).toEqual({ maintenance: { enabled: false, message: null } });
  });

  it("lehnt Unbekanntes, falsche Typen und leere Aufrufe ab", () => {
    expect(() => parseConfigAssignments(["lobbyCreation=false"])).toThrow(/unbekannter Schlüssel/);
    expect(() => parseConfigAssignments(["maxActiveLobbies=-1"])).toThrow(/ganze Zahl/);
    expect(() => parseConfigAssignments(["turnstileOnJoin=vielleicht"])).toThrow(/true\/false/);
    expect(() => parseConfigAssignments(["maintenanceMessage=x"])).toThrow(/nur zusammen/);
    expect(() => parseConfigAssignments(["kein-gleich"])).toThrow(AdminUsageError);
    expect(() => parseConfigAssignments([])).toThrow(/mindestens eine/);
  });
});

describe("updateBlockedTerms", () => {
  it("ergänzt ohne Dubletten (Groß-/Kleinschreibung egal) und entfernt", () => {
    expect(updateBlockedTerms(["Troll"], "add", ["troll", "spam", "spam"])).toEqual(["Troll", "spam"]);
    expect(updateBlockedTerms(["Troll", "spam"], "remove", ["TROLL"])).toEqual(["spam"]);
    expect(() => updateBlockedTerms([], "add", [" "])).toThrow(/mindestens einen/);
    expect(() => updateBlockedTerms([], "list", ["x"])).toThrow(/add oder remove/);
  });
});

describe("banTarget", () => {
  it("IP-Sperren speichern denselben HMAC-Schlüssel wie Web/Realtime, nie die IP", () => {
    const target = banTarget({ ip: "203.0.113.7" }, SECRET);
    expect(target).toMatchObject({ kind: "ip", value: ipKey("203.0.113.7", SECRET) });
    expect(target.value).not.toContain("203.0.113.7");
    // IPv6: ganzes /64 (Angreifer rotieren darin).
    expect(banTarget({ ip: "2001:db8:1:2::99" }, SECRET).value).toBe(
      banTarget({ ip: "2001:db8:1:2::1" }, SECRET).value,
    );
  });

  it("Gast per UUID, genau ein Ziel, gültige Werte", () => {
    const guest = "0d9c2b7e-1f0a-4c3b-9d2e-5a6b7c8d9e0f";
    expect(banTarget({ guest: guest.toUpperCase() }, SECRET)).toMatchObject({ kind: "guest", value: guest });
    expect(() => banTarget({}, SECRET)).toThrow(/genau eines/);
    expect(() => banTarget({ guest, ip: "1.2.3.4" }, SECRET)).toThrow(/genau eines/);
    expect(() => banTarget({ guest: "abc" }, SECRET)).toThrow(/UUID/);
    expect(() => banTarget({ ip: "999.1.1.1" }, SECRET)).toThrow(/keine gültige/);
  });
});

describe("banExpiry, assertWriteAllowed, describeConfig", () => {
  it("Dauer in Stunden, Produktion nur mit Bestätigung, Zusammenfassung ohne Blockliste", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(banExpiry("24", now)?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(banExpiry(undefined, now)).toBeUndefined();
    expect(() => banExpiry("0", now)).toThrow(/1 bis 8784/);
    expect(() => assertWriteAllowed("quizmaster", false)).toThrow(/--confirm-prod/);
    expect(() => assertWriteAllowed("quizmaster", true)).not.toThrow();
    expect(() => assertWriteAllowed("quizmaster_dev", false)).not.toThrow();
    const lines = describeConfig({ ...defaultAppConfig(now), blockedTerms: ["geheimbegriff"] });
    expect(lines.join("\n")).toContain("blockedTerms          1 Begriffe");
    expect(lines.join("\n")).not.toContain("geheimbegriff");
  });
});

describe("admin.ts (CLI)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-admin-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, "prod.env");
  writeFileSync(
    env,
    [
      "MONGODB_URI=mongodb://user:geheimes-passwort@127.0.0.1:1/?tls=true",
      "MONGODB_DB=quizmaster",
      `SESSION_SECRET=${"a".repeat(40)}`,
      `REALTIME_TICKET_SECRET=${"b".repeat(40)}`,
      `IP_HASH_SECRET=${"c".repeat(40)}`,
      `METRICS_TOKEN=${"d".repeat(40)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const cli = (...args: string[]) =>
    new Promise<{ code: number; output: string }>((done) => {
      execFile(
        process.execPath,
        [resolve(import.meta.dirname, "..", "admin.ts"), ...args, "--env-file", env],
        { timeout: 30_000 },
        (error, stdout, stderr) =>
          done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: stdout + stderr }),
      );
    });

  it("bricht vor jeder Verbindung ab: ungültige Zuweisung, fehlende Bestätigung, fehlender Grund", async () => {
    const invalid = await cli("config", "set", "lobbyCreation=false", "--confirm-prod");
    expect(invalid).toMatchObject({ code: 2 });
    expect(invalid.output).toContain("unbekannter Schlüssel lobbyCreation");

    const unconfirmed = await cli("ban", "add", "--ip", "203.0.113.7", "--reason", "Flut");
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.output).toContain("nur mit --confirm-prod");

    const noReason = await cli("ban", "add", "--ip", "203.0.113.7", "--confirm-prod");
    expect(noReason.output).toContain("--reason fehlt");
    for (const result of [invalid, unconfirmed, noReason]) expect(result.output).not.toContain("geheimes-passwort");
  });
});
