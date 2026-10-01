/**
 * Logik der Admin-CLI (scripts/ops/admin.ts, docs/06 §Notfall-Runbook): Argumente → validierte appConfig-Patches
 * und Ban-Ziele, Gast-Suche (Lobby-Snapshot, Meldung), Ausgabe ohne Secrets und ohne guestIds im Klartext (nur
 * gekürzt) sowie das Bereinigen von Abnahme-/Testspielen (`admin:game purge`). Die endgültige Validierung der
 * Schreibzugriffe übernehmen die Repositories (`appConfigPatchSchema`, `newBanSchema`); die Bereinigung läuft in
 * EINER Transaktion und ist idempotent.
 */
import type { AppConfigPatch, Collections } from "@quizmaster/db";
import { formatLobbyCode, guestIdSchema, lobbyCodeInputSchema, nameInputSchema, nameKey } from "@quizmaster/shared";
import {
  type AppConfigDoc,
  BAN_KINDS,
  type BanDoc,
  type BanKind,
  documentIdSchema,
  type GameDoc,
  type QuestionDoc,
  questionRatingId,
} from "@quizmaster/shared/documents";
import { ipKey, ipKeySubject } from "@quizmaster/shared/ip";
import type { AnyBulkWriteOperation, ClientSession, Document, MongoClient } from "mongodb";
import type { z } from "zod";

export class AdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminUsageError";
  }
}

/** Parst mit zod; Fehler werden zu einer Bedienungs-Fehlermeldung (ohne Eingabewert). */
function parseInput<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AdminUsageError(message);
  return parsed.data;
}

/** Gekürzte Darstellung geheimer bzw. langer IDs (guestId, IP-Schlüssel): erste 8 Zeichen. */
export function shortId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

// --- appConfig ------------------------------------------------------------------------------------------------------

export const CONFIG_KEYS = [
  "lobbyCreationEnabled",
  "turnstileOnJoin",
  "maxActiveLobbies",
  "minClientProtocol",
  "maintenance",
  "maintenanceMessage",
] as const;

/** Höchstlänge des Wartungstexts (appConfig.maintenance.message). */
export const MAINTENANCE_MESSAGE_MAX = 200;

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

function maintenanceMessage(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length > MAINTENANCE_MESSAGE_MAX) {
    throw new AdminUsageError(`Wartungstext: höchstens ${MAINTENANCE_MESSAGE_MAX} Zeichen`);
  }
  return trimmed === "" ? null : trimmed;
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
        message = maintenanceMessage(value);
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

/** `admin:config maintenance on "<text>"` bzw. `off` → Patch (Text optional, sonst Standardtext im Banner). */
export function maintenancePatch(mode: string | undefined, text: readonly string[]): AppConfigPatch {
  if (mode === "on") return { maintenance: { enabled: true, message: maintenanceMessage(text.join(" ")) } };
  if (mode === "off") {
    if (text.length > 0) throw new AdminUsageError("maintenance off erwartet keinen Text");
    return { maintenance: { enabled: false, message: null } };
  }
  throw new AdminUsageError('maintenance erwartet on "<text>" oder off');
}

/**
 * Warnung, wenn `turnstileOnJoin` eingeschaltet wird, die Env-Datei aber keine Turnstile-Schlüssel hat – dann
 * könnte niemand mehr Lobbys erstellen oder beitreten (das Widget braucht den Site Key, Web das Secret).
 */
export function turnstileWarning(
  patch: AppConfigPatch,
  env: { TURNSTILE_SITE_KEY?: string | undefined; TURNSTILE_SECRET_KEY?: string | undefined },
): string | null {
  if (patch.turnstileOnJoin !== true) return null;
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) return null;
  return (
    "Warnung: TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY fehlen in der Env-Datei – mit turnstileOnJoin=true kann " +
    "niemand Lobbys erstellen oder beitreten, bis Turnstile im Web konfiguriert ist"
  );
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
  throw new AdminUsageError("block-term erwartet add, remove oder list");
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

/** `block-term list`: die Begriffe der Live-Blockliste, alphabetisch (nur auf ausdrückliche Anfrage). */
export function describeBlockedTerms(terms: readonly string[]): string[] {
  if (terms.length === 0) return ["(keine Begriffe)"];
  return [...terms].sort((a, b) => a.localeCompare(b, "de-DE"));
}

