import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { violations } from "./lighthouse.ts";
import {
  type BrowserFactory,
  LighthouseInterruptedError,
  readLighthouseReport,
  runLighthouseMeasurement,
  runLighthouseProcess,
} from "./lighthouse-process.ts";

function node(code: string, options = {}) {
  return runLighthouseProcess(process.execPath, ["--input-type=module", "-e", code], {
    env: process.env,
    timeoutMs: 1_000,
    killGraceMs: 100,
    ...options,
  });
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Fixture condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pid(path: string): number {
  return Number(readFileSync(path, "utf8"));
}

function family(root: string, exits: boolean): string {
  const grandchild = `import { writeFileSync, appendFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(join(root, "grandchild.pid"))}, String(process.pid));
    process.on("SIGTERM", () => appendFileSync(${JSON.stringify(join(root, "grandchild.term"))}, "TERM"));
    process.send("ready"); setInterval(() => {}, 1000);`;
  return `import { spawn } from "node:child_process"; import { writeFileSync, appendFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(join(root, "child.pid"))}, String(process.pid));
    process.on("SIGTERM", () => appendFileSync(${JSON.stringify(join(root, "child.term"))}, "TERM"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}], {stdio:["ignore", "ignore", "inherit", "ipc"]});
    child.once("message", () => { child.disconnect(); child.unref(); ${exits ? "process.exit(0);" : ""} });
    setInterval(() => {}, 1000);`;
}

function browserFixture(root: string, mode: "ready" | "failure" | "never"): BrowserFactory {
  return (_options, overrides, signal) => ({
    port: 45678,
    async launch() {
      if (!overrides.spawn) throw new Error("Missing owned spawn");
      overrides.spawn(process.execPath, ["--input-type=module", "-e", family(root, false)], {
        detached: true,
        stdio: "ignore",
      });
      await eventually(() => existsSync(join(root, "grandchild.pid")));
      if (mode === "failure") throw new Error("fixture browser startup failure");
      if (mode === "never") {
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }
    },
    kill() {},
    destroyTmp() {},
  });
}

function cleanup(pidFile: string): void {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

async function within<T>(value: Promise<T>, ms: number): Promise<T | "STILL_RUNNING"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<"STILL_RUNNING">((resolve) => {
        timer = setTimeout(() => resolve("STILL_RUNNING"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Lighthouse-Prozessfrist", () => {
  it.skipIf(process.platform === "win32")(
    "besitzt einen separat detached gestarteten Browser samt Enkeln, ohne fremde Gruppen zu beenden",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qm-owned-browser-"));
      const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      const code = `import {accessSync,constants} from 'node:fs';
      let blocked=false;try {accessSync(process.env.CHROME_PATH,constants.X_OK)}catch {blocked=true}
      if(!blocked)process.exit(77);else setInterval(()=>{},1000);`;
      try {
        const result = await runLighthouseMeasurement(
          process.execPath,
          ["--input-type=module", "-e", code, "--"],
          {
            env: process.env,
            chromePath: "/unused/owned-fixture",
            chromeFlags: [],
            timeoutMs: 700,
            killGraceMs: 100,
          },
          browserFixture(root, "ready"),
        );
        expect(result).toMatchObject({ code: null, timedOut: true, error: null });
        expect(readFileSync(join(root, "child.term"), "utf8")).toBe("TERM");
        expect(readFileSync(join(root, "grandchild.term"), "utf8")).toBe("TERM");
        await eventually(() => !alive(pid(join(root, "child.pid"))) && !alive(pid(join(root, "grandchild.pid"))));
        expect(alive(foreign.pid ?? -1)).toBe(true);
      } finally {
        cleanup(join(root, "child.pid"));
        foreign.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  for (const mode of ["ready", "failure", "never"] as const) {
    it.skipIf(process.platform === "win32")(`bereinigt eigenen Browser nach ${mode}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "qm-browser-start-"));
      const run = runLighthouseMeasurement(
        process.execPath,
        ["-e", "", "--"],
        {
          env: process.env,
          chromePath: "/unused/owned-fixture",
          chromeFlags: [],
          timeoutMs: 700,
          killGraceMs: 100,
        },
        browserFixture(root, mode),
      );
      try {
        if (mode === "failure") await expect(run).rejects.toThrow("fixture browser startup failure");
        else expect(await run).toMatchObject({ code: mode === "ready" ? 0 : null, timedOut: mode === "never" });
        await eventually(() => !alive(pid(join(root, "child.pid"))) && !alive(pid(join(root, "grandchild.pid"))));
      } finally {
        cleanup(join(root, "child.pid"));
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("meldet fehlendes Chrome ohne unbehandelten spawn-Fehler", async () => {
    await expect(
      runLighthouseMeasurement(process.execPath, ["-e", "", "--"], {
        env: process.env,
        chromePath: "/missing/owned-chrome-fixture",
        chromeFlags: [],
        timeoutMs: 500,
        killGraceMs: 50,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verweigert nicht ausführbare Browserpfade ohne Finder-Fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "qm-browser-sentinel-"));
    const file = join(root, "not-executable");
    writeFileSync(file, "", { mode: 0o600 });
    try {
      await expect(
        runLighthouseMeasurement(process.execPath, ["-e", "", "--"], {
          env: process.env,
          chromePath: file,
          chromeFlags: [],
          timeoutMs: 500,
          killGraceMs: 50,
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it.skipIf(process.platform === "win32")(
      `räumt einen separat gestarteten Browser bei ${signal} während Readiness auf`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "qm-browser-interrupt-"));
        const helper = new URL("./lighthouse-process.ts", import.meta.url).href;
        const code = `import {runLighthouseMeasurement,LighthouseInterruptedError} from ${JSON.stringify(helper)};
        const factory=(_options,overrides,signal)=>({port:45678,async launch(){
          overrides.spawn(process.execPath,["--input-type=module","-e",${JSON.stringify(family(root, false))}],{detached:true,stdio:"ignore"});
          await new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
        },kill(){},destroyTmp(){}});
        try { await runLighthouseMeasurement(process.execPath,["-e","","--"],{env:process.env,chromePath:"/unused/fixture",chromeFlags:[],timeoutMs:5000,killGraceMs:100},factory);process.exitCode=99; }
        catch(error){process.exitCode=error instanceof LighthouseInterruptedError?(error.signal==="SIGINT"?130:143):98;}`;
        const parent = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
        let exitCode: number | null = null;
        parent.once("exit", (value) => {
          exitCode = value;
        });
        try {
          await eventually(() => existsSync(join(root, "grandchild.pid")));
          parent.kill(signal);
          await eventually(() => exitCode !== null);
          expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
          await eventually(() => !alive(pid(join(root, "child.pid"))) && !alive(pid(join(root, "grandchild.pid"))));
        } finally {
          cleanup(join(root, "child.pid"));
          parent.kill("SIGKILL");
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }

  it("verhindert einen verspäteten Browser-Spawn nach abgebrochener Portsuche", async () => {
    const root = mkdtempSync(join(tmpdir(), "qm-late-browser-"));
    const marker = join(root, "late");
    let late: Promise<void> = Promise.resolve();
    const factory: BrowserFactory = (_options, overrides) => ({
      port: 45678,
      launch() {
        late = new Promise<void>((resolve) => setTimeout(resolve, 250)).then(() => {
          if (!overrides.spawn) throw new Error("Missing owned spawn");
          overrides.spawn(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'spawned')`]);
        });
        return late;
      },
      kill() {},
      destroyTmp() {},
    });
    try {
      expect(
        await runLighthouseMeasurement(
          process.execPath,
          ["-e", "", "--"],
          {
            env: process.env,
            chromePath: "/unused/late-fixture",
            chromeFlags: [],
            timeoutMs: 100,
            killGraceMs: 50,
          },
          factory,
        ),
      ).toMatchObject({ timedOut: true });
      await expect(late).rejects.toBeInstanceOf(Error);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const outcome of ["normal", "error", "timeout"] as const) {
    it(`Berichte nach ${outcome}: vertraut gültiger JSON nur nach erfolgreichem Prozessende`, async () => {
      const root = mkdtempSync(join(tmpdir(), "qm-lighthouse-report-"));
      const reportPath = join(root, "report.json");
      const report = {
        categories: {
          performance: { score: 1 },
          accessibility: { score: 1 },
          "best-practices": { score: 1 },
        },
      };
      const code = `import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(join(root, "child.pid"))}, String(process.pid));
        writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});
        ${outcome === "timeout" ? "setInterval(() => {}, 1000);" : `process.exitCode = ${outcome === "error" ? 17 : 0};`}`;
      try {
        const result = await node(code, { timeoutMs: 300, killGraceMs: 100 });
        expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
        const run = readLighthouseReport(
          result.timedOut ? null : result.code,
          "Fixture",
          "http://localhost/",
          reportPath,
        );
        if (outcome === "normal") {
          expect(run.reportPath).toBe(reportPath);
          expect(violations(run)).toEqual([]);
        } else {
          expect(violations(run).length).toBeGreaterThan(0);
          expect(run.runtimeError).toBe("LIGHTHOUSE_PROZESS_FEHLGESCHLAGEN");
          expect(run.reportPath).toBeNull();
        }
      } finally {
        cleanup(join(root, "child.pid"));
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  it("erhält Normalexit und die begrenzte stderr-Ausgabe", async () => {
    const result = await node('process.stderr.write("x".repeat(5000));');
    expect(result).toEqual({ code: 0, stderr: "x".repeat(4000), timedOut: false, error: null });
  });

  it("erhält einen Fehlerexit", async () => {
    expect(await node('process.stderr.write("fixture failure"); process.exitCode = 17;')).toEqual({
      code: 17,
      stderr: "fixture failure",
      timedOut: false,
      error: null,
    });
  });

  it("drainiert auch das stderr-Ende nach einem größeren Flush", async () => {
    const result = await node('process.stderr.write("x".repeat(128*1024)+"FINAL_MARKER",()=>{process.exitCode=17;});');
    expect(result.code).toBe(17);
    expect(result.stderr.length).toBe(4000);
    expect(result.stderr.endsWith("FINAL_MARKER")).toBe(true);
  });

  it("meldet einen nicht startbaren Prozess ohne hängende Timer", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const result = await runLighthouseProcess("/missing/quizmaster-lighthouse-fixture", [], { env: process.env });
    expect(result).toMatchObject({ code: null, timedOut: false, error: { code: "ENOENT" } });
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  it.skipIf(process.platform === "win32")(
    "beendet ein tatsächlich hängendes Kind innerhalb der Gesamtfrist",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qm-lighthouse-process-"));
      const pidFile = join(root, "child.pid");
      const code = `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
      const running = runLighthouseProcess(process.execPath, ["--input-type=module", "-e", code, pidFile], {
        env: process.env,
        timeoutMs: 300,
        killGraceMs: 100,
      });
      try {
        expect(await within(running, 1500)).toMatchObject({ code: null, timedOut: true, error: null });
      } finally {
        cleanup(pidFile);
        await within(running, 1000);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "eskaliert TERM-resistente Kinder und Enkel und erhält fremde Gruppen",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qm-lighthouse-family-"));
      const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      try {
        const result = await node(family(root, false), { timeoutMs: 700, killGraceMs: 100 });
        expect(result).toMatchObject({ code: null, timedOut: true, error: null });
        expect(readFileSync(join(root, "child.term"), "utf8")).toBe("TERM");
        expect(readFileSync(join(root, "grandchild.term"), "utf8")).toBe("TERM");
        await eventually(() => !alive(pid(join(root, "child.pid"))) && !alive(pid(join(root, "grandchild.pid"))));
        expect(foreign.pid).toBeTypeOf("number");
        expect(alive(foreign.pid ?? -1)).toBe(true);
      } finally {
        cleanup(join(root, "child.pid"));
        foreign.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "bereinigt resistente Enkel auch nach normalem Ende des Gruppenführers",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qm-lighthouse-orphan-"));
      try {
        expect(await node(family(root, true))).toMatchObject({ code: 0, timedOut: false, error: null });
        expect(readFileSync(join(root, "grandchild.term"), "utf8")).toBe("TERM");
        await eventually(() => !alive(pid(join(root, "grandchild.pid"))));
      } finally {
        cleanup(join(root, "child.pid"));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it.skipIf(process.platform === "win32")(`bereinigt die eigene Familie bei ${signal} an den Aufrufer`, async () => {
      const root = mkdtempSync(join(tmpdir(), "qm-lighthouse-interrupt-"));
      const helper = new URL("./lighthouse-process.ts", import.meta.url).href;
      const code = `import { runLighthouseProcess, LighthouseInterruptedError } from ${JSON.stringify(helper)};
        try { await runLighthouseProcess(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(family(root, false))}], {env:process.env, timeoutMs:5000, killGraceMs:100}); process.exitCode=99; }
        catch(error) { process.exitCode=error instanceof LighthouseInterruptedError ? (error.signal==="SIGINT"?130:143) : 98; }`;
      const parent = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
      let exitCode: number | null = null;
      parent.once("exit", (value) => {
        exitCode = value;
      });
      try {
        await eventually(() => {
          try {
            return alive(pid(join(root, "grandchild.pid")));
          } catch {
            return false;
          }
        });
        parent.kill(signal);
        await eventually(() => exitCode !== null);
        expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
        await eventually(() => !alive(pid(join(root, "child.pid"))) && !alive(pid(join(root, "grandchild.pid"))));
      } finally {
        cleanup(join(root, "child.pid"));
        parent.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("entfernt eigene Signalhandler nach erfolgreichem Ende", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await node("");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    expect(new LighthouseInterruptedError("SIGTERM").signal).toBe("SIGTERM");
  });
});
