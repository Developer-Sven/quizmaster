"use client";

import type { ReactNode } from "react";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { CrownIcon, UserRoundXIcon } from "../../lib/ui/icons";
import type { PlayerColor } from "../../lib/ui/player";
import { Avatar } from "./avatar";
import { IconButton } from "./icon-button";

export interface PlayerRowProps {
  name: string;
  color: PlayerColor;
  isHost?: boolean;
  /** false = getrennt: Avatar 40 % mit `wifi-off`, Hinweis „offline“ */
  connected?: boolean;
  /** Name durchgestrichen, Avatar 40 % */
  resigned?: boolean;
  /** kurzer Hinweis neben dem Namen (`caption`, text-2), z. B. „zeigt an“ (ADR-046) */
  note?: string;
  /** weitere Statusanzeige oder Aktion rechts */
  trailing?: ReactNode;
  /** Nur für den Host: Person entfernen (`user-round-x`); ohne Handler kein Button */
  onKick?: () => void;
}

/**
 * PlayerRow (docs/09 §5): Avatar 40 · Name · rechts Status/Aktion. Der Host sieht `user-round-x`
 * zum Entfernen. Mehrere Zeilen in eine Liste (`ul`/`li`) setzen.
 *
 * Der Name ist der Inhalt der Zeile und wird nie abgeschnitten (docs/09 §12, WCAG 1.4.4): Er bricht um, und reicht die
 * Breite bei großer Schrift nicht für Avatar, Name (mindestens 10 rem) und die Tasten rechts, rücken „Host“ und die
 * Tasten als Gruppe rechtsbündig in die nächste Zeile.
 */
export function PlayerRow({
  name,
  color,
  isHost = false,
  connected = true,
  resigned = false,
  note,
  trailing,
  onKick,
}: PlayerRowProps) {
  const actions = isHost || trailing !== undefined || onKick !== undefined;
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 py-1">
      <div className="flex min-w-0 grow basis-40 items-center gap-3">
        <Avatar name={name} color={color} size={40} offline={!connected} resigned={resigned} />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span
            className={cx("min-w-0 text-body wrap-break-word", resigned ? "text-text-2 line-through" : "text-text")}
          >
            {name}
          </span>
          {connected ? null : <span className="shrink-0 text-caption text-text-2">{de.lobby.offline}</span>}
          {resigned ? <span className="shrink-0 text-caption text-text-2">{de.result.resigned}</span> : null}
          {note ? <span className="shrink-0 text-caption text-text-2">{note}</span> : null}
        </div>
      </div>
      {actions ? (
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {isHost ? (
            <span className="flex shrink-0 items-center gap-1 text-label text-text-2">
              <CrownIcon size={16} className="text-primary" />
              {de.lobby.host}
            </span>
          ) : null}
          {trailing}
          {onKick ? <IconButton icon={UserRoundXIcon} label={de.lobby.kick(name)} onClick={onKick} /> : null}
        </div>
      ) : null}
    </div>
  );
}
