import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CloudflareLists,
  fetchLists,
  isCidr,
  parseCidrList,
  parseIpFile,
  sameLists,
  serializeIpFile,
  validateLists,
} from "./cloudflare.ts";

const saved = readFileSync(
  join(resolve(import.meta.dirname, "../../.."), "infra", "caddy", "cloudflare-ips.txt"),
  "utf8",
);

describe("CIDR-Prüfung", () => {
  it("erkennt gültige IPv4-/IPv6-Bereiche", () => {
    expect(isCidr("173.245.48.0/20", "v4")).toBe(true);
    expect(isCidr("2400:cb00::/32", "v6")).toBe(true);
    for (const bad of ["173.245.48.0", "173.245.48.0/33", "999.1.1.1/8", "2400:cb00::/32", "x/8", " 1.1.1.1/8"]) {
      expect(isCidr(bad, "v4")).toBe(false);
    }
    expect(isCidr("2400:cb00::/129", "v6")).toBe(false);
  });

  it("parseCidrList wirft bei HTML oder Fehlerseiten", () => {
    expect(parseCidrList("103.21.244.0/22\n104.16.0.0/13", "v4")).toEqual(["103.21.244.0/22", "104.16.0.0/13"]);
    expect(() => parseCidrList("<html>Error</html>", "v4")).toThrow(/ungültiger/);
  });
});

describe("validateLists", () => {
  it("die gespeicherte Liste ist plausibel", () => {
    expect(validateLists(parseIpFile(saved))).toEqual([]);
  });

  it("lehnt zu wenige, doppelte und zu große Bereiche ab (0.0.0.0/0 würde alle zulassen)", () => {
    const lists = parseIpFile(saved);
    expect(validateLists({ v4: lists.v4.slice(0, 2), v6: lists.v6 })).toEqual([
      expect.stringContaining("IPv4: 2 Bereiche"),
    ]);
    expect(validateLists({ v4: [...lists.v4, "0.0.0.0/0"], v6: lists.v6 }).join()).toContain("zu groß");
    expect(validateLists({ v4: [...lists.v4, lists.v4[0] ?? ""], v6: lists.v6 }).join()).toContain("doppelte");
    expect(validateLists({ v4: lists.v4, v6: [...lists.v6, "::/0"] }).join()).toContain("zu groß");
  });
});

describe("gespeicherte Liste", () => {
  it("Serialisieren und Lesen ergibt dieselben Bereiche, Reihenfolge ist egal", () => {
    const lists = parseIpFile(saved);
    const again = parseIpFile(serializeIpFile(lists, "2026-10-01"));
    expect(again).toEqual(lists);
    const shuffled: CloudflareLists = { v4: [...lists.v4].reverse(), v6: [...lists.v6].reverse() };
    expect(sameLists(lists, shuffled)).toBe(true);
    expect(sameLists(lists, { v4: lists.v4.slice(1), v6: lists.v6 })).toBe(false);
  });

  it("ungültige Zeilen in der Datei brechen ab", () => {
    expect(() => parseIpFile("# Kommentar\nkein-cidr\n")).toThrow(/ungültige Zeile/);
  });
});

describe("fetchLists", () => {
  it("holt beide Listen ohne Umleitungen und prüft das Format", async () => {
    const calls: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, redirect: init?.redirect });
      return new Response(url.endsWith("v4") ? "173.245.48.0/20\n" : "2400:cb00::/32", { status: 200 });
    }) as typeof fetch;
    await expect(fetchLists(fake)).resolves.toEqual({ v4: ["173.245.48.0/20"], v6: ["2400:cb00::/32"] });
    expect(calls.map((call) => call.redirect)).toEqual(["error", "error"]);
  });

  it("HTTP-Fehler werfen", async () => {
    const fake = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(fetchLists(fake)).rejects.toThrow(/HTTP 503/);
  });
});
