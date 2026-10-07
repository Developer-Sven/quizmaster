/**
 * Datensparsamkeit der Feedback-Repositories (ADR-058 „nie ausgegeben, aus dem Repository nur Zahlen“, docs/06
 * Invariante 4 sinngemäß): Keine Rückgabe einer Methode von `ReportsRepo` und `RatingsRepo` – und keine Prüf-Queue –
 * enthält guestIds, HMAC-IP-Schlüssel oder Lobby-Codes, weder als Feld noch als Wert. Die Aufruf-Tabellen sind über
 * alle Methoden typisiert: Eine neue Repo-Methode kompiliert erst, wenn sie hier mitgeprüft wird.
 */
import { randomUUID } from "node:crypto";
import { findKeysDeep } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleQuestion } from "../test-support.ts";
import { createTestDatabase, type TestDatabase } from "../testing/index.ts";
import {
  buildReviewQueue,
  createRepositories,
  type RatingsRepo,
  type ReportsRepo,
  type Repositories,
} from "./index.ts";

let t: TestDatabase;
let repos: Repositories;
const DAY_MS = 24 * 60 * 60 * 1_000;
// Relativ zur Laufzeit: Mit einem festen Datum wären Meldungen und Bewertungen nach Ablauf ihrer TTL fällig.
const now = new Date();
const since = new Date(now.getTime() - DAY_MS);
const PRIMARY = { readPreference: "primary" } as const;
const [Q1, Q2] = ["co-privacy1", "co-privacy2"] as const;
const GUESTS = [randomUUID(), randomUUID(), randomUUID()] as const;
const IP_KEYS = ["a".repeat(32), "b".repeat(32), "c".repeat(32)] as const;
const LOBBY_CODES = ["QWE234", "HJK234", "RST234"] as const;
/** Felder, die nie aus den Repositories kommen dürfen. */
const ORIGIN_KEYS = ["guestId", "ipKey", "ipKeys", "lobbyCode", "lobbyCodes"];

/** Je Methode genau ein Aufruf – `-?` macht jede Methode Pflicht. */
type Calls<T> = { [K in keyof T]-?: () => Promise<unknown> };

/** Maps, Sets und Daten als einfache Werte (`findKeysDeep` sieht nur eigene Felder). */
function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([key, entry]) => ({ key: plain(key), value: plain(entry) }));
  if (value instanceof Set) return [...value].map(plain);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
  }
  return value;
}

function expectNoOrigin(name: string, value: unknown): void {
  const data = plain(value);
  expect(findKeysDeep(data, ORIGIN_KEYS), name).toEqual([]);
  const text = JSON.stringify(data) ?? "";
  for (const secret of [...GUESTS, ...IP_KEYS, ...LOBBY_CODES]) {
    expect(text.includes(secret), `${name} enthält einen Herkunftswert (${secret.slice(0, 4)}…)`).toBe(false);
  }
}

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  repos = createRepositories(t.client, t.collections);
  await t.collections.questions.insertMany([sampleQuestion(Q1), sampleQuestion(Q2)]);
  // Bestand: Meldungen und Bewertungen mit vollständiger Herkunft.
  for (const [index, questionId] of [Q1, Q1, Q2].entries()) {
    await repos.reports.create(
      {
        questionId,
        reason: "falsch",
        guestId: GUESTS[index] ?? randomUUID(),
        lobbyCode: LOBBY_CODES[index] ?? null,
        ipKey: IP_KEYS[index] ?? null,
      },
      now,
    );
  }
  await repos.ratings.rate(Q2, GUESTS[1], -1, now, { ipKey: IP_KEYS[1], lobbyCode: LOBBY_CODES[1] });
}, 60_000);

afterAll(async () => {
  await t?.cleanup();
});

describe("Feedback-Repositories geben keine Herkunft heraus (ADR-058)", () => {
  it("keine Rückgabe einer Report-Methode enthält guestId, IP-Schlüssel oder Lobby-Code", async () => {
    let reportId = "";
    const calls: Calls<ReportsRepo> = {
      create: async () => {
        const created = await repos.reports.create(
          { questionId: Q2, reason: "veraltet", guestId: GUESTS[2], lobbyCode: LOBBY_CODES[2], ipKey: IP_KEYS[2] },
          now,
        );
        reportId = created._id;
        return created;
      },
      setStatus: () => repos.reports.setStatus(reportId, "open"),
      countDistinctReporters: () => repos.reports.countDistinctReporters(Q1, since),
      countIndependentReporters: () => repos.reports.countIndependentReporters(Q1, since),
      findReportedQuestionIds: () => repos.reports.findReportedQuestionIds(GUESTS[0], [Q1, Q2]),
      summarizeOpen: () => repos.reports.summarizeOpen(PRIMARY),
      openQuestionIds: () => repos.reports.openQuestionIds(PRIMARY),
      resolveOpen: () => repos.reports.resolveOpen({ reportId }, "dismissed"),
      forgetOrigins: () => repos.reports.forgetOrigins(since),
    };
    for (const [name, call] of Object.entries(calls)) expectNoOrigin(`reports.${name}`, await call());
    expect(reportId).not.toBe("");
    // Die Prüf-Queue (admin:reports, Faktencheck) baut auf denselben Repositories auf.
    expectNoOrigin("buildReviewQueue", await buildReviewQueue(repos, { ...PRIMARY, now }));
  });

  it("keine Rückgabe einer Rating-Methode enthält guestId, IP-Schlüssel oder Lobby-Code", async () => {
    const calls: Calls<RatingsRepo> = {
      rate: () => repos.ratings.rate(Q1, GUESTS[0], -1, now, { ipKey: IP_KEYS[0], lobbyCode: LOBBY_CODES[0] }),
      dislikeSources: () => repos.ratings.dislikeSources(Q1, since),
      summary: () => repos.ratings.summary(Q1),
      summaries: () => repos.ratings.summaries([{ questionId: Q1 }, { questionId: Q2, since }], PRIMARY),
      countsByQuestion: () => repos.ratings.countsByQuestion({ ...PRIMARY, minRatings: 1 }),
      findByGuest: () => repos.ratings.findByGuest(GUESTS[0], [Q1, Q2]),
      forgetOrigins: () => repos.ratings.forgetOrigins(since),
    };
    for (const [name, call] of Object.entries(calls)) expectNoOrigin(`ratings.${name}`, await call());
  });

  it("die Herkunft bleibt gespeichert – sie verlässt die Datenbank nur als Zahl (unabhängige Quellen)", async () => {
    expect(await t.collections.questionReports.countDocuments({ ipKey: { $type: "string" } })).toBeGreaterThan(0);
    expect(await repos.reports.countIndependentReporters(Q1, since)).toBe(2);
  });
});
