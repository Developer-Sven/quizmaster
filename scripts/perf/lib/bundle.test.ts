import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUDGETS,
  dynamicImportGroups,
  gzipSize,
  isInitialEntry,
  judge,
  KB,
  measureFromBuild,
  measureFromHtml,
  parseClientReferenceManifest,
  scriptsFromHtml,
} from "./bundle.ts";

const P = "[project]/apps/web/src/app";

describe("Segmente beim ersten Aufruf", () => {
  it("nimmt Layouts, Fehlergrenzen und die Seite auf dem Weg – nicht not-found/global-error/fremde Seiten", () => {
    const lobby = "/lobby/[code]";
    expect(isInitialEntry(`${P}/layout`, lobby)).toBe(true);
    expect(isInitialEntry(`${P}/error`, lobby)).toBe(true);
    expect(isInitialEntry(`${P}/lobby/[code]/page`, lobby)).toBe(true);
    expect(isInitialEntry(`${P}/lobby/layout`, lobby)).toBe(true);
    expect(isInitialEntry(`${P}/lobby/[code]/error`, lobby)).toBe(true);
    expect(isInitialEntry(`${P}/not-found`, lobby)).toBe(false);
    expect(isInitialEntry(`${P}/global-error`, lobby)).toBe(false);
    expect(isInitialEntry(`${P}/lobby/[code]/not-found`, lobby)).toBe(false);
    expect(isInitialEntry(`${P}/page`, lobby)).toBe(false);
    expect(isInitialEntry(`${P}/j/[code]/layout`, lobby)).toBe(false);
    expect(isInitialEntry(`${P}/page`, "/")).toBe(true);
    expect(isInitialEntry(`${P}/lobby/[code]/page`, "/")).toBe(false);
  });
});

describe("Parser", () => {
  it("liest das Client-Reference-Manifest als JSON, ohne es auszuführen", () => {
    const source = `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};
globalThis.__RSC_MANIFEST["/page"] = {"moduleLoading":{"prefix":""},"entryJSFiles":{"${P}/page":["/_next/static/chunks/a.js"]}};`;
    expect(parseClientReferenceManifest(source)).toEqual({ [`${P}/page`]: ["/_next/static/chunks/a.js"] });
    expect(() => parseClientReferenceManifest("alert(1)")).toThrow(/nicht lesbar/);
  });

  it("findet dynamische Importe im Turbopack-Format", () => {
    const chunk = `e=>{e.v(t=>Promise.all(["static/chunks/x1.js","static/chunks/x2.js"].map(t=>e.l(t))).then(()=>t(1)))},
      2,e=>{e.v(t=>Promise.all(["static/chunks/y.js"].map(t=>e.l(t))).then(()=>t(2)))}`;
    expect(dynamicImportGroups(chunk)).toEqual([
      ["static/chunks/x1.js", "static/chunks/x2.js"],
      ["static/chunks/y.js"],
    ]);
  });

  it("liest Skripte aus dem HTML ohne noModule-Polyfills", () => {
    const html = `<html><head><script src="/_next/static/chunks/main.js" async=""></script>
      <script src="/_next/static/chunks/poly.js" noModule=""></script><script nonce="n">self.__next_f=[]</script>
      <script src="https://cdn.example/_next/static/chunks/page.js?v=1" async></script></head></html>`;
    expect(scriptsFromHtml(html)).toEqual(["static/chunks/main.js", "static/chunks/page.js"]);
  });
});

describe("Messung", () => {
  const dist = mkdtempSync(join(tmpdir(), "qm-bundle-"));
  afterAll(() => rmSync(dist, { recursive: true, force: true }));
  const chunk = (name: string, content: string) => {
    mkdirSync(join(dist, "static", "chunks"), { recursive: true });
    writeFileSync(join(dist, "static", "chunks", name), content);
  };
  chunk("framework.js", "x".repeat(5_000));
  chunk("layout.js", "layout();");
  chunk("error.js", "error();");
  chunk("page.js", `page();Promise.all(["static/chunks/lazy.js"].map(t=>e.l(t)))`);
  chunk("lazy.js", "lazy();".repeat(50));
  chunk("not-found.js", "nf();");
  writeFileSync(
    join(dist, "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/framework.js"], polyfillFiles: ["static/chunks/poly.js"] }),
  );
  mkdirSync(join(dist, "server", "app", "lobby", "[code]"), { recursive: true });
  const entries = {
    [`${P}/layout`]: ["/_next/static/chunks/layout.js"],
    [`${P}/error`]: ["/_next/static/chunks/layout.js", "/_next/static/chunks/error.js"],
    [`${P}/not-found`]: ["/_next/static/chunks/not-found.js"],
    [`${P}/lobby/[code]/page`]: ["/_next/static/chunks/layout.js", "/_next/static/chunks/page.js"],
  };
  writeFileSync(
    join(dist, "server", "app", "lobby", "[code]", "page_client-reference-manifest.js"),
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST["/lobby/[code]/page"] = ${JSON.stringify({ entryJSFiles: entries })};`,
  );

  it("summiert Framework + Segmente gzip-komprimiert und weist dynamische Importe aus", () => {
    const measured = measureFromBuild(dist, "/lobby/[code]");
    expect(measured.files).toEqual([
      "static/chunks/error.js",
      "static/chunks/framework.js",
      "static/chunks/layout.js",
      "static/chunks/page.js",
    ]);
    const size = (content: string) => gzipSize(content);
    expect(measured.frameworkBytes).toBe(size("x".repeat(5_000)));
    expect(measured.initialBytes).toBe(
      size("x".repeat(5_000)) +
        size("layout();") +
        size("error();") +
        size(`page();Promise.all(["static/chunks/lazy.js"].map(t=>e.l(t)))`),
    );
    expect(measured.dynamicGroups).toEqual([{ files: ["static/chunks/lazy.js"], bytes: size("lazy();".repeat(50)) }]);

    const budget = BUDGETS.find((entry) => entry.route === "/lobby/[code]");
    if (budget === undefined) throw new Error("Budget fehlt");
    const verdict = judge(budget, measured);
    expect(verdict.ok).toBe(true);
    expect(verdict.onOpenBytes).toBe(measured.initialBytes + size("lazy();".repeat(50)));
    expect(judge({ ...budget, maxKb: 0.01 }, measured).ok).toBe(false);
    expect(KB).toBe(1_024);
  });

  it("kommt aus dem HTML auf dieselben Chunks wie aus dem Build", () => {
    const html = ["framework", "layout", "error", "page"]
      .map((name) => `<script src="/_next/static/chunks/${name}.js" async=""></script>`)
      .join("");
    const read = (file: string) =>
      ({
        "static/chunks/framework.js": "x".repeat(5_000),
        "static/chunks/layout.js": "layout();",
        "static/chunks/error.js": "error();",
        "static/chunks/page.js": `page();Promise.all(["static/chunks/lazy.js"].map(t=>e.l(t)))`,
        "static/chunks/lazy.js": "lazy();".repeat(50),
      })[file] ?? "";
    const fromHtml = measureFromHtml(
      "/lobby/[code]",
      html,
      ["static/chunks/framework.js"],
      (file) => gzipSize(read(file)),
      read,
      new Set(["static/chunks/layout.js", "static/chunks/page.js"]),
    );
    const fromBuild = measureFromBuild(dist, "/lobby/[code]");
    expect(fromHtml.files).toEqual(fromBuild.files);
    expect(fromHtml.initialBytes).toBe(fromBuild.initialBytes);
    expect(fromHtml.dynamicGroups).toEqual(fromBuild.dynamicGroups);
  });
});
