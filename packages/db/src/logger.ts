/**
 * Minimale Logger-Schnittstelle der Datenschicht. Nur Text-Nachrichten – kompatibel mit `console` und
 * pino (`logger.info("…")`). Nachrichten enthalten nie Zugangsdaten: URIs nur über `maskMongoUri`.
 */
export interface DbLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Standard-Logger: Konsole (info/warn/error). */
export const consoleLogger: DbLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** Verwirft alle Meldungen (z. B. in Tests, die Warnungen gezielt prüfen). */
export const silentLogger: DbLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Kurzbeschreibung eines Fehlers für Logs (Name + Code + Nachricht, ohne Stack). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  const codeName = (error as { codeName?: unknown }).codeName;
  const codePart = code === undefined ? "" : ` [${String(code)}${typeof codeName === "string" ? ` ${codeName}` : ""}]`;
  return `${error.name}${codePart}: ${error.message}`;
}
