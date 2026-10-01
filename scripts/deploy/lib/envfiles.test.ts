import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { resolveEnv, type SourceEnv, sourceEnvSchema } from "@quizmaster/shared/env";
import { describe, expect, it } from "vitest";
import { appEnv, renderAppEnvFile, serializeEnv, serializeEnvValue, writeFileAtomic } from "./envfiles.ts";

const secret = (char: string) => char.repeat(43);

function source(overrides: Record<string, string> = {}): SourceEnv {
  return sourceEnvSchema.parse({
    QUIZMASTER_DOMAIN: "quiz.example.com",
    QUIZMASTER_PORT: "7400",
    TLS_CERT_FILE: "/etc/ssl/example/cert.pem",
    TLS_KEY_FILE: "/etc/ssl/example/key.pem",
    TRUSTED_IP_HEADER: "cf-connecting-ip",
    MONGODB_URI: "mongodb://user:p%23ss@db.example.com:27017/?tls=true&tlsCAFile=/etc/ssl/ca.pem",
    MONGODB_DB: "quizmaster",
    SESSION_SECRET: secret("a"),
    REALTIME_TICKET_SECRET: secret("b"),
    IP_HASH_SECRET: secret("c"),
    METRICS_TOKEN: secret("d"),
    BACKUP_PASSPHRASE: secret("e"),
    TURNSTILE_ENABLED: "true",
    TURNSTILE_SITE_KEY: "0x4AAAAAAA-site",
    TURNSTILE_SECRET_KEY: "0x4AAAAAAA-secret",
    ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
    ...overrides,
  });
}

describe("serializeEnvValue", () => {
  it("schreibt unkritische Werte roh (ohne Quotes, ohne Interpolation)", () => {
    expect(serializeEnvValue("A", "mongodb://u:p@h:27017/?tls=true&x=$HOME")).toBe(
      "mongodb://u:p@h:27017/?tls=true&x=$HOME",
    );
    expect(serializeEnvValue("A", "")).toBe("");
  });

  it("quotet Werte mit #, Leerzeichen oder Anführungszeichen so, dass Node sie wörtlich liest", () => {
    for (const value of ["a#b", "mit leerzeichen", 'd"q', "s'q", "b\\s", "`tick` and 'single'", " rand "]) {
      const line = `K=${serializeEnvValue("K", value)}\n`;
      expect(parseEnv(line).K).toBe(value);
    }
  });

  it("lehnt mehrzeilige und unschreibbare Werte ab – ohne den Wert zu nennen", () => {
    expect(() => serializeEnvValue("K", "a\nb")).toThrow(/K: mehrzeilige/);
    expect(() => serializeEnvValue("K", "'\"`")).toThrow(/K: Wert lässt sich nicht/);
    try {
      serializeEnvValue("K", "geheim\ngeheim");
    } catch (error) {
      expect(String(error)).not.toContain("geheim");
    }
    expect(() => serializeEnvValue("lower", "x")).toThrow(/Schlüsselname/);
  });
});

describe("serializeEnv", () => {
  it("prüft per Rücklesen und liefert eine Datei mit Kopfkommentar", () => {
    const text = serializeEnv({ A: "1", B: "x y", C: "#hash" }, ["Kopf"]);
    expect(text.startsWith("# Kopf\n")).toBe(true);
    expect(parseEnv(text)).toEqual({ A: "1", B: "x y", C: "#hash" });
  });
});

describe("appEnv (Least Privilege je App, ADR-022)", () => {
  const resolved = resolveEnv(source(), "prod");
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("Web bekommt Session/Turnstile, aber kein METRICS_TOKEN und keine Backup-Passphrase", () => {
    const env = appEnv(resolved, "web", sha);
    expect(env).toMatchObject({ NODE_ENV: "production", PORT: "7400", HOSTNAME: "127.0.0.1", RELEASE: sha });
    expect(env.SESSION_SECRET).toBe(secret("a"));
    expect(env.TURNSTILE_SECRET_KEY).toBeDefined();
    expect(env.METRICS_TOKEN).toBeUndefined();
    expect(env.BACKUP_PASSPHRASE).toBeUndefined();
    expect(env.ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it("Realtime lauscht auf Port + 1 und bekommt weder Session- noch Turnstile-Secret", () => {
    const env = appEnv(resolved, "realtime", sha);
    expect(env).toMatchObject({ HOST: "127.0.0.1", REALTIME_PORT: "7401", APP_ORIGIN: "https://quiz.example.com" });
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.TURNSTILE_SECRET_KEY).toBeUndefined();
    expect(env.BACKUP_PASSPHRASE).toBeUndefined();
  });

  it("Watchdog kennt weder die Datenbank noch Session-/Ticket-Secrets", () => {
    const env = appEnv(resolved, "watchdog", sha);
    expect(env.WEB_HEALTH_URL).toBe("http://127.0.0.1:7400/api/health");
    expect(env.REALTIME_HEALTH_URL).toBe("http://127.0.0.1:7401/healthz");
    for (const key of ["MONGODB_URI", "SESSION_SECRET", "REALTIME_TICKET_SECRET", "IP_HASH_SECRET"]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("die erzeugte Datei liest Node exakt so zurück (inkl. RELEASE, URI mit %23)", () => {
    const text = renderAppEnvFile(resolved, "realtime", sha, ".env.prod");
    expect(parseEnv(text)).toEqual(appEnv(resolved, "realtime", sha));
    expect(text).toContain("aus .env.prod (Release 0123456789ab)");
  });
});

describe("writeFileAtomic", () => {
  const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  it("setzt Rechte und Gruppe, bevor die Datei ihren Namen bekommt; Verzeichnis wird angeglichen", () => {
    const base = mkdtempSync(join(tmpdir(), "qm-envfile-test-"));
    try {
      const file = join(base, "env", "web.env");
      writeFileAtomic(file, "A=1\n", { ...me, dirMode: 0o750, fileMode: 0o640 });
      expect(readFileSync(file, "utf8")).toBe("A=1\n");
      expect(statSync(file).mode & 0o777).toBe(0o640);
      expect(statSync(join(base, "env")).mode & 0o777).toBe(0o750);
      writeFileAtomic(file, "A=2\n");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("scheitert das Schreiben, bleibt keine temporäre Kopie (womöglich mit Secrets) liegen", () => {
    const base = mkdtempSync(join(tmpdir(), "qm-envfile-test-"));
    try {
      const file = join(base, "web.env");
      expect(() => writeFileAtomic(file, "SECRET=x\n", { ...me, dirMode: 0o700, fileMode: -1 })).toThrow();
      expect(readdirSync(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
