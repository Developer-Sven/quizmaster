import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { getWebEnv } from "../env";
import { robotsFile } from "../lib/server/site-metadata";

/**
 * `/robots.txt` (ADR-030): `SEARCH_INDEXING` aus → `Disallow: /`; an → `Allow: /` ohne Lobbys, Kurzlinks, API,
 * Entwicklungs- und Offline-Seite (`lib/server/site-metadata.ts`). Bewusst dynamisch (`connection()`): Der Wert
 * kommt aus der Laufzeit-Env (ADR-023) – statisch vorgerendert stünde hier immer der Wert des Builds, der ohne
 * Env läuft.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  return robotsFile(getWebEnv());
}
