import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "./chunk-error";

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("isChunkLoadError", () => {
  it("erkennt gescheiterte Chunk-Downloads von Turbopack, webpack und nativen Importen", () => {
    expect(
      isChunkLoadError(
        named("ChunkLoadError", "Failed to load chunk /_next/static/chunks/0n0_oyy7t63ws.js from module 36565"),
      ),
    ).toBe(true);
    expect(isChunkLoadError(named("Error", "Failed to load chunk /_next/static/chunks/a.js"))).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 123 failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk app-layout failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/y.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  it("lässt andere Fehler bei `retry()`", () => {
    expect(isChunkLoadError(new Error("Unerwarteter Zustand"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isChunkLoadError(named("ChunkLoadErrorLike", "irgendwas"))).toBe(false);
    expect(isChunkLoadError("Failed to load chunk")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
