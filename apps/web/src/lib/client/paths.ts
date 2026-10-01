/**
 * Routen des Web-Clients – ohne Laufzeit-Import aus @quizmaster/shared, damit Start- und Beitreten-Seite
 * schlank bleiben (docs/07: JS initial `/` ≤ 120 KB).
 */

/** Lobby- und Spielseite. */
export function lobbyPath(code: string): string {
  return `/lobby/${encodeURIComponent(code)}`;
}

/** Beitreten-Seite (Kurzlink aus Einladung und QR-Code). */
export function joinPath(code: string): string {
  return `/j/${encodeURIComponent(code)}`;
}

/** Einladungslink `https://<origin>/j/<CODE>` (docs/10 §Teilen); abschließende Schrägstriche der Origin fallen weg. */
export function inviteLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}${joinPath(code)}`;
}