// --- Sperren --------------------------------------------------------------------------------------------------------

export interface BanTarget {
  kind: BanKind;
  /** Gespeicherter Wert: guestId bzw. IP-Schlüssel (HMAC, nie die rohe IP – docs/06). */
  value: string;
  /** Anzeige ohne guestId im Klartext (gekürzt). */
  label: string;
}

/** Ziel-Optionen von `admin:ban`: genau eines von Gast, IP, Lobby + Name oder Meldung. */
export interface BanTargetOptions {
  guest?: string | undefined;
  ip?: string | undefined;
  lobby?: string | undefined;
  name?: string | undefined;
  report?: string | undefined;
}

/** Collections für die Gast-Suche. */
export type GuestLookupCollections = Pick<Collections, "lobbies" | "questionReports">;

/** Genau eines von `--guest <guestId>` oder `--ip <adresse>`; IPs werden wie in Web/Realtime geschlüsselt. */
export function banTarget(options: { guest?: string; ip?: string }, ipHashSecret: string): BanTarget {
  if ((options.guest === undefined) === (options.ip === undefined)) {
    throw new AdminUsageError("genau eines angeben: --guest <guestId> oder --ip <adresse>");
  }
  if (options.guest !== undefined) {
    const guest = parseInput(guestIdSchema, options.guest.trim().toLowerCase(), "--guest erwartet eine guestId (UUID)");
    return { kind: "guest", value: guest, label: `Gast ${shortId(guest)}` };
  }
  const ip = (options.ip ?? "").trim();
  const key = ipKey(ip, ipHashSecret);
  const subject = ipKeySubject(ip);
  if (key === null || subject === null) throw new AdminUsageError("--ip: keine gültige IPv4-/IPv6-Adresse");
  return { kind: "ip", value: key, label: `IP ${subject} (Schlüssel ${shortId(key)})` };
}

/** Welche Ziel-Art die Optionen beschreiben (prüft „genau eines“ vor jeder Verbindung). */
export function banTargetKind(options: BanTargetOptions): "guest" | "ip" | "lobby" | "report" {
  if (options.name !== undefined && options.lobby === undefined) throw new AdminUsageError("--name nur mit --lobby");
  if (options.lobby !== undefined && options.name === undefined) throw new AdminUsageError("--lobby braucht --name");
  const given = (["guest", "ip", "lobby", "report"] as const).filter((key) => options[key] !== undefined);
  if (given.length !== 1) {
    throw new AdminUsageError(
      "genau ein Ziel angeben: --guest <guestId> | --ip <adresse> | --lobby <code> --name <name> | --report <id>",
    );
  }
  return given[0] as "guest" | "ip" | "lobby" | "report";
}

/**
 * `--lobby <code> --name <name>`: Gast aus dem Lobby-Snapshot (aktive Lobby zuerst, sonst die zuletzt geänderte
 * mit diesem Code – Snapshots leben bis 2 h nach Spielende). Name exakt oder ohne Groß-/Kleinschreibung.
 */
export async function findGuestInLobby(
  collections: GuestLookupCollections,
  rawCode: string,
  rawName: string,
): Promise<BanTarget> {
  const code = parseInput(lobbyCodeInputSchema, rawCode, "--lobby: ungültiger Lobby-Code");
  const name = parseInput(nameInputSchema, rawName, "--name: 1–64 Zeichen").trim();
  const display = formatLobbyCode(code);
  const lobby = await collections.lobbies
    .find({ code }, { projection: { players: 1, active: 1, updatedAt: 1 } })
    .sort({ active: -1, updatedAt: -1 })
    .limit(1)
    .next();
  if (lobby === null)
    throw new AdminUsageError(`Lobby ${display} nicht gefunden (Snapshots leben bis 2 h nach Spielende)`);
  const players = lobby.players;
  const exact = players.filter((player) => player.name === name);
  const matches = exact.length > 0 ? exact : players.filter((player) => nameKey(player.name) === nameKey(name));
  const [match, ...others] = matches;
  if (match === undefined) {
    const names = players.map((player) => `„${player.name}“`).join(", ") || "niemand";
    throw new AdminUsageError(`„${name}“ ist nicht in Lobby ${display} – vorhanden: ${names}`);
  }
  if (others.length > 0) throw new AdminUsageError(`„${name}“ ist in Lobby ${display} nicht eindeutig`);
  if (match.isBot) throw new AdminUsageError(`„${match.name}“ ist ein Dev-Bot (keine Sperre nötig)`);
  const guestId = parseInput(guestIdSchema, match.guestId, "Snapshot enthält keine gültige guestId");
  return { kind: "guest", value: guestId, label: `Gast „${match.name}“ aus Lobby ${display} (${shortId(guestId)})` };
}

