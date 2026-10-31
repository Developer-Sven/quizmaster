import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const fromScripts = createRequire(join(root, "scripts/package.json"));
const fromLighthouse = createRequire(fromScripts.resolve("lighthouse"));
const fromPuppeteer = createRequire(fromLighthouse.resolve("puppeteer-core"));

describe("Lighthouse ohne den ungenutzten, verwundbaren BiDi-Mapper", () => {
  it("installiert weder den BiDi-Mapper noch eine alte Zod-Kopie", () => {
    expect(() => fromPuppeteer.resolve("chromium-bidi")).toThrow(expect.objectContaining({ code: "MODULE_NOT_FOUND" }));
    const store = join(root, "node_modules/.pnpm");
    const packages = readdirSync(store);
    expect(packages.filter((name) => name.startsWith("chromium-bidi@"))).toEqual([]);
    for (const name of packages.filter((name) => name.startsWith("zod@"))) {
      const { version } = JSON.parse(readFileSync(join(store, name, "node_modules/zod/package.json"), "utf8"));
      const [major = 0, minor = 0, patch = 0] = (version as string).split(".").map(Number);
      expect(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), version).toBe(true);
    }
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/^ {2}chromium-bidi@/m);
    expect(lock).not.toMatch(/^ {2}zod@[0-3]\./m);
  });

  it("lädt die echten Lighthouse- und Puppeteer-Einstiege ohne BiDi oder Zod", () => {
    const probe = `
      import assert from "node:assert/strict";
      import { createRequire, registerHooks } from "node:module";
      import { pathToFileURL } from "node:url";
      const hooks = registerHooks({ resolve(specifier, context, next) {
        assert(!/^(chromium-bidi|zod)(\\/|$)/.test(specifier), "unexpected dependency: " + specifier);
        return next(specifier, context);
      }});
      try {
        const { default: lighthouse } = await import("lighthouse");
        assert.equal(typeof lighthouse, "function");
        const require = createRequire(import.meta.url);
        const fromLighthouse = createRequire(require.resolve("lighthouse"));
        const puppeteer = await import(pathToFileURL(fromLighthouse.resolve("puppeteer-core")).href);
        assert.equal(typeof puppeteer.default.connect, "function");
        assert.equal(typeof fromLighthouse("puppeteer-core").default.connect, "function");
      } finally { hooks.deregister(); }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: join(root, "scripts"),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
