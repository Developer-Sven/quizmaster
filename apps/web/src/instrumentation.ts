/**
 * Server-Start (Next ruft `register` einmal pro Serverinstanz auf, bevor Requests bedient werden):
 * Start-Checks nach docs/02 – nur zur Laufzeit, nie beim Build (`next build` ruft `register` nicht auf;
 * zusätzlich hier abgesichert). Bei Fehlern beendet sich der Prozess mit klarer Meldung (fail fast).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { runWebStartupChecks } = await import("./lib/server/startup");
  await runWebStartupChecks();
}
