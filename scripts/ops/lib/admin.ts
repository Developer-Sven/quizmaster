/**
 * Reine Logik der Admin-CLI (scripts/ops/admin.ts): Argumente → validierte appConfig-Patches und Ban-Ziele.
 * Die endgültige Validierung übernehmen die Repositories (`appConfigPatchSchema`, `newBanSchema`).
 */
import type { AppConfigPatch } from "@quizmaster/db";
import { type AppConfigDoc, BAN_KINDS, type BanDoc, type BanKind } from "@quizmaster/shared/documents";
import { ipKey, ipKeySubject } from "@quizmaster/shared/ip";

export class AdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminUsageError";
  }
}

export const CONFIG_KEYS = [
  "lobbyCreationEnabled",
  "turnstileOnJoin",
  "maxActiveLobbies",
  "minClientProtocol",
  "maintenance",
  "maintenanceMessage",
] as const;

const BOOLEANS: Readonly<Record<string, boolean>> = { true: true, false: false, on: true, off: false };

function parseBool(key: string, value: string): boolean {
  const parsed = BOOLEANS[value.trim().toLowerCase()];
  if (parsed === undefined) throw new AdminUsageError(`${key}: true/false (bzw. on/off) erwartet`);
  return parsed;
}

function parseInteger(key: string, value: string): number {
  if (!/^\d{1,7}$/.test(value.trim())) throw new AdminUsageError(`${key}: ganze Zahl ≥ 0 erwartet`);
  return Number.parseInt(value.trim(), 10);
}

/**
 * `schlüssel=wert`-Zuweisungen → appConfig-Patch. `maintenance=on|off` (optional mit `maintenanceMessage=…`)
 * ergibt das Objekt `{ enabled, message }`; beim Ausschalten wird die Meldung entfernt.
 */
export function parseConfigAssignments(assignments: readonly string[]): AppConfigPatch {
  const patch: AppConfigPatch = {};
  let maintenance: boolean | undefined;
  let message: string | null | undefined;
  for (const assignment of assignments) {
    const index = assignment.indexOf("=");
    if (index <= 0) throw new AdminUsageError(`„${assignment}“: Schlüssel=Wert erwartet`);
    const key = assignment.slice(0, index);
    const value = assignment.slice(index + 1);
    switch (key) {
      case "lobbyCreationEnabled":
      case "turnstileOnJoin":
        patch[key] = parseBool(key, value);
        break;
      case "maxActiveLobbies":
      case "minClientProtocol":
        patch[key] = parseInteger(key, value);
        break;
      case "maintenance":
        maintenance = parseBool(key, value);
        break;
      case "maintenanceMessage":
        message = value.trim() === "" ? null : value.trim();
        break;
      default:
        throw new AdminUsageError(`unbekannter Schlüssel ${key} (erlaubt: ${CONFIG_KEYS.join(", ")})`);
    }
  }
  if (message !== undefined && maintenance === undefined) {
    throw new AdminUsageError("maintenanceMessage nur zusammen mit maintenance=on|off");
  }
  if (maintenance !== undefined)
    patch.maintenance = { enabled: maintenance, message: maintenance ? (message ?? null) : null };
  if (Object.keys(patch).length === 0) throw new AdminUsageError("mindestens eine Zuweisung angeben");
  return patch;
}

/** Blockliste ergänzen/kürzen (Vergleich ohne Groß-/Kleinschreibung); liefert die neue Liste. */
export function updateBlockedTerms(current: readonly string[], action: string, terms: readonly string[]): string[] {
  const cleaned = terms.map((term) => term.trim()).filter((term) => term !== "");
  if (cleaned.length === 0) throw new AdminUsageError("mindestens einen Begriff angeben");
  const key = (term: string) => term.toLocaleLowerCase("de-DE");
  if (action === "add") {
    const known = new Set(current.map(key));
    return [...current, ...cleaned.filter((term, index) => !known.has(key(term)) && cleaned.indexOf(term) === index)];
  }
  if (action === "remove") {
    const doomed = new Set(cleaned.map(key));
    return current.filter((term) => !doomed.has(key(term)));
  }
  throw new AdminUsageError("block-term erwartet add oder remove");
}

/** Lesbare Zusammenfassung der Kill-Switches (ohne Inhalt der Blockliste). */
export function describeConfig(config: AppConfigDoc): string[] {
  return [
    `lobbyCreationEnabled  ${config.lobbyCreationEnabled}`,
    `turnstileOnJoin       ${config.turnstileOnJoin}`,
    `maxActiveLobbies      ${config.maxActiveLobbies}`,
    `minClientProtocol     ${config.minClientProtocol}`,
    `maintenance           ${config.maintenance.enabled ? `an – „${config.maintenance.message ?? ""}“` : "aus"}`,
    `blockedTerms          ${config.blockedTerms.length} Begriffe`,
    `updatedAt             ${config.updatedAt.toISOString()}`,
  ];
}

export interface BanTarget {
  kind: BanKind;
  /** Gespeicherter Wert: guestId bzw. IP-Schlüssel (HMAC, nie die rohe IP – docs/06). */
  value: string;
  label: string;
}

const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Genau eines von `--guest <guestId>` oder `--ip <adresse>`; IPs werden wie in Web/Realtime geschlüsselt. */
export function banTarget(options: { guest?: string; ip?: string }, ipHashSecret: string): BanTarget {
  if ((options.guest === undefined) === (options.ip === undefined)) {
    throw new AdminUsageError("genau eines angeben: --guest <guestId> oder --ip <adresse>");
  }
  if (options.guest !== undefined) {
    const guest = options.guest.trim().toLowerCase();
    if (!GUEST_ID.test(guest)) throw new AdminUsageError("--guest erwartet eine guestId (UUID)");
    return { kind: "guest", value: guest, label: `Gast ${guest}` };
  }
  const ip = (options.ip ?? "").trim();
  const key = ipKey(ip, ipHashSecret);
  const subject = ipKeySubject(ip);
  if (key === null || subject === null) throw new AdminUsageError("--ip: keine gültige IPv4-/IPv6-Adresse");
  return { kind: "ip", value: key, label: `IP ${subject} (Schlüssel ${key.slice(0, 8)}…)` };
}

/** `--hours <n>` → Ablaufzeitpunkt (fehlt = dauerhaft). */
export function banExpiry(hours: string | undefined, now: Date): Date | undefined {
  if (hours === undefined) return undefined;
  if (!/^\d{1,5}$/.test(hours) || Number.parseInt(hours, 10) < 1 || Number.parseInt(hours, 10) > 24 * 366) {
    throw new AdminUsageError("--hours: ganze Zahl von 1 bis 8784");
  }
  return new Date(now.getTime() + Number.parseInt(hours, 10) * 3_600_000);
}

export function describeBan(ban: BanDoc): string {
  const until = ban.expiresAt ? `bis ${ban.expiresAt.toISOString()}` : "dauerhaft";
  return `${BAN_KINDS.includes(ban.kind) ? ban.kind : "?"}-Sperre ${until}, Grund „${ban.reason}“, seit ${ban.createdAt.toISOString()}`;
}

/** Schreiben in eine Produktionsdatenbank nur mit ausdrücklicher Bestätigung. */
export function assertWriteAllowed(database: string, confirmed: boolean): void {
  const nonProduction = database.endsWith("_dev") || database.endsWith("_test");
  if (!nonProduction && !confirmed) {
    throw new AdminUsageError(`Schreiben in ${database} (Produktion) nur mit --confirm-prod`);
  }
}
