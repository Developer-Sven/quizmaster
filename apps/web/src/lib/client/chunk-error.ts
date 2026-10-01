/**
 * Fehler beim Nachladen von JavaScript (Netzabbruch auf dem Weg zur Lobby, neuer Deploy mit anderen
 * Dateinamen): Der Modul-Lader merkt sich den gescheiterten Chunk – `retry()` der Fehlerseite rendert nur neu
 * und scheitert sofort wieder, auch wenn das Netz längst zurück ist. Abhilfe ist ein vollständiges Neuladen.
 *
 * Erkannt werden Turbopack („ChunkLoadError: Failed to load chunk …“), webpack („Loading chunk 12 failed.“,
 * „Loading CSS chunk …“) und native dynamische Importe („Failed to fetch dynamically imported module“).
 */
const CHUNK_FAILURE =
  /Failed to load chunk|Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i;

/** `true`, wenn der Fehler vom Nachladen eines Code-Chunks stammt (dann hilft nur Neuladen). */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_FAILURE.test(error.message);
}
