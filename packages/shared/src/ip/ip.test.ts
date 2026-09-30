import { describe, expect, it } from "vitest";
import { IP_KEY_HEX_LENGTH, ipKey, ipKeySubject, resolveClientIp } from "./index.ts";

const secret = "s".repeat(43);

describe("resolveClientIp (docs/06 §IP-Adressen)", () => {
  it("nutzt den vertrauenswürdigen Header nur, wenn er konfiguriert ist", () => {
    const headers = { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" };
    expect(resolveClientIp(headers, "cf-connecting-ip", "127.0.0.1")).toBe("203.0.113.7");
    expect(resolveClientIp(headers, "CF-Connecting-IP", "127.0.0.1")).toBe("203.0.113.7");
    expect(resolveClientIp(headers, undefined, "192.0.2.10")).toBe("192.0.2.10");
  });

  it("nimmt bei Listen den ersten Eintrag und entfernt Zonen", () => {
    expect(resolveClientIp({ "x-real": ["203.0.113.7, 10.0.0.1"] }, "x-real", undefined)).toBe("203.0.113.7");
    expect(resolveClientIp({}, undefined, "fe80::1%eth0")).toBe("fe80::1");
  });

  it("liefert null bei fehlender oder ungültiger Adresse (fail-closed)", () => {
    expect(resolveClientIp({}, "cf-connecting-ip", "127.0.0.1")).toBeNull();
    expect(resolveClientIp({ "cf-connecting-ip": "evil" }, "cf-connecting-ip", undefined)).toBeNull();
    expect(resolveClientIp({}, undefined, undefined)).toBeNull();
  });
});

describe("ipKeySubject / ipKey", () => {
  it("fasst IPv6 auf das /64-Präfix zusammen und IPv4-mapped auf IPv4", () => {
    expect(ipKeySubject("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipKeySubject("2001:DB8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipKeySubject("::1")).toBe("0:0:0:0::/64");
    expect(ipKeySubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKeySubject("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(ipKeySubject("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKeySubject("nope")).toBeNull();
  });

  it("bildet gleiche Schlüssel innerhalb eines /64 und verschiedene sonst", () => {
    const a = ipKey("2001:db8:1:2::1", secret);
    expect(a).toHaveLength(IP_KEY_HEX_LENGTH);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(ipKey("2001:db8:1:2:ffff::9", secret)).toBe(a);
    expect(ipKey("2001:db8:1:3::1", secret)).not.toBe(a);
    expect(ipKey("::ffff:203.0.113.7", secret)).toBe(ipKey("203.0.113.7", secret));
    expect(ipKey("203.0.113.7", secret)).not.toBe(ipKey("203.0.113.7", "t".repeat(43)));
    expect(ipKey("203.0.113.7", secret)).not.toContain("203");
  });

  it("verlangt ein ausreichend langes Secret und lehnt ungültige IPs ab", () => {
    expect(() => ipKey("203.0.113.7", "kurz")).toThrow(RangeError);
    expect(ipKey("999.1.1.1", secret)).toBeNull();
  });
});
