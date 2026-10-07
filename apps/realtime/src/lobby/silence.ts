/**
 * Netzaussetzer erkennen (ADR-057): Eine Lobby ist „still“, wenn von KEINER aktiven menschlichen Person seit
 * `silenceMs` ein Paket ankam – der Socket.IO-Ping (alle 5 s) hält jede gesunde Verbindung frisch. Dann liegt es
 * an der Leitung (Server oder alle Geräte offline), und das Spiel wird eingefroren. Ohne aktive Menschen (nur Bots)
 * ist eine Lobby nie still.
 */
export function isLobbySilent(
  activeGuestIds: readonly string[],
  lastHeard: (guestId: string) => number | null,
  now: number,
  silenceMs: number,
): boolean {
  if (activeGuestIds.length === 0) return false;
  return activeGuestIds.every((guestId) => {
    const heard = lastHeard(guestId);
    return heard === null || now - heard >= silenceMs;
  });
}
