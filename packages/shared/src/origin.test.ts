import { describe, expect, it } from "vitest";
import { isAllowedOrigin, normalizeOrigin } from "./origin.ts";

const allowed = ["https://quizmaster.dev-sven.de", "http://localhost:3000"];

describe("normalizeOrigin", () => {
  it("liefert die kanonische Origin", () => {
    expect(normalizeOrigin("https://Quizmaster.Dev-Sven.de")).toBe("https://quizmaster.dev-sven.de");
    expect(normalizeOrigin("https://quizmaster.dev-sven.de:443")).toBe("https://quizmaster.dev-sven.de");
    expect(normalizeOrigin(" http://localhost:3000 ")).toBe("http://localhost:3000");
  });

  it("lehnt Pfade, andere Schemata und Unsinn ab", () => {
    for (const value of ["https://a.de/x", "null", "ftp://a.de", "javascript:alert(1)", "https://", ""]) {
      expect(normalizeOrigin(value), value).toBeNull();
    }
  });
});

describe("isAllowedOrigin (docs/06 CSRF, ADR-028)", () => {
  it("erlaubt nur Origins aus der Liste", () => {
    expect(isAllowedOrigin({ origin: "https://quizmaster.dev-sven.de" }, allowed)).toBe(true);
    expect(isAllowedOrigin({ origin: "http://localhost:3000" }, allowed)).toBe(true);
    expect(isAllowedOrigin({ origin: "https://evil.example" }, allowed)).toBe(false);
    expect(isAllowedOrigin({ origin: "https://quizmaster.dev-sven.de.evil.example" }, allowed)).toBe(false);
    expect(isAllowedOrigin({ origin: "http://quizmaster.dev-sven.de" }, allowed)).toBe(false);
    expect(isAllowedOrigin({ origin: "null" }, allowed)).toBe(false);
  });

  it("lehnt fehlenden Origin standardmäßig ab (Web-POST-Routen)", () => {
    expect(isAllowedOrigin({}, allowed)).toBe(false);
    expect(isAllowedOrigin({ origin: "", secFetchSite: "same-origin" }, allowed)).toBe(false);
  });

  it("erlaubt fehlenden Origin nur mit Sec-Fetch-Site: same-origin, wenn freigeschaltet (Long-Polling)", () => {
    const options = { allowMissingWhenSameOrigin: true };
    expect(isAllowedOrigin({ secFetchSite: "same-origin" }, allowed, options)).toBe(true);
    expect(isAllowedOrigin({ secFetchSite: "Same-Origin" }, allowed, options)).toBe(true);
    expect(isAllowedOrigin({ secFetchSite: "cross-site" }, allowed, options)).toBe(false);
    expect(isAllowedOrigin({ secFetchSite: "none" }, allowed, options)).toBe(false);
    expect(isAllowedOrigin({}, allowed, options)).toBe(false);
    expect(isAllowedOrigin({ origin: "https://evil.example", secFetchSite: "same-origin" }, allowed, options)).toBe(
      false,
    );
  });
});
