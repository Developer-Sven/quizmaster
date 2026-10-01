"use client";

import type { PublicPlayer } from "@quizmaster/shared";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { PlayerRow } from "@/components/ui/player-row";
import { de } from "@/i18n/de";
import { PencilIcon } from "@/lib/ui/icons";

export interface PlayerListProps {
  players: readonly PublicPlayer[];
  maxPlayers: number;
  selfId: string | null;
  /** Host sieht `user-round-x` an allen anderen (Entfernen mit Bestätigung) */
  canKick: boolean;
  onKick: (playerId: string) => void;
  /** Eigene Zeile: `pencil` öffnet „Name ändern“ (ADR-041); ohne Handler kein Button */
  onRename?: () => void;
}

/**
 * Spielerliste der Lobby (docs/09 §6): „Spieler 3/8“, Host-Krone, offline, Entfernen für den Host.
 * Verschwindet die Zeile mit dem Fokus (nach „Entfernen“ oder wenn die Person geht), springt der Fokus auf die
 * Überschrift der Liste statt auf `body` (WCAG 2.4.3); die Ansage übernimmt `LobbyAnnouncer`.
 */
export function PlayerList({ players, maxPlayers, selfId, canKick, onKick, onRename }: PlayerListProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Person, in deren Zeile der Fokus steht (der Kick-Button) – `null`, sobald er die Zeile verlässt */
  const focusedRow = useRef<string | null>(null);
  const [target, setTarget] = useState<PublicPlayer | null>(null);

  useEffect(() => {
    const row = focusedRow.current;
    if (row === null || players.some((player) => player.id === row)) return;
    focusedRow.current = null;
    // Nur wenn der Fokus wirklich verloren ist – nie jemandem den Fokus wegnehmen, der woanders arbeitet.
    if (document.activeElement === null || document.activeElement === document.body) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [players]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h2 ref={headingRef} id={headingId} tabIndex={-1} className="text-label text-text-2 outline-none">
        {de.lobby.players(players.length, maxPlayers)}
      </h2>
      <ul data-testid="lobby-players" className="flex flex-col">
        {players.map((player) => (
          <li
            key={player.id}
            data-testid="lobby-player"
            data-player-id={player.id}
            data-host={player.isHost}
            onFocus={() => {
              focusedRow.current = player.id;
            }}
            onBlur={(event) => {
              // Nur ein Wechsel zu einem anderen Element zählt: Verschwindet die Zeile samt Fokus, gibt es kein
              // Ziel (bzw. gar kein blur) – dann soll der Effekt oben den Fokus auffangen.
              if (event.relatedTarget !== null && focusedRow.current === player.id) focusedRow.current = null;
            }}
          >
            <PlayerRow
              name={player.name}
              color={player.color}
              isHost={player.isHost}
              connected={player.connected}
              trailing={
                player.id === selfId && onRename ? (
                  <IconButton
                    icon={PencilIcon}
                    label={de.actions.rename}
                    onClick={onRename}
                    data-testid="lobby-rename"
                  />
                ) : undefined
              }
              onKick={canKick && player.id !== selfId ? () => setTarget(player) : undefined}
            />
          </li>
        ))}
      </ul>
      <Dialog
        open={target !== null}
        title={de.dialogs.kick.title(target?.name ?? "")}
        description={de.dialogs.kick.description(target?.name ?? "")}
        confirmLabel={de.dialogs.kick.confirm}
        cancelLabel={de.dialogs.kick.cancel}
        onConfirm={() => {
          if (target) onKick(target.id);
          setTarget(null);
        }}
        onCancel={() => setTarget(null)}
      />
    </section>
  );
}
