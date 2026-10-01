/** Version des Realtime-Protokolls; jede Änderung an Payload-Formen erhöht sie (docs/05). */
export const PROTOCOL_VERSION = 2;

// Haupt-Export: clientfähig (keine node:-Importe). Server-only: "@quizmaster/shared/moderation",
// "@quizmaster/shared/ip", "@quizmaster/shared/env"; DB-Dokumente ("/documents") und Content-Dateien
// ("/content") über eigene Subpaths.
export * from "./ack.ts";
export * from "./auth.ts";
export * from "./constants.ts";
export * from "./duration.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./http.ts";
export * from "./invariants.ts";
export * from "./limits.ts";
export * from "./lobby-code.ts";
export * from "./names.ts";
export * from "./origin.ts";
export * from "./primitives.ts";
export * from "./schemas.ts";
export * from "./settings.ts";
export * from "./text.ts";
export * from "./timings.ts";
export * from "./transport.ts";
