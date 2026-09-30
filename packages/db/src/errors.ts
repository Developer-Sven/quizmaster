/**
 * Server-Fehlercodes, die die Datenschicht gezielt behandelt (MongoDB `error_codes.yml`).
 * Alles andere wird unverändert weitergeworfen.
 */
export const MONGO_ERROR_CODES = {
  badValue: 2,
  failedToParse: 9,
  unauthorized: 13,
  namespaceNotFound: 26,
  namespaceExists: 48,
  indexOptionsConflict: 85,
  indexKeySpecsConflict: 86,
  documentValidationFailure: 121,
  invalidResumeToken: 260,
  changeStreamFatalError: 280,
  changeStreamHistoryLost: 286,
  duplicateKey: 11000,
} as const;

/** Numerischer Server-Fehlercode oder `undefined`. */
export function mongoErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

export function hasMongoErrorCode(error: unknown, code: number): boolean {
  return mongoErrorCode(error) === code;
}

/**
 * true bei E11000 (Duplicate Key). Mit `field` nur, wenn der Konflikt dieses Feld betrifft
 * (`keyPattern` des Servers, z. B. `code` beim partiellen Unique-Index auf aktive Lobbys).
 */
export function isDuplicateKeyError(error: unknown, field?: string): boolean {
  if (!hasMongoErrorCode(error, MONGO_ERROR_CODES.duplicateKey)) return false;
  if (field === undefined) return true;
  const keyPattern = (error as { keyPattern?: unknown }).keyPattern;
  if (typeof keyPattern === "object" && keyPattern !== null) return Object.hasOwn(keyPattern, field);
  const message = error instanceof Error ? error.message : "";
  return message.includes(`index: ${field}`) || message.includes(`{ ${field}:`);
}

/** Fehlendes Recht (z. B. `collMod` ohne dbAdmin-Rolle). */
export function isUnauthorizedError(error: unknown): boolean {
  return hasMongoErrorCode(error, MONGO_ERROR_CODES.unauthorized);
}
