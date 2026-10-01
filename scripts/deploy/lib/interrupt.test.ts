import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Echte Signale an einen eigenen Node-Prozess: genau so trifft ein SSH-Abbruch (SIGHUP) oder Strg+C das
// Deploy-Werkzeug. Der Kindprozess nutzt das Modul wie deploy.ts.
const moduleUrl = new URL("./interrupt.ts", import.meta.url).href;
const dir = mkdtempSync(join(tmpdir(), "qm-interrupt-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const script = (body: string) => {
  const file = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    file,
    `import { installInterrupts } from ${JSON.stringify(moduleUrl)};
const say = (line) => process.stdout.write(line + "\\n");
const interrupts = installInterrupts({ report: { warn: (m) => say("WARN " + m), fail: (m) => say("FAIL " + m) } });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
${body}
`,
  );
  return file;
};

interface Run {
  child: ChildProcess;
  lines: string[];
  waitFor(text: string): Promise<void>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(file: string): Run {
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      for (const waiter of waiters.filter((entry) => line.includes(entry.text))) waiter.resolve();
    }
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    lines,
    done,
    waitFor: (text) =>
      lines.some((line) => line.includes(text))
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ text, resolve })),
  };
}

const kill = (run: Run, signal: NodeJS.Signals) => run.child.kill(signal);

describe("installInterrupts", () => {
  it("SIGHUP (SSH-Abbruch) beendet den Prozess nicht – der kritische Abschnitt läuft zu Ende, Exit 129", async () => {
    const run = start(
      script(`await interrupts.critical(async () => {
  say("ACTIVATING");
  await pause(800);
  say("ACTIVATED");
});
say("AFTER " + interrupts.signal);
process.exit(interrupts.exitCode() ?? 0);`),
    );
    await run.waitFor("ACTIVATING");
    kill(run, "SIGHUP");
    const result = await run.done;
    expect(result.signal).toBeNull();
    expect(result.code).toBe(129);
    expect(run.lines).toContain("ACTIVATED");
    expect(run.lines).toContain("AFTER SIGHUP");
  });

  it("ein zweites Strg+C während der Aktivierung erzwingt kein Ende (erst danach, mit Exit 130)", async () => {
    const run = start(
      script(`await interrupts.critical(async () => {
  say("ACTIVATING");
  await pause(1200);
  say("ACTIVATED");
});
process.exit(interrupts.exitCode() ?? 0);`),
    );
    await run.waitFor("ACTIVATING");
    kill(run, "SIGINT");
    await run.waitFor("WARN");
    kill(run, "SIGINT");
    kill(run, "SIGTERM");
    const result = await run.done;
    expect(result.code).toBe(130);
    expect(run.lines).toContain("ACTIVATED");
    expect(run.lines.some((line) => line.startsWith("FAIL"))).toBe(false);
    expect(run.lines.filter((line) => line.includes("Aktivierung läuft")).length).toBeGreaterThanOrEqual(1);
  });

  it("außerhalb eines kritischen Abschnitts beendet ein zweites Strg+C sofort", async () => {
    const run = start(
      script(`say("BUILDING");
await pause(5_000);
say("NOT-REACHED");`),
    );
    await run.waitFor("BUILDING");
    kill(run, "SIGINT");
    await run.waitFor("WARN");
    kill(run, "SIGINT");
    const result = await run.done;
    expect(result.code).toBe(130);
    expect(run.lines).not.toContain("NOT-REACHED");
    expect(run.lines.some((line) => line.startsWith("FAIL"))).toBe(true);
  });

  it("wiederholtes SIGHUP (Kernel + Shell senden es oft zweimal) erzwingt kein Ende", async () => {
    const run = start(
      script(`say("BUILDING");
await pause(700);
say("STILL-RUNNING");
process.exit(interrupts.exitCode() ?? 0);`),
    );
    await run.waitFor("BUILDING");
    kill(run, "SIGHUP");
    await run.waitFor("WARN");
    kill(run, "SIGHUP");
    const result = await run.done;
    expect(result.code).toBe(129);
    expect(run.lines).toContain("STILL-RUNNING");
  });

  it("checkpoint wirft INTERRUPTED, sobald ein Abbruch vorgemerkt ist", async () => {
    const run = start(
      script(`interrupts.checkpoint("vorher");
say("CHECK-1 ok");
say("WAITING");
await pause(600);
try {
  interrupts.checkpoint("abgebrochen vor der Aktivierung");
  say("CHECK-2 ok");
} catch (error) {
  say("CHECK-2 " + error.code + " " + error.message);
}
process.exit(0);`),
    );
    await run.waitFor("WAITING");
    kill(run, "SIGTERM");
    await run.done;
    expect(run.lines).toContain("CHECK-1 ok");
    expect(run.lines).toContain("CHECK-2 INTERRUPTED abgebrochen vor der Aktivierung");
  });
});
