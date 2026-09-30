import { describe, expect, it } from "vitest";
import { assessPrivileges, type Privilege, REQUIRED_ACTIONS } from "./privileges.ts";

const READ_WRITE = [
  ...REQUIRED_ACTIONS,
  "collStats",
  "convertToCapped",
  "dbHash",
  "dbStats",
  "dropCollection",
  "dropIndex",
  "killCursors",
  "listCollections",
  "listIndexes",
  "renameCollectionSameDB",
];

const readWrite = (db: string): Privilege => ({ resource: { db, collection: "" }, actions: [...READ_WRITE] });

describe("assessPrivileges (env:check --connect, Least Privilege docs/04)", () => {
  it("readWrite auf genau den erwarteten Datenbanken ist ok", () => {
    const report = assessPrivileges(
      [readWrite("quizmaster_dev"), readWrite("quizmaster_test")],
      ["quizmaster_dev", "quizmaster_test"],
    );
    expect(report.missing).toEqual(
      new Map([
        ["quizmaster_dev", []],
        ["quizmaster_test", []],
      ]),
    );
    expect(report.excessive).toEqual([]);
    expect(report.collMod).toEqual(new Set());
  });

  it("meldet fehlende readWrite-Aktionen je Datenbank", () => {
    const report = assessPrivileges(
      [{ resource: { db: "quizmaster", collection: "" }, actions: ["find", "changeStream"] }],
      ["quizmaster"],
    );
    expect(report.missing.get("quizmaster")).toEqual(["insert", "update", "remove", "createCollection", "createIndex"]);
  });

  it("erkennt dbOwner-Rechte (Datenbank löschen, Benutzer/Rollen verwalten) als überzählig", () => {
    const dbOwner: Privilege = {
      resource: { db: "quizmaster_dev", collection: "" },
      actions: [...READ_WRITE, "collMod", "dropDatabase", "createUser", "dropUser", "grantRole", "revokeRole"],
    };
    const report = assessPrivileges([dbOwner, readWrite("quizmaster_test")], ["quizmaster_dev", "quizmaster_test"]);
    expect(report.missing.get("quizmaster_dev")).toEqual([]);
    expect(report.collMod).toEqual(new Set(["quizmaster_dev"]));
    expect(report.excessive).toEqual([
      "createUser@quizmaster_dev",
      "dropDatabase@quizmaster_dev",
      "dropUser@quizmaster_dev",
      "grantRole@quizmaster_dev",
      "revokeRole@quizmaster_dev",
    ]);
  });

  it("erkennt Rechte auf alles, auf den Cluster, auf alle oder fremde Datenbanken", () => {
    const report = assessPrivileges(
      [
        { resource: { anyResource: true }, actions: ["anyAction"] },
        { resource: { cluster: true }, actions: ["shutdown"] },
        { resource: { db: "", collection: "" }, actions: [...READ_WRITE] },
        readWrite("quizmaster_dev"),
      ],
      ["quizmaster"],
    );
    expect(report.missing.get("quizmaster")).toEqual([]);
    expect(report.excessive).toEqual([
      "Cluster-Rechte (shutdown)",
      "Rechte auf alle Datenbanken",
      "Rechte auf alle Ressourcen (anyResource)",
      "Rechte auf fremde Datenbank quizmaster_dev",
    ]);
  });
});
