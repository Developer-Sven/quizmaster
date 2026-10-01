/**
 * Raum-Konventionen (Socket.IO-Räume sind serverseitig, Namen gehen nie an Clients):
 * - Gast-Raum `guest:<guestId>`: jeder authentifizierte Socket tritt beim Verbinden bei (alle Tabs einer
 *   Person). Für persönliche Nachrichten (`lobby:self`, `kicked`) an alle Sockets einer Person.
 * - Lobby-Raum `lobby:<CODE>` (normalisierter Code): die Lobby-Schicht nimmt Sockets bei JOIN/RESUME auf
 *   (vor dem Command, Engine-Regel „Einen neuen Socket vor JOIN/RECONNECT in den Raum aufnehmen“) und
 *   entfernt sie bei LEAVE/KICK. Ziel von `lobby:state` und lobby-weiten `notice`s.
 * - Alle Sockets: `io.emit(...)` (z. B. `notice SERVER_RESTART`, `MAINTENANCE`).
 */

export const GUEST_ROOM_PREFIX = "guest:";
export const LOBBY_ROOM_PREFIX = "lobby:";

export function roomForGuest(guestId: string): string {
  return `${GUEST_ROOM_PREFIX}${guestId}`;
}

export function roomForLobby(code: string): string {
  return `${LOBBY_ROOM_PREFIX}${code}`;
}

/** Lobby-Code eines Raumnamens oder `null`. */
export function lobbyCodeOfRoom(room: string): string | null {
  return room.startsWith(LOBBY_ROOM_PREFIX) ? room.slice(LOBBY_ROOM_PREFIX.length) : null;
}

/** Lobby-Codes, deren Räumen ein Socket angehört (`socket.rooms`). */
export function lobbyRoomsOf(rooms: ReadonlySet<string>): string[] {
  const codes: string[] = [];
  for (const room of rooms) {
    const code = lobbyCodeOfRoom(room);
    if (code !== null) codes.push(code);
  }
  return codes;
}
