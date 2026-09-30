/** Kleine CLI-Helfer der Content-Skripte (Argumente, Abbruch mit Meldung). */
import { type ParseArgsConfig, parseArgs } from "node:util";

/** Beendet mit Fehlermeldung (Exit-Code 1 = fachlicher Fehler, 2 = Aufruf falsch). */
export function fail(message: string, exitCode = 1): never {
  console.error(message);
  process.exit(exitCode);
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** parseArgs mit verständlicher Meldung statt Stacktrace bei unbekannten/fehlerhaften Argumenten. */
export function parseCli<T extends Options>(options: T, usage: string, args: string[] = process.argv.slice(2)) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`${message}\n\nAufruf: ${usage}`, 2);
  }
}
