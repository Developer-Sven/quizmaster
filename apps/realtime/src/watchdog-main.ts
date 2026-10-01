// Einstieg für pm2 (`quizmaster-watchdog`, dist/watchdog.mjs). Startet bedingungslos: pm2 lädt Programme im Fork-Modus
// über einen eigenen Wrapper, process.argv[1] zeigt dann nicht auf diese Datei (eine argv-Prüfung startete nie).
import { runWatchdog } from "./watchdog.ts";

runWatchdog().catch((error: unknown) => {
  console.error("watchdog – unerwarteter Fehler beim Start", error instanceof Error ? error.message : error);
  process.exit(1);
});
