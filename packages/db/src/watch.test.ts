import type { Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";
import {
  backoffDelay,
  buildWatchPipeline,
  isResumeTokenError,
  type WatchedChange,
  type WatchHandle,
  type WatchResetReason,
  watchWithResume,
} from "./watch.ts";

interface Item extends Document {
  _id: string;
  n?: number;
  kind?: string;
}

let t: TestDatabase;
const handles: WatchHandle[] = [];
const fast = { maxAwaitTimeMS: 200, backoff: { initialMs: 100, maxMs: 300 } };

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await Promise.all(handles.map((handle) => handle.close()));
  await t?.cleanup();
});

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Zeitüberschreitung beim Warten auf Change-Events");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function collection(name: string) {
  return t.db.collection<Item>(`${t.prefix}${name}`);
}

function idOf(change: WatchedChange<Item>): string {
  return String(change.documentKey._id);
}

function track(handle: WatchHandle): WatchHandle {
  handles.push(handle);
  return handle;
}

describe("watchWithResume – Hilfsfunktionen", () => {
  it("stellt den $match auf operationType vor die Pipeline des Aufrufers", () => {
    expect(buildWatchPipeline(["insert"], [{ $project: { x: 1 } }])).toEqual([
      { $match: { operationType: { $in: ["insert"] } } },
      { $project: { x: 1 } },
    ]);
  });

  it("Backoff wächst exponentiell mit Jitter und ist gedeckelt", () => {
    const backoff = { initialMs: 500, maxMs: 30_000, factor: 2 };
    expect(backoffDelay(1, backoff, () => 0.5)).toBe(500);
    expect(backoffDelay(3, backoff, () => 0.5)).toBe(2_000);
    expect(backoffDelay(20, backoff, () => 1)).toBe(30_000);
    expect(backoffDelay(1, backoff, () => 0)).toBe(400);
  });

  it("erkennt Token-Fehler", () => {
    expect(isResumeTokenError(Object.assign(new Error("x"), { code: 286 }))).toBe(true);
    expect(isResumeTokenError(new Error("resume token was not found"))).toBe(true);
    expect(isResumeTokenError(new Error("socket hang up"))).toBe(false);
  });
});

