/**
 * Gemeinsame Hilfen der Lobby-/Spiel-Handler: Laufzeit-Zugriff, Lobby des Sockets, Mitgliedschaft,
 * Namensprüfung, Turnstile-Notfallschalter und das Muster „Command einreihen → Ack nach `reduce`, vor den
 * Effects“ (docs/02 §Datenfluss: Beitreten „Ack ok → lobby:state + lobby:self“).
 *
 * Fehler sind immer `ProtocolError` mit Code aus shared; die Event-Registry des Kerns macht daraus das
 * Fehler-Ack (unerwartete Fehler → `INTERNAL`, nie roh an den Client).
 */
import type { EnginePlayer, LobbyState } from "@quizmaster/game-engine";
import { findPlayerByGuestId } from "@quizmaster/game-engine";
import { type ClientEventAckData, type ClientEventName, ProtocolError } from "@quizmaster/shared";
import type { AppConfigDoc } from "@quizmaster/shared/documents";
import { checkName } from "@quizmaster/shared/moderation";
import type { CommandInput, LobbyActor } from "../lobby/lobby-actor.ts";
import type { LobbyRegistry } from "../lobby/lobby-registry.ts";
import type { AckSent, AppSocket, EventContext, ModuleContext } from "../registry/types.ts";
import type { AppConfigService } from "../services/app-config.ts";
import type { FeedbackService } from "../services/feedback.ts";

/**
 * Höchstalter einer Turnstile-Prüfung (`tsv` im Ticket), solange `appConfig.turnstileOnJoin` aktiv ist
 * (docs/06 §Bot-Schutz): Der Client löst Turnstile nach `TURNSTILE_REQUIRED` aus, verbindet mit frischem
 * Ticket neu und wiederholt die Aktion einmal – das passt bequem in diese Frist.
 */
export const TURNSTILE_MAX_AGE_MS = 5 * 60_000;
/** Uhrenabweichung Web ↔ Realtime, die ein `tsv` „aus der Zukunft“ noch haben darf. */
export const TURNSTILE_CLOCK_SKEW_MS = 30_000;

/** Was die Handler von der Laufzeit brauchen (siehe `GameRuntime` in lobby/module.ts). */
export interface HandlerRuntime {
  readonly lobbies: LobbyRegistry;
  readonly feedback: FeedbackService;
  readonly appConfig: AppConfigService;
}

export type RuntimeAccess = () => HandlerRuntime;
export type RegisterEvent = ModuleContext["registerEvent"];

/**
 * Einheitliche Meldung für LOBBY_NOT_FOUND – egal ob der Code unbekannt ist oder die Person dort kein Mitglied
 * ist. Sonst würde z. B. `lobby:resume` (ohne Fehlversuchs-Limit je IP) verraten, welche Codes existieren.
 */
export const LOBBY_NOT_FOUND_MESSAGE = "Lobby nicht gefunden";

export function lobbyNotFound(): ProtocolError {
  return new ProtocolError("LOBBY_NOT_FOUND", LOBBY_NOT_FOUND_MESSAGE);
}

/** Lobby aus dem Code der Anfrage (join/resume) oder LOBBY_NOT_FOUND. */
export function lobbyByCode(runtime: HandlerRuntime, code: string): LobbyActor {
  const actor = runtime.lobbies.get(code);
  if (actor === undefined) throw lobbyNotFound();
  return actor;
}

/**
 * Lobby des Sockets; hat der Socket (noch) keine – etwa direkt nach einem Reconnect vor `lobby:resume` –,
 * die einzige Lobby, in der der Gast Mitglied ist. Sonst LOBBY_NOT_FOUND.
 */
export function lobbyOfSocket(runtime: HandlerRuntime, socket: AppSocket, guestId: string): LobbyActor {
  const attached = runtime.lobbies.actorOfSocket(socket);
  if (attached !== undefined && !attached.closed) return attached;
  const memberships = runtime.lobbies.membershipsOf(guestId);
  const only = memberships.length === 1 ? memberships[0] : undefined;
  if (only !== undefined) return only;
  throw lobbyNotFound();
}

/**
 * Mitglied zur guestId (wie die Engine): entfernt → KICKED, aufgegeben → RESIGNED, sonst LOBBY_NOT_FOUND.
 * Für Handler, die den Zustand nur lesen (Rückblick, Bewertung, Meldung).
 */
export function requireMember(state: LobbyState, guestId: string): EnginePlayer {
  if (state.closed !== null) throw lobbyNotFound();
  const player = findPlayerByGuestId(state, guestId);
  if (player !== undefined && !player.left) return player;
  if (state.bannedGuestIds.includes(guestId)) throw new ProtocolError("KICKED", "Person wurde aus der Lobby entfernt");
  if (player?.status === "resigned") throw new ProtocolError("RESIGNED", "Person hat das Spiel verlassen");
  throw lobbyNotFound();
}

/**
 * Namensprüfung für lobby:create/join (docs/06 §Eingaben): Format, reservierte Namen, Blocklisten inkl.
 * `appConfig.blockedTerms` → sonst NAME_REJECTED. Liefert den normalisierten Namen (eindeutig macht ihn die
 * Engine). Die Meldung nennt nur die Art der Ablehnung, nie den Namen oder die Liste.
 */
export function moderateName(raw: string, blockedTerms: readonly string[]): string {
  const checked = checkName(raw, blockedTerms);
  if (checked.ok) return checked.name;
  const detail = checked.reason === "format" ? `format:${checked.detail}` : checked.reason;
  throw new ProtocolError("NAME_REJECTED", `Name abgelehnt (${detail})`);
}

/**
 * Notfall-Schalter `appConfig.turnstileOnJoin` (docs/06 §Bot-Schutz): lobby:create/join nur mit einem Socket,
 * dessen Ticket mit frischem, serverseitig verifiziertem Turnstile-Token ausgestellt wurde (`tsv`).
 */
export function requireTurnstile(config: Readonly<AppConfigDoc>, ticketTsv: number | null, now: number): void {
  if (!config.turnstileOnJoin) return;
  const fresh =
    ticketTsv !== null && ticketTsv <= now + TURNSTILE_CLOCK_SKEW_MS && now - ticketTsv <= TURNSTILE_MAX_AGE_MS;
  if (!fresh) throw new ProtocolError("TURNSTILE_REQUIRED", "Turnstile-Prüfung nötig");
}

/**
 * Reiht einen Command ein und sendet das Ack direkt nach erfolgreichem `reduce` – vor den Effects, damit der
 * Client zuerst die Bestätigung und danach `lobby:state`/`lobby:self` bekommt. Ablehnung → ProtocolError.
 */
export async function runCommand<E extends ClientEventName>(
  ctx: EventContext<E>,
  actor: LobbyActor,
  command: CommandInput,
  ackData: ClientEventAckData<E>,
  options: { attach?: AppSocket } = {},
): Promise<AckSent> {
  let sent: AckSent | undefined;
  const result = await actor.dispatch(command, {
    ...options,
    onAccepted: () => {
      sent = ctx.ack(ackData);
    },
  });
  if (!result.ok) {
    // Engine-Meldungen zu LOBBY_NOT_FOUND („Kein Mitglied …“) vereinheitlichen – kein Existenz-Orakel.
    if (result.error.code === "LOBBY_NOT_FOUND") throw lobbyNotFound();
    throw new ProtocolError(result.error.code, result.error.message);
  }
  if (sent === undefined) throw new Error("Ack wurde nicht gesendet");
  return sent;
}
