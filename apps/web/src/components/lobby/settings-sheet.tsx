"use client";

import {
  ADVANCE_SECONDS,
  formatGameEstimate,
  type LobbySettings,
  SETTINGS_BOUNDS,
  type SettingsUpdate,
} from "@quizmaster/shared";
import { Fragment } from "react";
import { de } from "../../i18n/de";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { Stepper } from "../ui/stepper";

export interface SettingsSheetProps {
  open: boolean;
  /** Angezeigte Werte: Server-Stand samt noch nicht bestätigter Tipps (`useSettingsSync`, ADR-042) */
  settings: LobbySettings;
  /** Personen in der Lobby – „Personen maximal“ darf nicht darunter fallen */
  playerCount: number;
  onChange: (update: SettingsUpdate) => void;
  onClose: () => void;
}

/**
 * Einstellungen-Sheet (docs/09 §6, nur Host): Runden 1–10, Fragen pro Kategorie 1–10, Personen maximal 2–8,
 * dazu „Weiter“ nach jeder Frage, Kategorie und dem Zwischenstand – Sekunden oder „Host“ (ADR-045) –,
 * Zusammenfassung, „Fertig“. Änderungen wirken sofort für alle; gesendet wird gebündelt (ADR-042).
 */
export function SettingsSheet({ open, settings, playerCount, onChange, onClose }: SettingsSheetProps) {
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
          value={settings.rounds}
          min={SETTINGS_BOUNDS.rounds.min}
          max={SETTINGS_BOUNDS.rounds.max}
          onChange={(rounds) => onChange({ rounds })}
        />
        <Stepper
          label={de.settings.questionsPerCategory}
          value={settings.questionsPerCategory}
          min={SETTINGS_BOUNDS.questionsPerCategory.min}
          max={SETTINGS_BOUNDS.questionsPerCategory.max}
          onChange={(questionsPerCategory) => onChange({ questionsPerCategory })}
        />
        <Stepper
          label={de.settings.maxPlayers}
          value={settings.maxPlayers}
          min={Math.max(SETTINGS_BOUNDS.maxPlayers.min, playerCount)}
          max={SETTINGS_BOUNDS.maxPlayers.max}
          onChange={(maxPlayers) => onChange({ maxPlayers })}
        />
        <SettingsSummary settings={settings} players={players} />
        <h3 className="pt-4 text-label text-text-2">{de.settings.advanceTitle}</h3>
        <div className="flex flex-col" data-testid="settings-advance">
          <Stepper
            label={de.settings.afterQuestion}
            value={settings.afterQuestionSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            onChange={(afterQuestionSec) => onChange({ afterQuestionSec })}
          />
          <Stepper
            label={de.settings.afterTurn}
            value={settings.afterTurnSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            onChange={(afterTurnSec) => onChange({ afterTurnSec })}
          />
          <Stepper
            label={de.settings.afterRound}
            value={settings.afterRoundSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            onChange={(afterRoundSec) => onChange({ afterRoundSec })}
          />
        </div>
        <p className="pt-1 pb-2 text-caption text-text-2">{de.settings.advanceHint}</p>
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
  settings: Pick<LobbySettings, "rounds" | "questionsPerCategory"> & Partial<LobbySettings>,
  players: number,
): string[] {
  return [
    ...de.lobby.settingsSummary(settings.rounds, settings.questionsPerCategory).split(SUMMARY_SEPARATOR),
    ...formatGameEstimate(settings.rounds, players, settings.questionsPerCategory, settings).split(SUMMARY_SEPARATOR),
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
  settings: Pick<LobbySettings, "rounds" | "questionsPerCategory"> & Partial<LobbySettings>;
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