describe("watchWithResume – Change Streams", () => {
  it("liefert insert, update (mit fullDocument) und delete", async () => {
    const items = collection("watch_basic");
    const events: string[] = [];
    const handle = track(
      watchWithResume(
        items,
        [],
        {
          onChange: (change) => {
            const n = "fullDocument" in change ? change.fullDocument?.n : undefined;
            events.push(`${change.operationType}:${idOf(change)}${n === undefined ? "" : `:${n}`}`);
          },
        },
        fast,
      ),
    );
    await handle.ready;
    await items.insertOne({ _id: "a", n: 1 });
    await items.updateOne({ _id: "a" }, { $set: { n: 2 } });
    await waitFor(() => events.length === 2);
    await items.replaceOne({ _id: "a" }, { n: 3 });
    await items.deleteOne({ _id: "a" });
    await waitFor(() => events.length === 4);
    expect(events).toEqual(["insert:a:1", "update:a:2", "replace:a:3", "delete:a"]);
    await handle.close();
    expect(handle.closed).toBe(true);
    await handle.close();
  });

  it("filtert per operationTypes und eigener Pipeline", async () => {
    const items = collection("watch_filter");
    const events: string[] = [];
    const handle = track(
      watchWithResume(
        items,
        [{ $match: { "fullDocument.kind": "guest" } }],
        {
          onChange: (change) => {
            events.push(idOf(change));
          },
        },
        { ...fast, operationTypes: ["insert"] },
      ),
    );
    await handle.ready;
    await items.insertMany([
      { _id: "ip-1", kind: "ip" },
      { _id: "guest-1", kind: "guest" },
    ]);
    await items.deleteOne({ _id: "guest-1" });
    await items.insertOne({ _id: "guest-2", kind: "guest" });
    await waitFor(() => events.length === 2);
    expect(events).toEqual(["guest-1", "guest-2"]);
  });

  it("setzt nach einer Unterbrechung mit dem Resume-Token fort (keine Lücke, keine Doppelten)", async () => {
    const items = collection("watch_resume");
    const first: string[] = [];
    const a = track(watchWithResume(items, [], { onChange: (change) => void first.push(idOf(change)) }, fast));
    await a.ready;
    await items.insertOne({ _id: "1" });
    await waitFor(() => first.length === 1);
    const token = a.resumeToken;
    expect(token).toBeDefined();
    await a.close();

    // Änderungen, während kein Watcher läuft (z. B. Neustart/Netzausfall):
    await items.insertOne({ _id: "2" });
    await items.updateOne({ _id: "1" }, { $set: { n: 5 } });

    const second: string[] = [];
    const opened: boolean[] = [];
    const b = track(
      watchWithResume(
        items,
        [],
        {
          onChange: (change) => void second.push(`${change.operationType}:${idOf(change)}`),
          onOpen: ({ resumed }) => void opened.push(resumed),
        },
        { ...fast, resumeToken: token },
      ),
    );
    await waitFor(() => second.length === 2);
    expect(second).toEqual(["insert:2", "update:1"]);
    expect(opened[0]).toBe(true);
    await items.insertOne({ _id: "3" });
    await waitFor(() => second.length === 3);
    expect(first).toEqual(["1"]);
    await b.close();
  });

  it("stellt eine fehlgeschlagene Änderung nach Backoff erneut zu (mindestens einmal)", async () => {
    const items = collection("watch_retry");
    const seen: string[] = [];
    const delays: number[] = [];
    let failOnce = true;
    const handle = track(
      watchWithResume(
        items,
        [],
        {
          onChange: (change) => {
            if (idOf(change) === "x2" && failOnce) {
              failOnce = false;
              throw new Error("Verarbeitung kaputt");
            }
            seen.push(idOf(change));
          },
          onError: (_error, retry) => void delays.push(retry.delayMs),
        },
        fast,
      ),
    );
    await handle.ready;
    await items.insertOne({ _id: "x1" });
    await items.insertOne({ _id: "x2" });
    await waitFor(() => delays.length === 1);
    await items.insertOne({ _id: "x3" }); // während der Unterbrechung
    await waitFor(() => seen.length === 3);
    expect(seen).toEqual(["x1", "x2", "x3"]);
  });

  it.each([
    ["kein Hex", { _data: "zz" }],
    ["abgeschnitten", { _data: "8263" }],
  ])("ungültiger Resume-Token (%s) → onReset und frischer Stream", async (_label, badToken) => {
    const items = collection(`watch_badtoken_${_label === "kein Hex" ? "a" : "b"}`);
    const resets: WatchResetReason[] = [];
    const seen: string[] = [];
    const handle = track(
      watchWithResume(
        items,
        [],
        { onChange: (change) => void seen.push(idOf(change)), onReset: (reason) => void resets.push(reason) },
        { ...fast, resumeToken: badToken },
      ),
    );
    await handle.ready;
    await waitFor(() => resets.length === 1);
    expect(resets).toEqual(["resume_failed"]);
    await items.insertOne({ _id: "danach" });
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(["danach"]);
  });

  it("wiederholt einen fehlgeschlagenen Vollreload (onReset) nach Backoff, bis er gelingt", async () => {
    const items = collection("watch_reset_retry");
    const resets: WatchResetReason[] = [];
    const attempts: number[] = [];
    const seen: string[] = [];
    let failures = 2;
    const handle = track(
      watchWithResume(
        items,
        [],
        {
          onChange: (change) => void seen.push(idOf(change)),
          onReset: (reason) => {
            resets.push(reason);
            if (failures > 0) {
              failures -= 1;
              throw new Error("Vollreload fehlgeschlagen");
            }
          },
          onError: (_error, retry) => void attempts.push(retry.attempt),
        },
        { ...fast, resumeToken: { _data: "zz" } },
      ),
    );
    await handle.ready;
    await waitFor(() => resets.length === 3);
    expect(resets).toEqual(["resume_failed", "resume_failed", "resume_failed"]);
    // Backoff wächst über die Fehlversuche hinweg (wird erst nach gelungenem Reload zurückgesetzt).
    expect(attempts).toEqual([1, 2]);
    await items.insertOne({ _id: "danach" });
    await waitFor(() => seen.includes("danach"));
    expect(resets).toHaveLength(3);
  });

  it("gelöschte Collection (invalidate) → onReset und weiter beobachten", async () => {
    const items = collection("watch_drop");
    await items.insertOne({ _id: "vorher" });
    const resets: WatchResetReason[] = [];
    const seen: string[] = [];
    const handle = track(
      watchWithResume(
        items,
        [],
        { onChange: (change) => void seen.push(idOf(change)), onReset: (reason) => void resets.push(reason) },
        fast,
      ),
    );
    await handle.ready;
    await items.drop();
    await waitFor(() => resets.includes("invalidated"));
    await items.insertOne({ _id: "nachher" });
    await waitFor(() => seen.includes("nachher"));
    expect(seen).toEqual(["nachher"]);
  });

  it("überspringt eine dauerhaft fehlschlagende Änderung und fordert einen Vollreload an", async () => {
    const items = collection("watch_poison");
    const resets: WatchResetReason[] = [];
    const seen: string[] = [];
    const handle = track(
      watchWithResume(
        items,
        [],
        {
          onChange: (change) => {
            if (idOf(change) === "gift") throw new Error("immer kaputt");
            seen.push(idOf(change));
          },
          onReset: (reason) => void resets.push(reason),
        },
        { ...fast, backoff: { initialMs: 50, maxMs: 100 }, maxDeliveryAttempts: 3 },
      ),
    );
    await handle.ready;
    await items.insertOne({ _id: "gift" });
    await waitFor(() => resets.includes("handler_failed"));
    await items.insertOne({ _id: "gesund" });
    await waitFor(() => seen.includes("gesund"));
    expect(seen).toEqual(["gesund"]);
  });
});
