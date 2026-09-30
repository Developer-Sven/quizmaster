/**
 * Ausgabe des Deploy-Werkzeugs (ADR-025): Schritte, Status und Fehlercodes – nie Werte aus Env-Dateien,
 * nie Ausgaben, die Secrets enthalten könnten (pm2-Env, Mongo-URIs).
 */

/** Erwarteter Fehler mit festem Code; `message` enthält nur Schlüsselnamen, Pfade und Status. */
export class DeployError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeployError";
    this.code = code;
  }
}

const PREFIX = "deploy –";

export function step(title: string): void {
  console.log(`\n${PREFIX} ${title}`);
}

export function info(message: string): void {
  console.log(`  ${message}`);
}

export function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

export function warn(message: string): void {
  console.warn(`  ! WARNUNG ${message}`);
}

export function fail(message: string): void {
  console.error(`  ✗ ${message}`);
}

/** Kurzform eines Commits für Ausgaben. */
export function short(sha: string): string {
  return sha.slice(0, 12);
}

/** Zeitstempel für Verzeichnisnamen (lokale Zeit, wie die übrigen Server-Backups): 20261001-031500. */
export function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Fehlermeldung ohne Stack für Benutzerausgaben. */
export function describeError(error: unknown): string {
  if (error instanceof DeployError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
