import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSource } from "./source-env.ts";

const secret = (char: string) => char.repeat(43);
const base = {
  QUIZMASTER_DOMAIN: "quiz.example.com",
  TRUSTED_IP_HEADER: "cf-connecting-ip",
  MONGODB_URI: "mongodb://u:p@db.example.com:27017/?tls=true",
  SESSION_SECRET: secret("a"),
  REALTIME_TICKET_SECRET: secret("b"),
  IP_HASH_SECRET: secret("c"),
  METRICS_TOKEN: secret("d"),
};
const prod = {
  ...base,
  QUIZMASTER_PORT: "7400",
  MONGODB_DB: "quizmaster",
  TLS_CERT_FILE: "/etc/ssl/example/cert.pem",
  TLS_KEY_FILE: "/etc/ssl/example/key.pem",
  BACKUP_PASSPHRASE: secret("e"),
};

const dirs: string[] = [];
function root(files: Record<string, Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-source-env-"));
  dirs.push(dir);
  for (const [name, entries] of Object.entries(files)) {
    const text = Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    writeFileSync(join(dir, name), `${text}\n`, { mode: 0o600 });
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadSource", () => {
  it("Produktion: .env.prod nach Prod-Regeln, Apps als Produktions-Build", () => {
    const source = loadSource(root({ ".env.prod": prod }), null);
    expect(source).toMatchObject({ mode: "prod", label: ".env.prod" });
    expect(source.resolved).toMatchObject({ webPort: 7400, realtimePort: 7401, appOrigin: "https://quiz.example.com" });
  });

  it("Produktion: Regelverstöße brechen ab und nennen nur Codes", () => {
    const dir = root({ ".env.prod": { ...prod, MONGODB_DB: "quizmaster_dev" } });
    expect(() => loadSource(dir, null)).toThrow(/DB_NAME/);
  });

  it("zu offene Rechte werden abgelehnt", () => {
    const dir = root({ ".env.prod": prod });
    chmodSync(join(dir, ".env.prod"), 0o644);
    expect(() => loadSource(dir, null)).toThrow(/für andere lesbar/);
  });

  it("Testmodus: nur *_test-Datenbanken und nie die Ports aus .env.prod", () => {
    const test = {
      ...base,
      QUIZMASTER_PORT: "7490",
      MONGODB_DB: "quizmaster_test",
      MONGODB_COLLECTION_PREFIX: "t2610010100_abcdef_",
    };
    const dir = root({ ".env.prod": prod, "test.env": test });
    const source = loadSource(dir, join(dir, "test.env"));
    expect(source).toMatchObject({ mode: "test", label: "test.env" });
    expect(source.resolved).toMatchObject({ webPort: 7490, realtimePort: 7491, target: "prod" });

    writeFileSync(
      join(dir, "dev.env"),
      `${Object.entries({ ...test, MONGODB_DB: "quizmaster_dev", MONGODB_COLLECTION_PREFIX: "" })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    expect(() => loadSource(dir, join(dir, "dev.env"))).toThrow(/TEST_DB/);

    writeFileSync(
      join(dir, "ports.env"),
      `${Object.entries({ ...test, QUIZMASTER_PORT: "7399" })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    expect(() => loadSource(dir, join(dir, "ports.env"))).toThrow(/TEST_PORTS/);
  });
});
