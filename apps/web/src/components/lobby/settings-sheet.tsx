"use client";

import { formatGameEstimate, type LobbySettings, SETTINGS_BOUNDS, type SettingsUpdate } from "@quizmaster/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Stepper } from "@/components/ui/stepper";
import { de } from "@/i18n/de";

export interface SettingsSheetProps {
  open: boolean;
  settings: LobbySettings;
  /** Personen in der Lobby – „Personen maximal“ darf nicht darunter fallen */
  playerCount: number;
  onChange: (update: SettingsUpdate) => void;
  onClose: () => void;
}

/**
 * Einstellungen-Sheet (docs/09 §6, nur Host): drei Stepper (Runden 1–10, Fragen pro Kategorie 1–10,
 * Personen maximal 2–8), Zusammenfassung, „Fertig“. Änderungen wirken sofort für alle; der Wert wird
 * bis zur Bestätigung durch den nächsten `lobby:state` optimistisch angezeigt.
 */
export function SettingsSheet({ open, settings, playerCount, onChange, onClose }: SettingsSheetProps) {
  // Entwurf gilt nur für den Server-Stand, auf dem er beruht: Jeder neue `lobby:state` (auch nach einer
  // Ablehnung per Resync) ist wieder maßgeblich.
  const [draft, setDraft] = useState<{ base: LobbySettings; values: Partial<LobbySettings> } | null>(null);
  const pending = draft !== null && draft.base === settings ? draft.values : {};
  const shown: LobbySettings = { ...settings, ...pending };
  const change = (update: SettingsUpdate) => {
    setDraft({ base: settings, values: { ...pending, ...update } });
    onChange(update);
  };
  const players = Math.max(playerCount, 1);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={de.settings.title}
      footer={
        <Button variant="primary" block onClick={onClose} data-testid="settings-done">
          {de.actions.done}
        </Button>
      }
    >
      <div className="flex flex-col" data-testid="settings-sheet">
        <Stepper
          label={de.settings.rounds}
          value={shown.rounds}
          min={SETTINGS_BOUNDS.rounds.min}
          max={SETTINGS_BOUNDS.rounds.max}
          onChange={(rounds) => change({ rounds })}
        />
        <Stepper
          label={de.settings.questionsPerCategory}
          value={shown.questionsPerCategory}
          min={SETTINGS_BOUNDS.questionsPerCategory.min}
          max={SETTINGS_BOUNDS.questionsPerCategory.max}
          onChange={(questionsPerCategory) => change({ questionsPerCategory })}
        />
        <Stepper
          label={de.settings.maxPlayers}
          value={shown.maxPlayers}
          min={Math.max(SETTINGS_BOUNDS.maxPlayers.min, playerCount)}
          max={SETTINGS_BOUNDS.maxPlayers.max}
          onChange={(maxPlayers) => change({ maxPlayers })}
        />
        <p className="pt-2 pb-2 text-label text-text-2" data-testid="settings-summary">
          {de.lobby.settingsSummary(shown.rounds, shown.questionsPerCategory)} ·{" "}
          {formatGameEstimate(shown.rounds, players, shown.questionsPerCategory)}
        </p>
      </div>
    </Sheet>
  );
}
