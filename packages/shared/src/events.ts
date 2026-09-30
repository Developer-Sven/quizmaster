/**
 * Event-Verträge (docs/05 §Client → Server, §Server → Client). Client und Server importieren
 * dieselben Schemas; der Server validiert JEDE Nachricht mit `payload` (strictObject, Längengrenzen)
 * und antwortet im Ack-Format (`ack.ts`). Jede Änderung an Payload-Formen erhöht `PROTOCOL_VERSION`.
 */
import { z } from "zod";
import type { Ack } from "./ack.ts";
import { type Phase, RATING_VALUES, REPORT_REASONS } from "./constants.ts";
import {
  answerIndexSchema,
  categoryIdSchema,
  lobbyCodeInputSchema,
  lobbyCodeSchema,
  nameInputSchema,
  playerIdSchema,
  questionInstanceIdSchema,
  timestampSchema,
} from "./primitives.ts";
import {
  kickedSchema,
  noticeSchema,
  privatePlayerStateSchema,
  publicLobbyStateSchema,
  reviewListSchema,
} from "./schemas.ts";
import { updateSettingsPayloadSchema } from "./settings.ts";

/** Beschreibung eines Client→Server-Events. */
export interface ClientEventSpec<P extends z.ZodType = z.ZodType, A extends z.ZodType = z.ZodType> {
  /** zod-Schema des Payloads (immer `strictObject`). */
  readonly payload: P;
  /** zod-Schema der Ack-Daten bei Erfolg (`z.null()` = `data: null`). */
  readonly ack: A;
  /** Wann das Event erlaubt ist (Wortlaut docs/05) – verbindlich prüft der Server im Handler. */
  readonly allowed: string;
  /** Nur Mitglieder einer Lobby (false: vor dem Beitritt erlaubt, z. B. create/join/resume). */
  readonly requiresMembership: boolean;
  /** Nur der Host. */
  readonly hostOnly: boolean;
  /** Nur mit DEV_BOTS_ENABLED=true (nie in Produktion). */
  readonly devOnly: boolean;
  /** Phasen, in denen das Event gültig ist; `null` = phasenunabhängig. Sonst `INVALID_PHASE`. */
  readonly phases: readonly Phase[] | null;
}

function clientEvent<P extends z.ZodType, A extends z.ZodType>(spec: ClientEventSpec<P, A>): ClientEventSpec<P, A> {
  return spec;
}

const emptyPayload = z.strictObject({});
const noData = z.null();
const codeAck = z.strictObject({ code: lobbyCodeSchema });

/** Registry aller Client→Server-Events (Name → Payload-Schema, Ack-Daten, Regeln). */
export const CLIENT_EVENTS = {
  "time:sync": clientEvent({
    payload: z.strictObject({ t0: z.number().min(0).max(Number.MAX_SAFE_INTEGER) }),
    ack: z.strictObject({ serverNow: timestampSchema }),
    allowed: "immer",
    requiresMembership: false,
    hostOnly: false,
    devOnly: false,
    phases: null,
  }),
  "lobby:create": clientEvent({
    payload: z.strictObject({ name: nameInputSchema }),
    ack: codeAck,
    allowed: "ohne aktive Lobby-Mitgliedschaft",
    requiresMembership: false,
    hostOnly: false,
    devOnly: false,
    phases: null,
  }),
  "lobby:join": clientEvent({
    payload: z.strictObject({ code: lobbyCodeInputSchema, name: nameInputSchema }),
    ack: codeAck,
    allowed: "Phase lobby",
    requiresMembership: false,
    hostOnly: false,
    devOnly: false,
    phases: ["lobby"],
  }),
  "lobby:resume": clientEvent({
    payload: z.strictObject({ code: lobbyCodeInputSchema }),
    ack: codeAck,
    allowed: "nach Reconnect (Platz über guestId)",
    requiresMembership: false,
    hostOnly: false,
    devOnly: false,
    phases: null,
  }),
  "lobby:leave": clientEvent({
    payload: emptyPayload,
    ack: noData,
    allowed: "Mitglied; im Spiel = Aufgeben",
    requiresMembership: true,
    hostOnly: false,
    devOnly: false,
    phases: null,
  }),
  "lobby:update-settings": clientEvent({
    payload: updateSettingsPayloadSchema,
    ack: noData,
    allowed: "Host, Phase lobby",
    requiresMembership: true,
    hostOnly: true,
    devOnly: false,
    phases: ["lobby"],
  }),
  "lobby:kick": clientEvent({
    payload: z.strictObject({ playerId: playerIdSchema }),
    ack: noData,
    allowed: "Host, nicht sich selbst",
    requiresMembership: true,
    hostOnly: true,
    devOnly: false,
    phases: null,
  }),
  "lobby:start": clientEvent({
    payload: emptyPayload,
    ack: noData,
    allowed: "Host, Phase lobby, ≥ 2 verbundene Personen",
    requiresMembership: true,
    hostOnly: true,
    devOnly: false,
    phases: ["lobby"],
  }),
  "game:pick": clientEvent({
    payload: z.strictObject({ categoryId: categoryIdSchema }),
    ack: noData,
    allowed: "wählende Person, Phase category_pick, nur eine der 3 Optionen",
    requiresMembership: true,
    hostOnly: false,
    devOnly: false,
    phases: ["category_pick"],
  }),
  "game:answer": clientEvent({
    payload: z.strictObject({ questionId: questionInstanceIdSchema, choice: answerIndexSchema }),
    /** Enthält niemals richtig/falsch (docs/06 Invariante 3). */
    ack: z.strictObject({ accepted: z.literal(true) }),
    allowed: "Phase question, 1× pro Frage",
    requiresMembership: true,
    hostOnly: false,
    devOnly: false,
    phases: ["question"],
  }),
  "game:review": clientEvent({
    payload: emptyPayload,
    ack: reviewListSchema,
    allowed: "Phase game_over",
    requiresMembership: true,
    hostOnly: false,
    devOnly: false,
    phases: ["game_over"],
  }),
  "game:rematch": clientEvent({
    payload: emptyPayload,
    ack: noData,
    allowed: "Host, Phase game_over",
    requiresMembership: true,
    hostOnly: true,
    devOnly: false,
    phases: ["game_over"],
  }),
  "question:rate": clientEvent({
    payload: z.strictObject({ questionId: questionInstanceIdSchema, value: z.literal(RATING_VALUES) }),
    ack: noData,
    allowed: "Frage wurde in diesem Spiel gezeigt, 1× pro Person und Frage (überschreibbar)",
    requiresMembership: true,
    hostOnly: false,
    devOnly: false,
    phases: null,
  }),
  "question:report": clientEvent({
    payload: z.strictObject({ questionId: questionInstanceIdSchema, reason: z.enum(REPORT_REASONS) }),
    ack: noData,
    allowed: "Frage wurde in diesem Spiel gezeigt",
    requiresMembership: true,
    hostOnly: false,
    devOnly: false,
    phases: null,
  }),
  "dev:add-bot": clientEvent({
    payload: emptyPayload,
    ack: noData,
    allowed: "Host, nur wenn DEV_BOTS_ENABLED=true",
    requiresMembership: true,
    hostOnly: true,
    devOnly: true,
    phases: ["lobby"],
  }),
} as const;

