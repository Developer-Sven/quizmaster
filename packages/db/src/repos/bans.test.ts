/**
 * BansRepo gegen die Test-DB: atomarer Upsert, der Sperren nur verlängert (nie verkürzt, auch bei
 * gleichzeitigen Aufrufen), abgelaufene Einträge als neu behandelt, sowie Abgleich- und Listenabfragen.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../testing/index.ts";
import { BAN_LOOKUP_CHUNK, type BansRepo, createBansRepo } from "./bans.ts";

let t: TestDatabase;
let bans: BansRepo;

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  bans = createBansRepo(t.collections.bans);
}, 60_000);

afterAll(async () => {
  await t?.cleanup();
});

const MINUTE = 60_000;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

describe("upsert/extend – verlängert nur", () => {
  it("legt eine Sperre an (eigene String-ID, createdAt = jetzt)", async () => {
    const now = new Date();
    const value = randomUUID();
    const result = await bans.extend(
      { kind: "guest", value, reason: "violations", expiresAt: at(now, 15 * MINUTE) },
      now,
    );
    expect(result.extended).toBe(true);
    expect(result.ban).toMatchObject({ kind: "guest", value, reason: "violations", createdAt: now });
    expect(typeof result.ban._id).toBe("string");
    expect(result.ban.expiresAt?.getTime()).toBe(now.getTime() + 15 * MINUTE);
  });

  it("kürzere Sperre lässt die längere stehen (Ablauf und Grund bleiben), längere verlängert", async () => {
    const now = new Date();
    const value = randomUUID();
    const first = await bans.upsert({ kind: "guest", value, reason: "admin", expiresAt: at(now, 60 * MINUTE) }, now);
    const shorter = await bans.extend(
      { kind: "guest", value, reason: "violations", expiresAt: at(now, 15 * MINUTE) },
      at(now, 1_000),
    );
    expect(shorter.extended).toBe(false);
    expect(shorter.ban).toMatchObject({ _id: first._id, reason: "admin", expiresAt: at(now, 60 * MINUTE) });
    const longer = await bans.extend(
      { kind: "guest", value, reason: "violations", expiresAt: at(now, 120 * MINUTE) },
      at(now, 2_000),
    );
    expect(longer.extended).toBe(true);
    expect(longer.ban).toMatchObject({
      _id: first._id,
      reason: "violations",
      expiresAt: at(now, 120 * MINUTE),
      createdAt: now,
    });
  });

  it("dauerhafte Sperre bleibt dauerhaft; eine befristete wird dauerhaft", async () => {
    const now = new Date();
    const value = randomUUID();
    await bans.upsert({ kind: "ip", value, reason: "flut", expiresAt: at(now, 10 * MINUTE) }, now);
    const permanent = await bans.extend({ kind: "ip", value, reason: "dauerhaft" }, now);
    expect(permanent.extended).toBe(true);
    expect(permanent.ban.expiresAt).toBeUndefined();
    expect(permanent.ban.reason).toBe("dauerhaft");

    const timed = await bans.extend({ kind: "ip", value, reason: "violations", expiresAt: at(now, 999 * MINUTE) }, now);
    expect(timed.extended).toBe(false);
    expect(timed.ban.expiresAt).toBeUndefined();
    expect(timed.ban.reason).toBe("dauerhaft");
    const again = await bans.extend({ kind: "ip", value, reason: "anders" }, now);
    expect(again.extended).toBe(false);
    expect(again.ban.reason).toBe("dauerhaft");
    expect(await t.collections.bans.countDocuments({ kind: "ip", value })).toBe(1);
  });

  it("eine abgelaufene (noch nicht per TTL gelöschte) Sperre zählt als neu – auch wenn sie länger lief", async () => {
    const now = new Date();
    const value = randomUUID();
    await bans.upsert({ kind: "guest", value, reason: "alt", expiresAt: at(now, -MINUTE) }, at(now, -60 * MINUTE));
    expect(await bans.findActive("guest", value, now)).toBeNull();
    const fresh = await bans.extend({ kind: "guest", value, reason: "neu", expiresAt: at(now, 5 * MINUTE) }, now);
    expect(fresh.extended).toBe(true);
    expect(fresh.ban).toMatchObject({ reason: "neu", createdAt: now, expiresAt: at(now, 5 * MINUTE) });
    expect(await bans.findActive("guest", value, now)).not.toBeNull();
  });

  it("gleichzeitige Sperren desselben Gasts: ein Dokument, die längste gewinnt", async () => {
    const now = new Date();
    const value = randomUUID();
    const minutes = [5, 60, 15, 30, 45, 10, 20, 50];
    await Promise.all(
      minutes.map((minute) =>
        bans.upsert({ kind: "guest", value, reason: `r${minute}`, expiresAt: at(now, minute * MINUTE) }, now),
      ),
    );
    const docs = await t.collections.bans.find({ kind: "guest", value }).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.expiresAt?.getTime()).toBe(now.getTime() + 60 * MINUTE);
    expect(docs[0]?.reason).toBe("r60");
  });

  it("validiert die Eingabe (keine Operatoren, keine Zusatzfelder)", async () => {
    const now = new Date();
    await expect(
      bans.upsert({ kind: "guest", value: { $gt: "" } as unknown as string, reason: "x" }, now),
    ).rejects.toThrow();
    await expect(
      bans.upsert(
        { kind: "guest", value: "v", reason: "x", extra: 1 } as unknown as Parameters<BansRepo["upsert"]>[0],
        now,
      ),
    ).rejects.toThrow();
    await expect(bans.upsert({ kind: "admin" as "guest", value: "v", reason: "x" }, now)).rejects.toThrow();
  });
});

describe("Abfragen", () => {
  it("findActiveAmong: aktive Sperren unter vielen Gästen und IP-Schlüsseln (in Blöcken)", async () => {
    const now = new Date();
    const bannedGuest = randomUUID();
    const expiredGuest = randomUUID();
    const bannedIp = `ip-${randomUUID()}`;
    await bans.upsert({ kind: "guest", value: bannedGuest, reason: "a", expiresAt: at(now, MINUTE) }, now);
    await bans.upsert({ kind: "guest", value: expiredGuest, reason: "b", expiresAt: at(now, -MINUTE) }, now);
    await bans.upsert({ kind: "ip", value: bannedIp, reason: "c" }, now);
    const filler = Array.from({ length: BAN_LOOKUP_CHUNK + 5 }, () => randomUUID());
    const found = await bans.findActiveAmong(
      { guestIds: [...filler, bannedGuest, expiredGuest, bannedGuest], ipKeys: ["ip-frei", bannedIp] },
      now,
    );
    expect(found.map((ban) => `${ban.kind}:${ban.value}`).sort()).toEqual(
      [`guest:${bannedGuest}`, `ip:${bannedIp}`].sort(),
    );
    expect(await bans.findActiveAmong({ guestIds: [], ipKeys: [] }, now)).toEqual([]);
  });

  it("listActive: neueste zuerst, begrenzt, mit Gesamtzahl; remove hebt auf", async () => {
    const now = new Date();
    const values = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, value] of values.entries()) {
      await bans.upsert({ kind: "guest", value, reason: `l${index}` }, at(now, index * 1_000));
    }
    const all = await bans.listActive(at(now, 10_000));
    expect(all.total).toBeGreaterThanOrEqual(3);
    const top = await bans.listActive(at(now, 10_000), { limit: 2 });
    expect(top.bans).toHaveLength(2);
    expect(top.bans[0]?.value).toBe(values[2]);
    expect(top.total).toBe(all.total);
    expect(await bans.remove("guest", values[2] ?? "")).toBe(true);
    expect(await bans.remove("guest", values[2] ?? "")).toBe(false);
    expect((await bans.listActive(at(now, 10_000))).total).toBe(all.total - 1);
  });
});