/** `--report <id>`: Gast, der eine Meldung abgegeben hat (Missbrauch über Meldungen). */
export async function findGuestOfReport(collections: GuestLookupCollections, rawId: string): Promise<BanTarget> {
  const id = parseInput(documentIdSchema, rawId.trim(), "--report: ungültige Meldungs-ID");
  const report = await collections.questionReports.findOne({ _id: id }, { projection: { guestId: 1 } });
  if (report === null) throw new AdminUsageError(`Meldung ${id} nicht gefunden (Meldungen leben 365 Tage)`);
  const guestId = parseInput(guestIdSchema, report.guestId, "Meldung enthält keine gültige guestId");
  return { kind: "guest", value: guestId, label: `Gast der Meldung ${id} (${shortId(guestId)})` };
}

/** Ziel einer Sperre aus den Optionen (Gast, IP, Lobby + Name oder Meldung). */
export async function resolveBanTarget(
  options: BanTargetOptions,
  ipHashSecret: string,
  collections: GuestLookupCollections,
): Promise<BanTarget> {
  switch (banTargetKind(options)) {
    case "guest":
      return banTarget({ guest: options.guest }, ipHashSecret);
    case "ip":
      return banTarget({ ip: options.ip }, ipHashSecret);
    case "lobby":
      return findGuestInLobby(collections, options.lobby ?? "", options.name ?? "");
    case "report":
      return findGuestOfReport(collections, options.report ?? "");
  }
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

/** Eine Zeile der Liste aktiver Sperren – Gast/IP-Schlüssel nur gekürzt. */
export function describeBanLine(ban: BanDoc): string {
  const until = ban.expiresAt ? `bis ${ban.expiresAt.toISOString()}` : "dauerhaft";
  return `${ban.kind.padEnd(5)} ${shortId(ban.value).padEnd(9)} ${until.padEnd(28)} „${ban.reason}“ (seit ${ban.createdAt.toISOString()})`;
}

/** Schreiben in eine Produktionsdatenbank nur mit ausdrücklicher Bestätigung. */
export function assertWriteAllowed(database: string, confirmed: boolean): void {
  const nonProduction = database.endsWith("_dev") || database.endsWith("_test");
  if (!nonProduction && !confirmed) {
    throw new AdminUsageError(`Schreiben in ${database} (Produktion) nur mit --confirm-prod`);
  }
}

// --- Abnahme-/Testspiele bereinigen (admin:game purge) --------------------------------------------------------------

/** Frist der Bereinigungs-Transaktion (inkl. Wiederholungen). */
export const PURGE_TIMEOUT_MS = 30_000;
const PURGE_CHUNK = 500;

/** Collections, die `admin:game purge` liest und schreibt. */
export type PurgeCollections = Pick<
  Collections,
  "games" | "lobbies" | "questions" | "questionRatings" | "questionReports" | "guests"
>;

/** Wirkung einer Bereinigung – nur Anzahlen, keine guestIds. */
export interface PurgeSummary {
  code: string;
  /** Beendete Spiele mit diesem Code, die bereinigt werden. */
  games: number;
  /** Spiele laufender Lobbys – bleiben unangetastet (nach dem Schließen erneut ausführen). */
  skippedGames: number;
  /** Lobby-Snapshots (geschlossen), die gelöscht werden. */
  lobbies: number;
  questions: number;
  shown: number;
  correct: number;
  ratings: number;
  reports: number;
  guests: { participants: number; rolledBack: number; otherGames: number; missing: number };
}

interface StatsDelta {
  games: number;
  wins: number;
  draws: number;
  answers: number;
  correct: number;
  questionIds: Set<string>;
}

interface QuestionDelta {
  shown: number;
  correct: number;
  likes: number;
  dislikes: number;
  reports: number;
}

interface PurgePlan {
  summary: PurgeSummary;
  gameIds: string[];
  lobbyIds: string[];
  questions: Map<string, QuestionDelta>;
  ratingIds: string[];
  reportIds: string[];
  guestRollbacks: Map<string, StatsDelta>;
}

function emptySummary(code: string): PurgeSummary {
  return {
    code,
    games: 0,
    skippedGames: 0,
    lobbies: 0,
    questions: 0,
    shown: 0,
    correct: 0,
    ratings: 0,
    reports: 0,
    guests: { participants: 0, rolledBack: 0, otherGames: 0, missing: 0 },
  };
}

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += PURGE_CHUNK) result.push(items.slice(index, index + PURGE_CHUNK));
  return result;
}

