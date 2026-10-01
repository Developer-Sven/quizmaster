import { ERROR_CODES, isErrorCode } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { de, errorPresentations } from "../../i18n/de";
import {
  actionErrorPlacement,
  connectFailure,
  createErrorPlacement,
  errorText,
  isFatalCode,
  joinErrorPlacement,
  parseConnectErrorCode,
  resumeFailure,
} from "./errors";

/** Codes, die die Oberfläche verhindert → still per lobby:resume synchronisieren (docs/09 §11). */
const RESYNC_CODES = [
  "NOT_HOST",
  "NOT_YOUR_TURN",
  "INVALID_OPTION",
  "INVALID_PHASE",
  "ALREADY_ANSWERED",
  "TOO_EARLY",
  "TOO_LATE",
] as const;

describe("errorText", () => {
  it("zeigt je Code den festen Text aus docs/09 §11 – nie die Server-Message", () => {
    expect(errorText("LOBBY_NOT_FOUND")).toBe("Lobby nicht gefunden.");
    expect(errorText("LOBBY_FULL")).toBe("Die Lobby ist voll.");
    expect(errorText("GAME_IN_PROGRESS")).toBe("Das Spiel läuft bereits.");
    expect(errorText("NAME_REJECTED")).toBe("Name nicht erlaubt.");
    expect(errorText("RATE_LIMITED")).toBe("Zu viele Versuche. Warte kurz.");
    expect(errorText("KICKED")).toBe("Du wurdest aus der Lobby entfernt.");
    expect(errorText("INTERNAL")).toBe("Da ist etwas schiefgelaufen. Versuch es noch mal.");
  });

  it("nutzt für stille Codes die jeweils passende Ersatzdarstellung", () => {
    expect(errorText("NETWORK")).toBe(de.connection.lost);
    expect(errorText("UNAUTHORIZED")).toBe("Sitzung abgelaufen. Lade die Seite neu.");
    expect(errorText("UPDATE_REQUIRED")).toBe(de.pwa.updateAvailable);
    for (const code of [...RESYNC_CODES, "TURNSTILE_REQUIRED"] as const) {
      expect(errorText(code), code).toBe(errorPresentations.INTERNAL.text);
    }
  });

  it("liefert für jeden Protokoll-Code einen nicht leeren Text", () => {
    for (const code of ERROR_CODES) expect(errorText(code).length, code).toBeGreaterThan(0);
  });
});

describe("Platzierung der Fehler", () => {
  it("Beitreten: Lobby-Fehler unter dem Code, Namensfehler unter dem Namen", () => {
    for (const code of ["LOBBY_NOT_FOUND", "LOBBY_FULL", "GAME_IN_PROGRESS", "KICKED", "BANNED", "RESIGNED"] as const) {
      expect(joinErrorPlacement(code), code).toBe("code");
    }
    expect(joinErrorPlacement("NAME_REJECTED")).toBe("name");
    expect(joinErrorPlacement("UPDATE_REQUIRED")).toBe("banner");
    expect(joinErrorPlacement("RATE_LIMITED")).toBe("toast");
    expect(joinErrorPlacement("NETWORK")).toBe("toast");
  });

  it("Erstellen: nur Namensfehler inline, sonst Toast (Update als Banner)", () => {
    expect(createErrorPlacement("NAME_REJECTED")).toBe("name");
    expect(createErrorPlacement("LOBBY_CREATION_DISABLED")).toBe("toast");
    expect(createErrorPlacement("UPDATE_REQUIRED")).toBe("banner");
    expect(createErrorPlacement("NETWORK")).toBe("toast");
  });

  it("Aktionen: verhinderte Fälle still synchronisieren, jeder Code hat genau eine Platzierung", () => {
    for (const code of RESYNC_CODES) expect(actionErrorPlacement(code), code).toBe("resync");
    expect(actionErrorPlacement("NOT_ENOUGH_PLAYERS")).toBe("toast");
    expect(actionErrorPlacement("UPDATE_REQUIRED")).toBe("banner");
    expect(actionErrorPlacement("NETWORK")).toBe("toast");
    for (const code of ERROR_CODES) {
      expect(["resync", "banner", "toast"], code).toContain(actionErrorPlacement(code));
    }
  });
});

describe("Reaktion auf Wiederaufnahme und Verbindungsaufbau", () => {
  it("resume: Lobby vorbei → Hinweis, Sitzung → neu anmelden, sonst erneut versuchen", () => {
    expect(resumeFailure("LOBBY_NOT_FOUND")).toBe("exit");
    expect(resumeFailure("KICKED")).toBe("exit");
    expect(resumeFailure("RESIGNED")).toBe("exit");
    expect(resumeFailure("UNAUTHORIZED")).toBe("reauth");
    expect(resumeFailure("UPDATE_REQUIRED")).toBe("fatal");
    expect(resumeFailure("RATE_LIMITED")).toBe("retry");
    expect(resumeFailure("NETWORK")).toBe("retry");
  });

  it("connect_error: UNAUTHORIZED still neu anmelden, Update/Sperre endgültig, Rest mit Backoff", () => {
    expect(connectFailure("UNAUTHORIZED")).toBe("reauth");
    expect(connectFailure("UPDATE_REQUIRED")).toBe("fatal");
    expect(connectFailure("BANNED")).toBe("fatal");
    expect(connectFailure("TURNSTILE_REQUIRED")).toBe("turnstile");
    expect(connectFailure("TOO_MANY_CONNECTIONS")).toBe("retry");
    expect(connectFailure("SERVER_BUSY")).toBe("retry");
    expect(isFatalCode("UPDATE_REQUIRED")).toBe(true);
    expect(isFatalCode("RATE_LIMITED")).toBe(false);
  });

  it("liest den Code aus data.code oder message, Transportfehler ergeben null", () => {
    expect(parseConnectErrorCode({ message: "x", data: { code: "UPDATE_REQUIRED" } }, isErrorCode)).toBe(
      "UPDATE_REQUIRED",
    );
    expect(parseConnectErrorCode(new Error("UNAUTHORIZED"), isErrorCode)).toBe("UNAUTHORIZED");
    expect(parseConnectErrorCode(new Error("xhr poll error"), isErrorCode)).toBeNull();
    expect(parseConnectErrorCode(new Error("NOT_A_CODE"), isErrorCode)).toBeNull();
    expect(parseConnectErrorCode({ data: { code: 42 } }, isErrorCode)).toBeNull();
    expect(parseConnectErrorCode(null, isErrorCode)).toBeNull();
  });
});
