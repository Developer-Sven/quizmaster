"use client";

import { formatGameEstimate, type LobbySettings, SETTINGS_BOUNDS, type SettingsUpdate } from "@quizmaster/shared";
import { Fragment, useState } from "react";
import { de } from "../../i18n/de";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { Stepper } from "../ui/stepper";

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
        <SettingsSummary settings={shown} players={players} />
      </div>
    </Sheet>
  );
}

/** Trenner der Zusammenfassung („3 Runden · 3 Fragen je Kat.“, „27 Fragen · ca. 9 Min.“). */
const SUMMARY_SEPARATOR = " · ";

/** Geschütztes Leerzeichen (U+00A0) vor dem Trenner: „·“ beginnt nie eine Zeile. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/** Teile der Zusammenfassung, z. B. „3 Runden“, „3 Fragen je Kat.“, „18 Fragen“, „ca. 6 Min.“. */
export function settingsSummaryParts(
  settings: Pick<LobbySettings, "rounds" | "questionsPerCategory">,
  players: number,
): string[] {
  return [
    ...de.lobby.settingsSummary(settings.rounds, settings.questionsPerCategory).split(SUMMARY_SEPARATOR),
    ...formatGameEstimate(settings.rounds, players, settings.questionsPerCategory).split(SUMMARY_SEPARATOR),
  ];
}

/**
 * Zusammenfassungszeile (docs/09 §6): bricht nur zwischen den Teilen um, nie mitten in „ca. 6 Min.“ – jeder Teil
 * hält zusammen, der Trenner „·“ bleibt am Ende der Zeile (geschütztes Leerzeichen davor). `text-balance` legt den
 * Umbruch bei 360 px zwischen Einstellungen und Schätzung; bei 430 px passt alles in eine Zeile.
 */
export function SettingsSummary({
  settings,
  players,
}: {
  settings: Pick<LobbySettings, "rounds" | "questionsPerCategory">;
  players: number;
}) {
  const parts = settingsSummaryParts(settings, players);
  return (
    <p className="pt-2 pb-2 text-label text-balance text-text-2" data-testid="settings-summary">
      {parts.map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? `${NO_BREAK_SPACE}· ` : null}
          <span className="whitespace-nowrap">{part}</span>
        </Fragment>
      ))}
    </p>
  );
}
