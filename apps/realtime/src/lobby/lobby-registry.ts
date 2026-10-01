/**
 * Lobby-Registry: Code → LobbyActor und Socket → Lobby (docs/02 §Datenfluss: Beitreten, docs/06
 * §Kontingente, docs/05 §Lobby-Codes).
 *
 * Erstellen (`create`):
 * 1. Kontingente: nur OHNE aktive Lobby-Mitgliedschaft (docs/05 `lobby:create` „Erlaubt“; schließt „höchstens
 *    EINE aktive gehostete Lobby je Gast“ ein, auch parallele Erstellungen zählen) → `RATE_LIMITED` (Festlegung
 *    `QUOTAS.maxActiveHostedLobbiesPerGuest` in shared). Mitglied heißt: nicht verlassen/entfernt in einer offenen
 *    Lobby – auch getrennt innerhalb der Reconnect-Frist. So bleibt die Zuordnung „einzige Lobby des Gasts“
 *    (`lobbyOfSocket`) eindeutig. Zulassung (`admission.lobbyCreation`: Shutdown, `lobbyCreationEnabled` →
 *    LOBBY_CREATION_DISABLED, Lastabwurf, `maxActiveLobbies` → SERVER_BUSY).
 * 2. Code: `generateLobbyCode(crypto.randomInt, isTaken, { isAcceptable: isCodeAcceptable })` – belegt, wenn ein
 *    Actor im Speicher ODER eine aktive Lobby in der Datenbank ihn hat; nach 5 Versuchen → SERVER_BUSY.
 * 3. `createLobby` (Engine) → `lobbies.insert` (partieller Unique-Index auf aktive Codes; Kollision → neuer
 *    Code) → Actor registrieren → Socket in den Raum, Ack, Effects.
 *
 * Sockets: Ein Socket gehört zu höchstens EINER Lobby. Tritt er erfolgreich einer anderen bei, verlässt er die
 * alte (dort DISCONNECT, falls es der letzte Socket der Person war). Beim Trennen meldet der Kern
 * `socketDisconnected` → der Actor sendet DISCONNECT, sobald die Person dort keinen Socket mehr hat.
 *
 * Die Metrik `qm_lobbies_active` folgt jeder Änderung. `shutdown` friert alle Actors ein, schreibt ihre
 * Snapshots, wartet befristet auf laufende Spielabschlüsse (Abschluss-Warteschlange, `game-finish.ts`) und
 * meldet ehrlich, was nicht gesichert ist (Fehlerlog + Bericht statt pauschal „gesichert“); `adopt` nimmt einen
 * wiederhergestellten Zustand auf (Wiederaufnahme nach Neustart, W4).
 */
import { randomInt } from "node:crypto";
import type { Repositories } from "@quizmaster/db";
import { createLobby, type LobbyState, type Rng, toLobbySnapshot } from "@quizmaster/game-engine";
import { type GameTimingMode, generateLobbyCode, ProtocolError } from "@quizmaster/shared";
import { isCodeAcceptable } from "@quizmaster/shared/moderation";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import type { AdmissionService, AppServer, AppSocket, Clock } from "../registry/types.ts";
import { withTimeout } from "../registry/util.ts";
import type { QuestionService } from "../services/questions.ts";
import { createFinishQueue } from "./game-finish.ts";
import {
  createLobbyActor,
  type LobbyActor,
  type LobbyActorHooks,
  memberGuestIds,
  type SnapshotResult,
} from "./lobby-actor.ts";

/** Frist für Datenbank-Aufrufe beim Erstellen (Code-Prüfung, Einfügen). */
export const LOBBY_DB_TIMEOUT_MS = 5_000;
/** Neue Codes nach einer Kollision beim Einfügen (jeweils mit bis zu 5 Ziehungen). */
export const LOBBY_INSERT_ATTEMPTS = 3;
/** Höchstens so lange wartet der Shutdown auf laufende Spielabschlüsse. */
export const SHUTDOWN_FINISH_WAIT_MS = 3_000;

export interface CreateLobbyRequest {
  /** Socket der erstellenden Person (kommt in den Lobby-Raum). */
  socket: AppSocket;
  guestId: string;
  /** Bereits moderierter Name (`checkName`). */
  name: string;
  /** Nach dem Anlegen, vor dem ersten Zustand – hier sendet der Handler sein Ack. */
  onCreated(code: string): void;
}

