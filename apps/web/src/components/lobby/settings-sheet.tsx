"use client";

import {
  ADVANCE_SECONDS,
  ANSWER_SECONDS,
  formatGameEstimate,
  type LobbySettings,
  SETTINGS_BOUNDS,
  type SettingsUpdate,
} from "@quizmaster/shared";
import { Fragment, useState } from "react";
import { de } from "../../i18n/de";
import type { CategoryCatalog } from "../../lib/client/game-view";
import { Button } from "../ui/button";
import { CategoryBadge } from "../ui/category-badge";
import { ListRow } from "../ui/list-row";
import { Sheet } from "../ui/sheet";
import { Stepper } from "../ui/stepper";

export interface SettingsSheetProps {
  open: boolean;
  /** Angezeigte Werte: Server-Stand samt noch nicht bestätigter Tipps (`useSettingsSync`, ADR-042) */
  settings: LobbySettings;
  /** Personen in der Lobby – „Personen maximal“ darf nicht darunter fallen */
  playerCount: number;
  /** Spielbare Kategorien für die Auswahl (ADR-048) */
  categories: CategoryCatalog;
  /** Alle außer dem Host: alles sehen, nichts ändern (ADR-050) */
  readOnly?: boolean;
  /** Name des Hosts für die nur lesbare Ansicht („Nur Mia kann …“, „Mia zeigt nur an“) */
  hostName?: string;
  onChange: (update: SettingsUpdate) => void;
  onClose: () => void;
}

