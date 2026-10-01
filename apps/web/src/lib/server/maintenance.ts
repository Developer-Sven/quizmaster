/**
 * Wartungshinweis für die Seiten (docs/06 §Kill-Switches, docs/09 §11 „Wartung (Banner)“, docs/12 Runbook „MongoDB
 * nicht erreichbar → Wartungsbanner“): serverseitig ermittelt und als Prop an die Client-Komponenten gegeben
 * (ADR-023, kein Inline-Script).
 *
 * - `appConfig.maintenance.enabled` → Hinweis mit `appConfig.maintenance.message` (sonst Standardtext im Banner).
 * - Datenbank nicht erreichbar (Health-Ping oder Lesen scheitert/dauert zu lange) → Hinweis ohne Text – neue
 *   Sessions und Lobbys schlagen dann ohnehin fehl. Der Client erfährt nie den Grund (keine Details).
 *
 * Zwischengespeichert (10 s, stale-while-revalidate): Seiten warten nur beim allerersten Aufruf auf die Datenbank;
 * danach liefert der Cache sofort und eine Aktualisierung läuft im Hintergrund (Fehler werden geloggt).
 */
import { APP_CONFIG_ID } from "@quizmaster/shared/documents";
import { connection } from "next/server";
import { z } from "zod";
import { getServerContext, type ServerContext } from "./context";

/** Öffentlicher Wartungshinweis (Client importiert nur den Typ). `message: null` = Standardtext. */
export interface MaintenanceNotice {
  message: string | null;
}

export const MAINTENANCE_CACHE_MS = 10_000;
/** Frist für das Lesen von appConfig (Seiten sollen bei hängender Datenbank nicht warten). */
export const MAINTENANCE_READ_TIMEOUT_MS = 1_500;

const maintenanceSchema = z.object({
  maintenance: z.object({ enabled: z.boolean(), message: z.string().max(200).nullable() }),
});

/** Hinweis bei nicht erreichbarer Datenbank (Standardtext, ohne Grund). */
export const DATABASE_DOWN_NOTICE: MaintenanceNotice = Object.freeze({ message: null });

export type MaintenanceSource = Pick<ServerContext, "data" | "health" | "logger" | "now">;

export interface MaintenanceProbe {
  /** Aktueller Hinweis oder `null` (kein Banner). Wirft nie. */
  current(): Promise<MaintenanceNotice | null>;
}

async function withDeadline<T>(task: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createMaintenanceProbe(
  source: MaintenanceSource,
  options: { cacheMs?: number; readTimeoutMs?: number } = {},
): MaintenanceProbe {
  const cacheMs = options.cacheMs ?? MAINTENANCE_CACHE_MS;
  const readTimeoutMs = options.readTimeoutMs ?? MAINTENANCE_READ_TIMEOUT_MS;
  let cached: { notice: MaintenanceNotice | null; at: number } | undefined;
  let inflight: Promise<MaintenanceNotice | null> | undefined;
  let lastWasOutage = false;

  const read = async (): Promise<MaintenanceNotice | null> => {
    if (!(await source.health.check())) return DATABASE_DOWN_NOTICE;
    const doc = await withDeadline(
      source.data.collections.appConfig.findOne(
        { _id: APP_CONFIG_ID },
        { projection: { maintenance: 1 }, maxTimeMS: readTimeoutMs },
      ),
      readTimeoutMs + 500,
    );
    if (doc === "timeout") return DATABASE_DOWN_NOTICE;
    // Fehlt das Dokument (frische Datenbank), gilt der Startwert „keine Wartung“.
    if (doc === null) return null;
    const parsed = maintenanceSchema.safeParse(doc);
    if (!parsed.success) {
      source.logger.error("appConfig.maintenance ungültig – kein Wartungshinweis");
      return null;
    }
    return parsed.data.maintenance.enabled ? { message: parsed.data.maintenance.message } : null;
  };

  const refresh = (): Promise<MaintenanceNotice | null> => {
    inflight ??= read()
      .catch((error: unknown) => {
        // Datenbank weg (Netz, Server-Auswahl, Zeitüberschreitung): Wartungsbanner statt Fehlerseite. Nur der
        // Fehlername – Treibermeldungen enthalten Hostnamen und Adressen.
        source.logger.warn(
          { detail: error instanceof Error ? error.name : "Fehler" },
          "Wartungsstatus nicht lesbar – Wartungshinweis",
        );
        return DATABASE_DOWN_NOTICE;
      })
      .then((notice) => {
        const outage = notice === DATABASE_DOWN_NOTICE;
        if (outage !== lastWasOutage) {
          if (outage) source.logger.warn("Datenbank nicht erreichbar – Seiten zeigen den Wartungshinweis");
          else source.logger.info("Datenbank wieder erreichbar – Wartungshinweis aus dem Speicher entfernt");
          lastWasOutage = outage;
        }
        cached = { notice, at: source.now() };
        return notice;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  return {
    current() {
      if (cached === undefined) return refresh();
      if (source.now() - cached.at >= cacheMs) void refresh();
      return Promise.resolve(cached.notice);
    },
  };
}

let probe: MaintenanceProbe | undefined;

/**
 * Wartungshinweis für die aktuelle Seite (nur in Server-Komponenten aufrufen). Wartet auf den Request
 * (`connection()`): nie beim Build, die Seite ist ohnehin dynamisch (Nonce-CSP, ADR-008). Eine ungültige Env (sollte
 * der Start-Check verhindern) zeigt den Hinweis statt einer Fehlerseite – geloggt wird nur der Fehlername.
 */
export async function getMaintenanceNotice(): Promise<MaintenanceNotice | null> {
  await connection();
  try {
    probe ??= createMaintenanceProbe(getServerContext());
  } catch (error) {
    console.error("Wartungsstatus nicht prüfbar:", error instanceof Error ? error.name : "unbekannt");
    return DATABASE_DOWN_NOTICE;
  }
  return probe.current();
}