function questionDelta(map: Map<string, QuestionDelta>, questionId: string): QuestionDelta {
  let entry = map.get(questionId);
  if (entry === undefined) {
    entry = { shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 };
    map.set(questionId, entry);
  }
  return entry;
}

/**
 * Statistik-Anteile eines Spiels – exakt wie `buildGameStats` (packages/game-engine/src/records.ts) sie beim
 * Abschluss verbucht hat: nur Menschen, je Teilnahme an einer aufgelösten Frage `shown`/`answers` + 1, `correct`
 * bei richtiger Antwort; Sieg = aktiv auf Platz 1 bei `win`, Unentschieden = aktiv bei `draw`.
 */
function addGameStats(game: GameDoc, questions: Map<string, QuestionDelta>, guests: Map<string, StatsDelta>): void {
  const humans = new Map(game.players.filter((player) => !player.isBot).map((player) => [player.playerId, player]));
  const perPlayer = new Map<string, StatsDelta>();
  for (const player of humans.values()) {
    const active = player.status === "active";
    perPlayer.set(player.playerId, {
      games: 1,
      wins: active && player.place === 1 && game.outcome === "win" ? 1 : 0,
      draws: active && game.outcome === "draw" ? 1 : 0,
      answers: 0,
      correct: 0,
      questionIds: new Set(),
    });
  }
  for (const turn of game.turns) {
    for (const question of turn.questions) {
      for (const answer of question.answers) {
        const player = perPlayer.get(answer.playerId);
        if (player === undefined) continue;
        const delta = questionDelta(questions, question.questionId);
        delta.shown += 1;
        player.answers += 1;
        player.questionIds.add(question.questionId);
        if (answer.correct) {
          delta.correct += 1;
          player.correct += 1;
        }
      }
    }
  }
  for (const [playerId, delta] of perPlayer) {
    const guestId = humans.get(playerId)?.guestId ?? "";
    // Nur echte Gäste (UUID); synthetische Bot-IDs haben kein guests-Dokument.
    if (!guestIdSchema.safeParse(guestId).success) continue;
    const total = guests.get(guestId);
    if (total === undefined) {
      guests.set(guestId, delta);
      continue;
    }
    total.games += delta.games;
    total.wins += delta.wins;
    total.draws += delta.draws;
    total.answers += delta.answers;
    total.correct += delta.correct;
    for (const id of delta.questionIds) total.questionIds.add(id);
  }
}

