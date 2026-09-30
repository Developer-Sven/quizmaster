import { describe, expect, it } from "vitest";
import {
  authSourceFromTxt,
  collectionOf,
  mongoToolsConfig,
  parseDumpLog,
  parseRestoreLog,
  restorePrefix,
  restorePrefixDate,
  srvHost,
  withExplicitAuthSource,
} from "./mongo-tools.ts";

describe("withExplicitAuthSource", () => {
  it("ergänzt authSource=admin wie der Node-Treiber (TLS-Parameter bleiben erhalten)", () => {
    expect(withExplicitAuthSource("mongodb://u:p@db.example.com:27017/?tls=true&tlsCAFile=%2Fetc%2Fssl%2Fca.pem")).toBe(
      "mongodb://u:p@db.example.com:27017/?tls=true&tlsCAFile=%2Fetc%2Fssl%2Fca.pem&authSource=admin",
    );
    expect(withExplicitAuthSource("mongodb://u:p@h1:27017,h2:27017")).toBe(
      "mongodb://u:p@h1:27017,h2:27017/?authSource=admin",
    );
  });

  it("nimmt die Datenbank aus dem URI-Pfad, sonst den TXT-Wert einer SRV-URI", () => {
    expect(withExplicitAuthSource("mongodb://u:p@h/appdb?tls=true")).toBe(
      "mongodb://u:p@h/appdb?tls=true&authSource=appdb",
    );
    expect(withExplicitAuthSource("mongodb+srv://u:p@cluster.example.net/", "admin")).toBe(
      "mongodb+srv://u:p@cluster.example.net/?authSource=admin",
    );
  });

  it("lässt vorhandenes authSource, fehlende Zugangsdaten und externe Verfahren unverändert", () => {
    const explicit = "mongodb://u:p@h/?authSource=other&tls=true";
    expect(withExplicitAuthSource(explicit)).toBe(explicit);
    expect(withExplicitAuthSource("mongodb://127.0.0.1:27017/?replicaSet=rs0")).toBe(
      "mongodb://127.0.0.1:27017/?replicaSet=rs0",
    );
    const x509 = "mongodb://CN%3Dclient@h/?authMechanism=MONGODB-X509&tls=true";
    expect(withExplicitAuthSource(x509)).toBe(x509);
    expect(withExplicitAuthSource("mongodb://u:p@h/?authMechanism=SCRAM-SHA-256")).toBe(
      "mongodb://u:p@h/?authMechanism=SCRAM-SHA-256&authSource=admin",
    );
  });

  it("lehnt Unsinn ab, ohne die Eingabe zu wiederholen", () => {
    expect(() => withExplicitAuthSource("postgres://u:geheim@h")).toThrow(/keine gültige/);
    try {
      withExplicitAuthSource("postgres://u:geheim@h");
    } catch (error) {
      expect(String(error)).not.toContain("geheim");
    }
  });
});

describe("SRV/TXT", () => {
  it("liest Host und authSource", () => {
    expect(srvHost("mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true")).toBe("cluster0.abc.mongodb.net");
    expect(srvHost("mongodb://h:27017")).toBeNull();
    expect(authSourceFromTxt([["authSource=admin&replicaSet=atlas-x"]])).toBe("admin");
    expect(authSourceFromTxt([["replicaSet=rs0"]])).toBeNull();
  });
});

describe("mongoToolsConfig", () => {
  it("erzeugt YAML mit einem sicher gequoteten Wert", () => {
    expect(mongoToolsConfig('mongodb://u:p"#@h/')).toBe('uri: "mongodb://u:p\\"#@h/"\n');
  });
});

describe("Logs der Mongo-Tools", () => {
  it("mongodump: Dokumente je Namespace", () => {
    const log = [
      "2026-10-01T03:30:01.100+0200\twriting `quizmaster.questions` to archive on stdout",
      "2026-10-01T03:30:02.200+0200\tdone dumping `quizmaster.questions` (22472 documents)",
      "2026-10-01T03:30:02.210+0200\tdone dumping `quizmaster.appConfig` (1 document)",
    ].join("\n");
    expect(Object.fromEntries(parseDumpLog(log))).toEqual({ "quizmaster.questions": 22472, "quizmaster.appConfig": 1 });
  });

  it("mongorestore: Dokumente, Fehler und Summe", () => {
    const log = [
      "2026-10-01T04:30:00.000+0200\tfinished restoring `quizmaster_test.rt261001023000_questions` (22472 documents, 0 failures)",
      "2026-10-01T04:30:00.000+0200\tfinished restoring `quizmaster_test.rt261001023000_appConfig` (1 document, 0 failures)",
      "2026-10-01T04:30:01.000+0200\t22473 document(s) restored successfully. 0 document(s) failed to restore.",
    ].join("\n");
    const summary = parseRestoreLog(log);
    expect(summary.restored).toBe(22473);
    expect(summary.failed).toBe(0);
    expect(summary.collections.get("quizmaster_test.rt261001023000_appConfig")).toEqual({ documents: 1, failures: 0 });
  });

  it("collectionOf trennt nur die passende Datenbank ab", () => {
    expect(collectionOf("quizmaster.guests", "quizmaster")).toBe("guests");
    expect(collectionOf("quizmaster_test.guests", "quizmaster")).toBeNull();
  });
});

describe("Restore-Präfix", () => {
  it("rt + UTC yymmddHHMMSS + _ und zurück", () => {
    const date = new Date("2026-10-01T02:30:05Z");
    const prefix = restorePrefix(date);
    expect(prefix).toBe("rt261001023005_");
    expect(restorePrefixDate(prefix)?.toISOString()).toBe("2026-10-01T02:30:05.000Z");
    expect(restorePrefixDate("t2609301812_ab12cd_")).toBeNull();
  });
});