/** Kategorien alphabetisch (deutsch) für die Auswahl. */
export function sortedCategories(catalog: CategoryCatalog) {
  return Object.values(catalog).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/**
 * Nächste Auswahl nach einem Tipp auf `id` (ADR-048): Aus „Alle“ wird „nur diese“; weitere Tipps fügen hinzu bzw.
 * nehmen weg; wird die Auswahl leer, gilt wieder „Alle“ (`null`).
 */
export function toggleCategory(current: readonly string[] | null, id: string): string[] | null {
  if (current === null) return [id];
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
  return next.length === 0 ? null : next;
}

/** Wert der Kategorie-Zeile: „Alle“, der Name bei genau einer, sonst „3 ausgewählt“. */
export function categorySummary(categoryIds: readonly string[] | null, catalog: CategoryCatalog): string {
  if (categoryIds === null) return de.settings.categoriesAllShort;
  const [only] = categoryIds;
  if (categoryIds.length === 1 && only !== undefined) return catalog[only]?.name ?? de.settings.categoriesCount(1);
  return de.settings.categoriesCount(categoryIds.length);
}

/**
 * Einstellungen-Sheet (docs/09 §6, nur Host): Runden, Fragen pro Kategorie, Personen maximal, Zusammenfassung;
 * „Zeit und Weiter“ – Zeit pro Frage (ADR-049) und Weiter nach Frage, Kategorie und Zwischenstand (ADR-045), je
 * Sekunden oder „Host“; „Kategorien“ (Unteransicht, ADR-048); „Du spielst mit“ / „Du zeigst nur an“ (ADR-046);
 * „Fertig“. Änderungen wirken sofort für alle; gesendet wird gebündelt (ADR-042).
 */
export function SettingsSheet({
  open,
  settings,
  playerCount,
  categories,
  readOnly = false,
  hostName = "",
  onChange,
  onClose,
}: SettingsSheetProps) {
  const [view, setView] = useState<"main" | "categories">("main");
  // Nur lesbar (ADR-050): Zeilen ohne Handler sind statisch, Stepper deaktiviert – die Werte bleiben lesbar.
  const change = (update: SettingsUpdate) => {
    if (!readOnly) onChange(update);
  };
  const selectable = (update: SettingsUpdate) => (readOnly ? undefined : () => change(update));
  // Mitspielende für die Schätzung: ohne den Host, wenn er nur anzeigt.
  const players = Math.max(settings.hostPlays ? playerCount : playerCount - 1, 1);
  const close = () => {
    setView("main");
    onClose();
  };
  if (view === "categories") {
    return (
      <Sheet
        open={open}
        onClose={close}
        title={de.settings.categoriesTitle}
        view="categories"
        onBack={() => setView("main")}
        footer={
          <Button
            variant={readOnly ? "secondary" : "primary"}
            block
            onClick={() => setView("main")}
            data-testid="settings-categories-done"
          >
            {readOnly ? de.actions.back : de.actions.done}
          </Button>
        }
      >
        <ul className="flex flex-col" data-testid="settings-categories">
          <li>
            <ListRow selected={settings.categoryIds === null} onClick={selectable({ categoryIds: null })}>
              {de.settings.categoriesAll}
            </ListRow>
          </li>
          {sortedCategories(categories).map((category) => (
            <li key={category.id}>
              <ListRow
                selected={settings.categoryIds?.includes(category.id) ?? false}
                onClick={selectable({ categoryIds: toggleCategory(settings.categoryIds, category.id) })}
                data-testid={`settings-category-${category.id}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <CategoryBadge category={category} compact />
                  <span className="truncate">{category.name}</span>
                </span>
              </ListRow>
            </li>
          ))}
        </ul>
        <p className="pt-2 pb-2 text-caption text-text-2">{de.settings.categoriesHint}</p>
      </Sheet>
    );
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      title={de.settings.title}
      view="main"
      footer={
        <Button variant={readOnly ? "secondary" : "primary"} block onClick={close} data-testid="settings-done">
          {readOnly ? de.actions.close : de.actions.done}
        </Button>
      }
    >
      <div className="flex flex-col" data-testid="settings-sheet" data-readonly={readOnly || undefined}>
        {readOnly ? <p className="pb-2 text-caption text-text-2">{de.settings.readOnlyHint(hostName)}</p> : null}
        <Stepper
          label={de.settings.rounds}
          value={settings.rounds}
          min={SETTINGS_BOUNDS.rounds.min}
          max={SETTINGS_BOUNDS.rounds.max}
          disabled={readOnly}
          onChange={(rounds) => change({ rounds })}
        />
        <Stepper
          label={de.settings.questionsPerCategory}
          value={settings.questionsPerCategory}
          min={SETTINGS_BOUNDS.questionsPerCategory.min}
          max={SETTINGS_BOUNDS.questionsPerCategory.max}
          disabled={readOnly}
          onChange={(questionsPerCategory) => change({ questionsPerCategory })}
        />
        <Stepper
          label={de.settings.maxPlayers}
          value={settings.maxPlayers}
          min={Math.max(SETTINGS_BOUNDS.maxPlayers.min, playerCount)}
          max={SETTINGS_BOUNDS.maxPlayers.max}
          disabled={readOnly}
          onChange={(maxPlayers) => change({ maxPlayers })}
        />
        <ListRow onClick={() => setView("categories")} data-testid="settings-categories-row">
          <span className="flex items-center justify-between gap-3">
            <span>{de.settings.categories}</span>
            <span className="truncate text-label text-text-2">{categorySummary(settings.categoryIds, categories)}</span>
          </span>
        </ListRow>
        <SettingsSummary settings={settings} players={players} />
        <h3 className="pt-4 text-label text-text-2">{de.settings.advanceTitle}</h3>
        <div className="flex flex-col" data-testid="settings-advance">
          <Stepper
            label={de.settings.answerTime}
            value={settings.answerSec}
            options={ANSWER_SECONDS}
            format={de.settings.advanceValue}
            disabled={readOnly}
            onChange={(answerSec) => change({ answerSec })}
          />
          <Stepper
            label={de.settings.afterQuestion}
            value={settings.afterQuestionSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            disabled={readOnly}
            onChange={(afterQuestionSec) => change({ afterQuestionSec })}
          />
          <Stepper
            label={de.settings.afterTurn}
            value={settings.afterTurnSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            disabled={readOnly}
            onChange={(afterTurnSec) => change({ afterTurnSec })}
          />
          <Stepper
            label={de.settings.afterRound}
            value={settings.afterRoundSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            disabled={readOnly}
            onChange={(afterRoundSec) => change({ afterRoundSec })}
          />
        </div>
        <p className="pt-1 text-caption text-text-2">
          {readOnly ? de.settings.advanceHintOther : de.settings.advanceHint}
        </p>
        <h3 className="pt-4 text-label text-text-2">{readOnly ? de.settings.hostTitleOther : de.settings.hostTitle}</h3>
        <ul className="flex flex-col pb-2" data-testid="settings-host-mode">
          <li>
            <ListRow selected={settings.hostPlays} onClick={selectable({ hostPlays: true })}>
              {readOnly ? de.settings.hostPlaysOther(hostName) : de.settings.hostPlays}
            </ListRow>
          </li>
          <li>
            <ListRow selected={!settings.hostPlays} onClick={selectable({ hostPlays: false })}>
              {readOnly ? de.settings.hostPresentsOther(hostName) : de.settings.hostPresents}
            </ListRow>
          </li>
        </ul>
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
