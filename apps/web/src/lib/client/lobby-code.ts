/**
 * Lobby-Codes in Routen-Parametern (docs/01 §Lobby, docs/05 §Lobby-Codes): `/j/abc-234` und
 * `/lobby/ABC%20234` führen zum normalisierten Code. Eingaben beim Tippen normalisiert
 * `lib/ui/lobby-code`; Pfade und Einladungslinks liegen in ./paths (ohne Laufzeit-Import aus shared).
 */
import { formatLobbyCode, isValidLobbyCode, LOBBY_CODE_INPUT_MAX_LENGTH, normalizeLobbyCode } from "@quizmaster/shared";

function decodeParam(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    // Kaputte Prozent-Kodierung: der Rohwert wird unten wie jede andere ungültige Eingabe verworfen.
    return raw;
  }
}

/**
 * Code aus einem Routen-Parameter: normalisiert (Großbuchstaben, ohne Leerzeichen/Bindestriche) und nur,
 * wenn er gültig ist – sonst `null` (→ 404 „Lobby nicht gefunden“).
 */
export function lobbyCodeFromParam(raw: string): string | null {
  const decoded = decodeParam(raw);
  if (decoded.length > LOBBY_CODE_INPUT_MAX_LENGTH) return null;
  const code = normalizeLobbyCode(decoded);
  return isValidLobbyCode(code) ? code : null;
}

/** Anzeige mit Lücke: „ABC 234“. */
export function displayLobbyCode(code: string): string {
  return formatLobbyCode(code);
}