/** Bilanz von `LobbyRegistry.shutdown()`. */
export interface LobbyShutdownReport {
  lobbies: number;
  /** Lobby-Codes, deren Abschluss-Snapshot nicht geschrieben wurde (Fehler, Code vergeben). */
  snapshotsFailed: string[];
  /** Spiel-IDs, deren Abschluss beim Shutdown nicht gespeichert ist (verloren oder noch unterwegs). */
  unfinishedGames: string[];
}

/** Gesichert = geschrieben oder in der Datenbank steht bereits ein neuerer/geschlossener Stand. */
function snapshotSecured(result: SnapshotResult): boolean {
  return result === "saved" || result === "stale";
}

export interface LobbyRegistry {
  /** Anzahl aktiver Lobbys im Speicher. */
  readonly size: number;
  get(code: string): LobbyActor | undefined;
  list(): LobbyActor[];
  /** Lobby, zu der der Socket gehört. */
  actorOfSocket(socket: AppSocket): LobbyActor | undefined;
  /** Lobbys, in denen der Gast Mitglied ist. */
  membershipsOf(guestId: string): LobbyActor[];
  /** Hat der Gast eine aktive, selbst erstellte Lobby, in der er noch Mitglied ist? */
  hostsActiveLobby(guestId: string): boolean;
  create(request: CreateLobbyRequest): Promise<LobbyActor>;
  /**
   * Nimmt einen (z. B. aus einem Snapshot wiederhergestellten) Zustand auf: Actor anlegen, registrieren,
   * Timer/Bots/gesehene Fragen per `actor.resume()` wieder aufnehmen. Wirft, wenn der Code belegt ist.
   */
  adopt(state: LobbyState): Promise<LobbyActor>;
  /** Vom Kern beim Trennen eines Sockets (DISCONNECT, falls es sein letzter in der Lobby war). */
  socketDisconnected(socket: AppSocket): void;
  /** Alle Lobbys einfrieren, Snapshots schreiben, laufende Spielabschlüsse (befristet) abwarten; mit Bilanz. */
  shutdown(): Promise<LobbyShutdownReport>;
}

export interface LobbyRegistryDeps {
  io: AppServer;
  clock: Clock;
  rng: Rng;
  logger: Logger;
  metrics: RealtimeMetrics;
  timing: GameTimingMode;
  admission: AdmissionService;
  repos: Pick<Repositories, "lobbies" | "guests" | "finishGame">;
  questions: Pick<QuestionService, "offerCategories" | "loadQuestions">;
  /** Zufall für Lobby-Codes (Standard `crypto.randomInt`). */
  randomInt?: (maxExclusive: number) => number;
  dbTimeoutMs?: number;
  snapshotDebounceMs?: number;
  /** Abstand der Hintergrund-Wiederholungen fehlgeschlagener Spielabschlüsse (Standard 30 s). */
  finishRetryIntervalMs?: number;
}

