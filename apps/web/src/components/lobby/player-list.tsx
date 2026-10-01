"use client";

import type { PublicPlayer } from "@quizmaster/shared";
import { useId, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { PlayerRow } from "@/components/ui/player-row";
import { de } from "@/i18n/de";

export interface PlayerListProps {
  players: readonly PublicPlayer[];
  maxPlayers: number;
  selfId: string | null;
  /** Host sieht `user-round-x` an allen anderen (Entfernen mit Bestätigung) */
  canKick: boolean;
  onKick: (playerId: string) => void;
}

/** Spielerliste der Lobby (docs/09 §6): „Spieler 3/8“, Host-Krone, offline, Entfernen für den Host. */
export function PlayerList({ players, maxPlayers, selfId, canKick, onKick }: PlayerListProps) {
  const headingId = useId();
  const [target, setTarget] = useState<PublicPlayer | null>(null);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h2 id={headingId} className="text-label text-text-2">
        {de.lobby.players(players.length, maxPlayers)}
      </h2>
      <ul data-testid="lobby-players" className="flex flex-col">
        {players.map((player) => (
          <li key={player.id} data-testid="lobby-player" data-player-id={player.id} data-host={player.isHost}>
            <PlayerRow
              name={player.name}
              color={player.color}
              isHost={player.isHost}
              connected={player.connected}
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