type ClientEvents = typeof CLIENT_EVENTS;
export type ClientEventName = keyof ClientEvents;

/** Alle Client→Server-Eventnamen (Reihenfolge wie docs/05). */
export const CLIENT_EVENT_NAMES = Object.keys(CLIENT_EVENTS) as readonly ClientEventName[];

/** Validierter Payload (nach zod, z. B. normalisierter Lobby-Code). */
export type ClientEventPayload<E extends ClientEventName> = z.output<ClientEvents[E]["payload"]>;
/** Payload, wie der Client ihn sendet. */
export type ClientEventPayloadInput<E extends ClientEventName> = z.input<ClientEvents[E]["payload"]>;
/** Ack-Daten bei Erfolg. */
export type ClientEventAckData<E extends ClientEventName> = z.output<ClientEvents[E]["ack"]>;

const clientEventNameSet: ReadonlySet<string> = new Set(CLIENT_EVENT_NAMES);

export function isClientEventName(name: unknown): name is ClientEventName {
  return typeof name === "string" && clientEventNameSet.has(name);
}

/** Validiert den Payload eines Client-Events (Ergebnis wie `safeParse`, typisiert je Event). */
export function parseClientPayload<E extends ClientEventName>(
  event: E,
  payload: unknown,
): z.ZodSafeParseResult<ClientEventPayload<E>> {
  const schema: z.ZodType = CLIENT_EVENTS[event].payload;
  // Das Schema gehört per Registry-Konstruktion zu `E`; TypeScript kann das über den Index nicht beweisen.
  return schema.safeParse(payload) as z.ZodSafeParseResult<ClientEventPayload<E>>;
}

/** Beschreibung eines Server→Client-Events. */
export interface ServerEventSpec<P extends z.ZodType = z.ZodType> {
  readonly payload: P;
  /** Empfänger (docs/05). */
  readonly recipients: string;
}

/** Registry aller Server→Client-Events. */
export const SERVER_EVENTS = {
  "lobby:state": {
    payload: publicLobbyStateSchema,
    recipients: "Lobby-Raum (vollständiger Snapshot, Clients verwerfen kleinere rev)",
  },
  "lobby:self": { payload: privatePlayerStateSchema, recipients: "nur die betroffene Person" },
  notice: { payload: noticeSchema, recipients: "Raum / alle" },
  kicked: { payload: kickedSchema, recipients: "betroffene Person" },
} as const satisfies Record<string, ServerEventSpec>;

type ServerEvents = typeof SERVER_EVENTS;
export type ServerEventName = keyof ServerEvents;
export type ServerEventPayload<E extends ServerEventName> = z.output<ServerEvents[E]["payload"]>;
export const SERVER_EVENT_NAMES = Object.keys(SERVER_EVENTS) as readonly ServerEventName[];

/** Typisierung für `socket.io` (Server: `Server<ClientToServerEvents, ServerToClientEvents>`). */
export type ClientToServerEvents = {
  [E in ClientEventName]: (payload: ClientEventPayloadInput<E>, ack: Ack<ClientEventAckData<E>>) => void;
};

/** Typisierung für `socket.io-client` (`Socket<ServerToClientEvents, ClientToServerEvents>`). */
export type ServerToClientEvents = {
  [E in ServerEventName]: (payload: ServerEventPayload<E>) => void;
};
