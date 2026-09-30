/**
 * Sperre gegen parallele Deploys/Rollbacks (`.deploy/deploy.lock`, O_EXCL). Eine liegengebliebene Sperre
 * eines beendeten Prozesses wird übernommen.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { DeployError, warn } from "./log.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Lock {
  release(): void;
}

export function acquireLock(file: string, command: string): Lock {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: unknown; command?: unknown } = {};
      try {
        holder = JSON.parse(readFileSync(file, "utf8")) as typeof holder;
      } catch {
        // unlesbar → wie verwaist behandeln
      }
      const pid = typeof holder.pid === "number" ? holder.pid : 0;
      if (pid > 0 && alive(pid)) {
        throw new DeployError(
          "LOCKED",
          `läuft bereits (PID ${pid}, ${typeof holder.command === "string" ? holder.command : "?"})`,
        );
      }
      warn(`verwaiste Deploy-Sperre (PID ${pid || "?"}) wird übernommen`);
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }
  throw new DeployError("LOCKED", "Deploy-Sperre nicht erhältlich");
}
