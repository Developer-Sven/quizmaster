// Regressionstest Go-live 01.10.2026: pm2 lädt Programme im Fork-Modus über einen eigenen Wrapper – process.argv[1]
// zeigt dann auf den Wrapper, nicht auf dist/watchdog.mjs. Der Watchdog muss trotzdem starten (vorher beendete er
// sich ohne Ausgabe, pm2 startete ihn endlos neu, der Deploy-Smoke-Test meldete APP_RESTARTED).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("./watchdog-main.ts", import.meta.url));

describe("watchdog-main (Einstieg für pm2)", () => {
  it("startet auch, wenn ein Wrapper das Modul lädt (argv[1] ≠ Einstiegsdatei)", () => {
    // Wie pm2s ProcessContainerFork: ein anderes Skript importiert den Einstieg. Ohne Env muss main() laufen und mit
    // „Env ungültig“ und Exit 1 abbrechen – ein stilles Exit 0 hieße, dass der Watchdog gar nicht gestartet ist.
    const wrapper = `await import(${JSON.stringify(`file://${ENTRY}`)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", wrapper], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 30_000,
    });
    expect(result.stderr).toContain("watchdog – Env ungültig");
    expect(result.status).toBe(1);
  });
});