/** Liest alles, was eine Bereinigung braucht (mit `session` innerhalb der Transaktion). */
async function planPurge(collections: PurgeCollections, code: string, session?: ClientSession): Promise<PurgePlan> {
  const options = session === undefined ? {} : { session };
  const summary = emptySummary(code);
  const games = await collections.games.find({ code }, options).toArray();
  const plan: PurgePlan = {
    summary,
    gameIds: [],
    lobbyIds: [],
    questions: new Map(),
    ratingIds: [],
    reportIds: [],
    guestRollbacks: new Map(),
  };
  if (games.length === 0) return plan;

  const lobbyIds = [...new Set(games.map((game) => game.lobbyId))];
  const active = await collections.lobbies
    .find({ _id: { $in: lobbyIds }, active: true }, { ...options, projection: { _id: 1 } })
    .toArray();
  const running = new Set(active.map((lobby) => lobby._id));
  const purgeable = games.filter((game) => !running.has(game.lobbyId));
  summary.skippedGames = games.length - purgeable.length;
  summary.games = purgeable.length;
  if (purgeable.length === 0) return plan;
  plan.gameIds = purgeable.map((game) => game._id);
  const closedLobbyIds = [...new Set(purgeable.map((game) => game.lobbyId))];
  plan.lobbyIds = (
    await collections.lobbies
      .find({ _id: { $in: closedLobbyIds }, active: false }, { ...options, projection: { _id: 1 } })
      .toArray()
  ).map((lobby) => lobby._id);
  summary.lobbies = plan.lobbyIds.length;

  const guestDeltas = new Map<string, StatsDelta>();
  for (const game of purgeable) addGameStats(game, plan.questions, guestDeltas);
  const questionIds = [...plan.questions.keys()];
  const participants = [...guestDeltas.keys()];
  summary.guests.participants = participants.length;

  // Bewertungen/Meldungen der Beteiligten zu den in diesen Spielen gezeigten Fragen.
  const ratingIds = participants.flatMap((guestId) =>
    [...(guestDeltas.get(guestId)?.questionIds ?? [])].map((questionId) => questionRatingId(questionId, guestId)),
  );
  for (const part of chunks(ratingIds)) {
    const ratings = await collections.questionRatings.find({ _id: { $in: part } }, options).toArray();
    for (const rating of ratings) {
      const delta = questionDelta(plan.questions, rating.questionId);
      if (rating.value === 1) delta.likes += 1;
      else delta.dislikes += 1;
      plan.ratingIds.push(rating._id);
    }
  }
  for (const part of chunks(participants)) {
    const reports = await collections.questionReports
      .find(
        { guestId: { $in: part }, questionId: { $in: questionIds } },
        { ...options, projection: { guestId: 1, questionId: 1 } },
      )
      .toArray();
    for (const report of reports) {
      if (!guestDeltas.get(report.guestId)?.questionIds.has(report.questionId)) continue;
      questionDelta(plan.questions, report.questionId).reports += 1;
      plan.reportIds.push(report._id);
    }
  }

  // Gäste nur zurückrechnen, wenn sie an keinem anderen (nicht bereinigten) Spiel beteiligt sind.
  for (const guestId of participants) {
    const other = await collections.games.countDocuments(
      { "players.guestId": guestId, _id: { $nin: plan.gameIds } },
      { ...options, limit: 1 },
    );
    if (other > 0) {
      summary.guests.otherGames += 1;
      continue;
    }
    const exists = await collections.guests.countDocuments({ _id: guestId }, { ...options, limit: 1 });
    if (exists === 0) {
      summary.guests.missing += 1;
      continue;
    }
    plan.guestRollbacks.set(guestId, guestDeltas.get(guestId) as StatsDelta);
  }
  summary.guests.rolledBack = plan.guestRollbacks.size;
  summary.questions = plan.questions.size;
  for (const delta of plan.questions.values()) {
    summary.shown += delta.shown;
    summary.correct += delta.correct;
  }
  summary.ratings = plan.ratingIds.length;
  summary.reports = plan.reportIds.length;
  return plan;
}

/** `feld − delta`, nie unter 0 (ältere Zählerfehler dürfen den Validator nicht verletzen). */
function minus(field: string, delta: number): Document {
  return { $max: [0, { $subtract: [{ $ifNull: [`$${field}`, 0] }, delta] }] };
}

