"use client";

import { useState } from "react";
import { de } from "../../i18n/de";
import { Volume2Icon, VolumeXIcon, XIcon } from "../../lib/ui/icons";
import { Dialog } from "../ui/dialog";
import { IconButton } from "../ui/icon-button";

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
 * Ton-Umschalter (`volume-2`/`volume-x`, docs/09 §10: Standard an, gespeichert) – ein Schalter (`role="switch"`)
 * namens „Ton“, dessen Zustand `aria-checked` trägt (der Name wechselt nicht mit dem Zustand). Enthält die höfliche
 * Live-Region für die Ansagen (Runde/Wahl, Kategorie + Frage, Richtig/Falsch, Rundenende, Spielende).
 * Bei großer Schrift (150–200 %) bricht der Fortschritt um und das HUD wächst, statt ihn abzuschneiden
 * (WCAG 1.4.4); 56 px bleiben die Mindesthöhe.
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
      <div className="mx-auto flex min-h-14 w-full max-w-column items-center gap-2 px-gutter py-1">
        <div className="flex w-11 shrink-0">
          {canResign ? (
            <IconButton icon={XIcon} label={de.game.resign} onClick={() => setConfirm(true)} data-testid="hud-resign" />
          ) : null}
        </div>
        <p
          data-testid="hud-progress"
          className="min-w-0 flex-1 text-center text-label text-balance text-text tabular-nums"
        >
          {progress}
        </p>
        {/* Schalter mit gleichbleibendem Namen „Ton“ (WCAG 4.1.2): an/aus sagt `aria-checked`, sichtbar das Icon.
            Kein `pressed` des IconButton – das färbte das Icon dauerhaft orange. */}
        <IconButton
          icon={soundOn ? Volume2Icon : VolumeXIcon}
          label={de.game.sound}
          role="switch"
          aria-checked={soundOn}
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