export function createLobbyRegistry(deps: LobbyRegistryDeps): LobbyRegistry {
  const actors = new Map<string, LobbyActor>();
  const socketActors = new WeakMap<AppSocket, LobbyActor>();
  /** guestId → Lobbys, in denen der Gast (Mensch) Mitglied ist – Nachschlagen ohne Scan über alle Lobbys. */
  const memberIndex = new Map<string, Set<LobbyActor>>();
  /** Gäste mit laufender Erstellung (Kontingent auch bei parallelen Anfragen). */
  const creating = new Set<string>();
  const dbTimeoutMs = deps.dbTimeoutMs ?? LOBBY_DB_TIMEOUT_MS;
  const drawInt = deps.randomInt ?? ((maxExclusive: number) => randomInt(maxExclusive));
  const log = deps.logger.child({ component: "lobbies" });
  const finishes = createFinishQueue({
    repos: deps.repos,
    logger: deps.logger.child({ component: "game-finish" }),
    metrics: deps.metrics,
    now: () => deps.clock.now(),
    ...(deps.finishRetryIntervalMs === undefined ? {} : { retryIntervalMs: deps.finishRetryIntervalMs }),
  });
  let shuttingDown = false;

  const updateMetric = () => deps.metrics.setActiveLobbies(actors.size);

  const indexMember = (guestId: string, actor: LobbyActor) => {
    let set = memberIndex.get(guestId);
    if (set === undefined) {
      set = new Set();
      memberIndex.set(guestId, set);
    }
    set.add(actor);
  };

  const unindexMember = (guestId: string, actor: LobbyActor) => {
    const set = memberIndex.get(guestId);
    if (set === undefined) return;
    set.delete(actor);
    if (set.size === 0) memberIndex.delete(guestId);
  };

  /** Registriert einen neuen Actor (Code, Mitglieder, Metrik). */
  const register = (actor: LobbyActor) => {
    actors.set(actor.code, actor);
    for (const guestId of memberGuestIds(actor.state)) indexMember(guestId, actor);
    updateMetric();
  };

  /** Lobbys eines Gasts laut Index (zusätzlich gegen den aktuellen Zustand geprüft). */
  const indexedMemberships = (guestId: string): LobbyActor[] =>
    [...(memberIndex.get(guestId) ?? [])].filter((actor) => actor.isMember(guestId));

  const hooks: LobbyActorHooks = {
    onSocketAttached(actor, socket) {
      const previous = socketActors.get(socket);
      socketActors.set(socket, actor);
      if (previous !== undefined && previous !== actor) previous.detachSocket(socket, "moved");
      // Während des Beitritts getrennt: sofort wieder lösen (DISCONNECT folgt, falls nötig).
      if (!socket.connected) {
        socketActors.delete(socket);
        actor.detachSocket(socket, "disconnect");
      }
    },
    onSocketDetached(actor, socket) {
      if (socketActors.get(socket) === actor) socketActors.delete(socket);
    },
    onMembershipChanged(actor, joined, left) {
      for (const guestId of joined) indexMember(guestId, actor);
      for (const guestId of left) unindexMember(guestId, actor);
    },
    onClosed(actor) {
      if (actors.get(actor.code) === actor) actors.delete(actor.code);
      // Die Mitglieder hat `onMembershipChanged` beim Schließen schon ausgetragen; hier nur zur Sicherheit (≤ 8).
      for (const player of actor.state.players) unindexMember(player.guestId, actor);
      updateMetric();
    },
  };

  const newActor = (state: LobbyState) =>
    createLobbyActor(
      {
        io: deps.io,
        clock: deps.clock,
        rng: deps.rng,
        logger: deps.logger,
        metrics: deps.metrics,
        questions: deps.questions,
        repos: deps.repos,
        finishes,
        hooks,
        ...(deps.snapshotDebounceMs === undefined ? {} : { snapshotDebounceMs: deps.snapshotDebounceMs }),
      },
      state,
    );

  const hostsActiveLobby = (guestId: string) =>
    indexedMemberships(guestId).some((actor) => !actor.closed && actor.state.createdByGuestId === guestId);

  const isCodeTaken = async (code: string): Promise<boolean> => {
    if (actors.has(code)) return true;
    return withTimeout(deps.repos.lobbies.isCodeTaken(code), dbTimeoutMs, "Lobby-Code prüfen");
  };

  const dbUnavailable = (error: unknown, operation: string): ProtocolError => {
    deps.metrics.recordMongoError(operation);
    log.warn({ err: error, operation }, "Lobby nicht erstellt – Datenbank nicht erreichbar");
    // Details nur ins Log – die Meldung geht im Ack an den Client.
    return new ProtocolError("SERVER_BUSY", "Lobby gerade nicht erstellbar");
  };

  return {
    get size() {
      return actors.size;
    },
    get: (code) => actors.get(code),
    list: () => [...actors.values()],
    actorOfSocket: (socket) => socketActors.get(socket),
    membershipsOf: indexedMemberships,
    hostsActiveLobby,

    async create(request) {
      const { guestId } = request;
      if (shuttingDown) throw new ProtocolError("SERVER_BUSY", "Server startet neu");
      if (creating.has(guestId) || hostsActiveLobby(guestId)) {
        throw new ProtocolError("RATE_LIMITED", "Höchstens eine aktive gehostete Lobby je Gast");
      }
      if (indexedMemberships(guestId).length > 0) {
        throw new ProtocolError("RATE_LIMITED", "Bereits Mitglied einer aktiven Lobby");
      }
      const admission = deps.admission.lobbyCreation(actors.size + creating.size);
      if (admission !== null) throw new ProtocolError(admission, "Keine neuen Lobbys möglich");
      creating.add(guestId);
      try {
        for (let attempt = 0; attempt < LOBBY_INSERT_ATTEMPTS; attempt++) {
          let code: string | null;
          try {
            code = await generateLobbyCode(drawInt, isCodeTaken, { isAcceptable: isCodeAcceptable });
          } catch (error) {
            throw dbUnavailable(error, "lobby_code");
          }
          if (code === null) throw new ProtocolError("SERVER_BUSY", "Kein freier Lobby-Code gefunden");
          const created = createLobby(
            { code, guestId, name: request.name, timing: deps.timing },
            { now: deps.clock.now(), rng: deps.rng },
          );
          if (!created.ok) throw new ProtocolError(created.error.code, created.error.message);
          let inserted: Awaited<ReturnType<Repositories["lobbies"]["insert"]>>;
          try {
            inserted = await withTimeout(
              deps.repos.lobbies.insert(toLobbySnapshot(created.state)),
              dbTimeoutMs,
              "Lobby anlegen",
            );
          } catch (error) {
            throw dbUnavailable(error, "lobby_insert");
          }
          if (!inserted.ok) {
            log.info({ attempt }, "Lobby-Code kollidiert – neuer Code");
            continue;
          }
          if (actors.has(code)) {
            // Nur möglich, wenn die Datenbank den Code einer noch laufenden Lobby schon freigegeben hat (TTL):
            // das eben eingefügte Dokument wieder schließen und neu ziehen.
            log.warn({ attempt }, "Lobby-Code im Speicher noch belegt – neuer Code");
            deps.repos.lobbies.close(created.state.lobbyId, new Date(deps.clock.now())).catch((error: unknown) => {
              deps.metrics.recordMongoError("lobby_close");
              log.warn({ err: error }, "Verworfene Lobby nicht geschlossen");
            });
            continue;
          }
          // Ab hier gibt es das Dokument: die Lobby immer übernehmen (auch in einem gerade beginnenden Shutdown –
          // dann wird sie mit gesichert und ist nach dem Neustart wieder aufnehmbar).
          const actor = newActor(created.state);
          register(actor);
          log.info({ lobby: code }, "Lobby erstellt");
          await actor.start(created.effects, {
            attach: request.socket,
            onAccepted: () => request.onCreated(code),
          });
          return actor;
        }
        throw new ProtocolError("SERVER_BUSY", "Kein freier Lobby-Code gefunden");
      } finally {
        creating.delete(guestId);
      }
    },

    async adopt(state) {
      if (actors.has(state.code)) throw new Error(`Lobby-Code ${state.code} ist bereits aktiv`);
      if (state.closed !== null) throw new Error("Geschlossene Lobby kann nicht aufgenommen werden");
      const actor = newActor(state);
      register(actor);
      await actor.resume();
      return actor;
    },

    socketDisconnected(socket) {
      const actor = socketActors.get(socket);
      if (actor === undefined) return;
      socketActors.delete(socket);
      actor.detachSocket(socket, "disconnect");
    },

    async shutdown() {
      shuttingDown = true;
      const all = [...actors.values()];
      const snapshots = await Promise.all(all.map((actor) => actor.shutdown()));
      const snapshotsFailed = all.filter((_actor, index) => !snapshotSecured(snapshots[index] ?? null));
      // Laufende Abschlüsse (auch geschlossener Lobbys) befristet abwarten; vorgemerkte gelten als verloren.
      const unfinishedGames = await finishes.shutdown(SHUTDOWN_FINISH_WAIT_MS);
      const report: LobbyShutdownReport = {
        lobbies: all.length,
        snapshotsFailed: snapshotsFailed.map((actor) => actor.code),
        unfinishedGames,
      };
      if (report.snapshotsFailed.length > 0 || unfinishedGames.length > 0) {
        log.error(
          {
            lobbies: report.lobbies,
            snapshotsFailed: report.snapshotsFailed.length,
            failedLobbies: report.snapshotsFailed,
            unfinishedGames,
          },
          "Lobbys nur teilweise gesichert – Snapshots bzw. Spielabschlüsse fehlen",
        );
      } else {
        log.info({ lobbies: report.lobbies }, "Lobbys gesichert");
      }
      return report;
    },
  };
}