async function applyPurge(plan: PurgePlan, collections: PurgeCollections, session: ClientSession): Promise<void> {
  const deleted = await collections.games.deleteMany({ _id: { $in: plan.gameIds } }, { session });
  if (deleted.deletedCount !== plan.gameIds.length) {
    throw new Error("Spiele haben sich während der Bereinigung geändert – bitte erneut ausführen");
  }
  if (plan.lobbyIds.length > 0) {
    // Nur geschlossene Snapshots (laufende Lobbys werden nie angefasst).
    await collections.lobbies.deleteMany({ _id: { $in: plan.lobbyIds }, active: false }, { session });
  }
  const questionOps: AnyBulkWriteOperation<QuestionDoc>[] = [...plan.questions].map(([questionId, delta]) => ({
    updateOne: {
      filter: { _id: questionId },
      update: [
        {
          $set: {
            "stats.shown": minus("stats.shown", delta.shown),
            "stats.correct": minus("stats.correct", delta.correct),
            "stats.likes": minus("stats.likes", delta.likes),
            "stats.dislikes": minus("stats.dislikes", delta.dislikes),
            "stats.reports": minus("stats.reports", delta.reports),
          },
        },
      ],
    },
  }));
  for (const part of chunks(questionOps)) {
    await collections.questions.bulkWrite(part, { ordered: false, session });
  }
  for (const part of chunks(plan.ratingIds)) {
    await collections.questionRatings.deleteMany({ _id: { $in: part } }, { session });
  }
  for (const part of chunks(plan.reportIds)) {
    await collections.questionReports.deleteMany({ _id: { $in: part } }, { session });
  }
  for (const [guestId, delta] of plan.guestRollbacks) {
    const questionIds = [...delta.questionIds];
    await collections.guests.updateOne(
      { _id: guestId },
      [
        {
          $set: {
            "stats.games": minus("stats.games", delta.games),
            "stats.wins": minus("stats.wins", delta.wins),
            "stats.draws": minus("stats.draws", delta.draws),
            "stats.answers": minus("stats.answers", delta.answers),
            "stats.correct": minus("stats.correct", delta.correct),
            recentQuestionIds: {
              $filter: {
                input: { $ifNull: ["$recentQuestionIds", []] },
                cond: { $not: [{ $in: ["$$this", questionIds] }] },
              },
            },
          },
        },
      ],
      { session },
    );
  }
}

/**
 * Bereinigt alle beendeten Spiele mit diesem Lobby-Code (games.code) in EINER Transaktion: Fragen-Statistik
 * zurückrechnen (shown/correct wie beim Abschluss verbucht, dazu likes/dislikes/reports der entfernten
 * Bewertungen und Meldungen; nie unter 0), games-Dokumente und geschlossene Lobby-Snapshots löschen, Bewertungen
 * und Meldungen der Beteiligten zu diesen Fragen entfernen, Gäste ohne weitere Spiele zurückrechnen (Statistik,
 * `recentQuestionIds`). Spiele laufender Lobbys bleiben unangetastet. Idempotent; `dryRun` liest nur.
 */
export async function purgeGamesByCode(
  client: MongoClient,
  collections: PurgeCollections,
  rawCode: string,
  options: { dryRun: boolean },
): Promise<PurgeSummary> {
  const code = parseInput(lobbyCodeInputSchema, rawCode, "--code: ungültiger Lobby-Code");
  if (options.dryRun) return (await planPurge(collections, code)).summary;
  return client.withSession((session) =>
    session.withTransaction(
      async () => {
        const plan = await planPurge(collections, code, session);
        if (plan.gameIds.length > 0) await applyPurge(plan, collections, session);
        return plan.summary;
      },
      { timeoutMS: PURGE_TIMEOUT_MS },
    ),
  );
}

/** Ausgabe einer Bereinigung (nur Anzahlen, nie guestIds). */
export function describePurge(summary: PurgeSummary, dryRun: boolean): string[] {
  const display = formatLobbyCode(summary.code);
  if (summary.games === 0) {
    return [
      summary.skippedGames > 0
        ? `Lobby-Code ${display}: ${summary.skippedGames} Spiel(e) gehören zu einer laufenden Lobby – unangetastet, nach dem Schließen erneut ausführen`
        : `Lobby-Code ${display}: keine beendeten Spiele (nichts zu tun)`,
    ];
  }
  const { guests } = summary;
  return [
    `${dryRun ? "Dry-Run – würde bereinigen" : "Bereinigt"}: Lobby-Code ${display}`,
    `  Spiele            ${summary.games} gelöscht${summary.skippedGames > 0 ? ` (${summary.skippedGames} einer laufenden Lobby unangetastet)` : ""}`,
    `  Lobby-Snapshots   ${summary.lobbies} gelöscht (nur geschlossene)`,
    `  Fragen-Statistik  ${summary.questions} Fragen: shown −${summary.shown}, correct −${summary.correct}`,
    `  Bewertungen       ${summary.ratings} entfernt · Meldungen ${summary.reports} entfernt`,
    `  Gäste             ${guests.participants} beteiligt: ${guests.rolledBack} zurückgerechnet, ${guests.otherGames} unverändert (weitere Spiele), ${guests.missing} nicht mehr vorhanden`,
  ];
}
