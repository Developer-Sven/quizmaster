"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { de } from "@/i18n/de";
import { Volume2Icon, VolumeXIcon, XIcon } from "@/lib/ui/icons";

export interface HudProps {
  /** „Runde 2/3 · Zug 3/4“ oder leer */
  progress: string;
  /** Ansage der `aria-live`-Region (docs/09 §7 „Screenreader“) */
  announcement: string | null;
  /** Aufgeben möglich (aktiv im laufenden Spiel) */
  canResign: boolean;
  soundOn: boolean;
  onToggleSound: () => void;
  /** nach Bestätigung im Dialog „Spiel verlassen?“ */
  onResign: () => void;
  resigning?: boolean;
}

/**
 * HUD (docs/09 §7 Grundgerüst): 56 px, links `x` = Aufgeben (Dialog), Mitte Fortschritt, rechts der
 * Ton-Umschalter (`volume-2`/`volume-x`, docs/09 §10: Standard an, gespeichert). Enthält die höfliche
 * Live-Region für die Ansagen (Runde/Wahl, Kategorie + Frage, Richtig/Falsch, Rundenende, Spielende).
 */
export function Hud({
  progress,
  announcement,
  canResign,
  soundOn,
  onToggleSound,
  onResign,
  resigning = false,
}: HudProps) {
  const [confirm, setConfirm] = useState(false);
  return (
    <header className="z-hud border-b border-line bg-surface-1 pt-safe">
      <div className="mx-auto flex h-14 w-full max-w-column items-center gap-2 px-gutter">
        <div className="flex w-11 shrink-0">
          {canResign ? (
            <IconButton icon={XIcon} label={de.game.resign} onClick={() => setConfirm(true)} data-testid="hud-resign" />
          ) : null}
        </div>
        <p data-testid="hud-progress" className="min-w-0 flex-1 truncate text-center text-label text-text tabular-nums">
          {progress}
        </p>
        <IconButton
          icon={soundOn ? Volume2Icon : VolumeXIcon}
          label={soundOn ? de.game.soundOn : de.game.soundOff}
          onClick={onToggleSound}
          data-testid="hud-sound"
        />
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="hud-announcer">
        {announcement ?? ""}
      </p>
      <Dialog
        open={confirm && canResign}
        title={de.dialogs.resign.title}
        description={de.dialogs.resign.description}
        confirmLabel={de.dialogs.resign.confirm}
        cancelLabel={de.dialogs.resign.cancel}
        confirming={resigning}
        onConfirm={() => {
          setConfirm(false);
          onResign();
        }}
        onCancel={() => setConfirm(false)}
      />
    </header>
  );
}
