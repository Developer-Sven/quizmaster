"use client";

import {
  ADVANCE_SECONDS,
  ANSWER_SECONDS,
  formatGameEstimate,
  type LobbySettings,
  SETTINGS_BOUNDS,
  type SettingsUpdate,
  type SuggestableSetting,
  sameSettingValue,
} from "@quizmaster/shared";
import { Fragment, type ReactNode, useState } from "react";
import { de } from "../../i18n/de";
import type { CategoryCatalog } from "../../lib/client/game-view";
import { cx } from "../../lib/ui/cx";
import { Button } from "../ui/button";
import { CategoryBadge } from "../ui/category-badge";
import { ListRow } from "../ui/list-row";
import { Sheet } from "../ui/sheet";
import { Stepper } from "../ui/stepper";
import { categorySummary, settingValueText, sortedCategories, toggleCategory } from "./settings-text";

export interface SettingsSheetProps {
  open: boolean;
  /**
   * Angezeigte Werte: Server-Stand samt noch nicht bestätigter Tipps (`useSettingsSync`, ADR-042) bzw. der Entwurf
   * eines Vorschlags (ADR-053)
   */
  settings: LobbySettings;
  /** Personen in der Lobby – „Personen maximal“ darf nicht darunter fallen */
  playerCount: number;
  /** Spielbare Kategorien für die Auswahl (ADR-048) */
  categories: CategoryCatalog;
  /** Nichts ändern: alle außer dem Host, wenn Vorschläge aus sind (ADR-050) */
  readOnly?: boolean;
  /** Sicht aller außer dem Host: Host-Abschnitt in der dritten Person („Mia spielt mit“, ADR-050) */
  asGuest?: boolean;
  /** Name des Hosts für die Sicht der anderen („Nur Mia kann …“, „Mia zeigt nur an“) */
  hostName?: string;
  /** Vergleichsstand bei Vorschlägen (ADR-053): abweichende Werte orange, darunter „Aktuell: …“ */
  baseline?: LobbySettings;
  /** Titel statt „Einstellungen“, z. B. „Vorschlag von Ben“ (ADR-053) */
  title?: string;
  /** Hinweis oben (`caption`) – Standard bei `readOnly`: „Nur Mia kann die Einstellungen ändern.“ */
  intro?: ReactNode;
  /** Aktionen unten statt „Fertig“ bzw. „Schließen“ (ADR-053) */
  actions?: ReactNode;
  /** Abschnitt „Vorschläge“ zum An- und Ausschalten (nur Host, ADR-053) */
  suggestionsToggle?: boolean;
  onChange: (update: SettingsUpdate) => void;
  onClose: () => void;
}

/**
 * Einstellungen-Sheet (docs/09 §6): Runden, Fragen pro Kategorie, Personen maximal, Zusammenfassung;
 * „Zeit und Weiter“ – Zeit pro Frage (ADR-049) und Weiter nach Frage, Kategorie und Zwischenstand (ADR-045), je
 * Sekunden oder „Host“; „Kategorien“ (Unteransicht, ADR-048); „Du spielst mit“ / „Du zeigst nur an“ (ADR-046);
 * für den Host „Vorschläge“ an/aus (ADR-053). Beim Host wirken Änderungen sofort für alle (gebündelt, ADR-042);
 * alle anderen sehen es nur lesbar (ADR-050) oder stellen einen Vorschlag zusammen (`baseline`, ADR-053).
 */
export function SettingsSheet({
  open,
  settings,
  playerCount,
  categories,
  readOnly = false,
  asGuest = false,
  hostName = "",
  baseline,
  title = de.settings.title,
  intro,
  actions,
  suggestionsToggle = false,
  onChange,
  onClose,
}: SettingsSheetProps) {
  const [view, setView] = useState<"main" | "categories">("main");
  // Nur lesbar (ADR-050): Zeilen ohne Handler sind statisch, Stepper deaktiviert – die Werte bleiben lesbar.
  const change = (update: SettingsUpdate) => {
    if (!readOnly) onChange(update);
  };
  const selectable = (update: SettingsUpdate) => (readOnly ? undefined : () => change(update));
  // Vorschläge (ADR-053): „Aktuell: …“ unter jedem Wert, der vom Vergleichsstand abweicht.
  const changedNote = (key: SuggestableSetting) =>
    baseline === undefined || sameSettingValue(baseline[key], settings[key])
      ? undefined
      : de.suggestions.currently(settingValueText(baseline, key, categories));
  const categoriesNote = changedNote("categoryIds");
  const hostNote = changedNote("hostPlays");
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
  const hint = intro ?? (readOnly ? de.settings.readOnlyHint(hostName) : null);
  return (
    <Sheet
      open={open}
      onClose={close}
      title={title}
      view="main"
      footer={
        actions ?? (
          <Button variant={readOnly ? "secondary" : "primary"} block onClick={close} data-testid="settings-done">
            {readOnly ? de.actions.close : de.actions.done}
          </Button>
        )
      }
    >
      <div className="flex flex-col" data-testid="settings-sheet" data-readonly={readOnly || undefined}>
        {hint ? (
          <p className="pb-2 text-caption text-text-2" data-testid="settings-intro">
            {hint}
          </p>
        ) : null}
        <Stepper
          label={de.settings.rounds}
          value={settings.rounds}
          min={SETTINGS_BOUNDS.rounds.min}
          max={SETTINGS_BOUNDS.rounds.max}
          disabled={readOnly}
          changedNote={changedNote("rounds")}
          onChange={(rounds) => change({ rounds })}
        />
        <Stepper
          label={de.settings.questionsPerCategory}
          value={settings.questionsPerCategory}
          min={SETTINGS_BOUNDS.questionsPerCategory.min}
          max={SETTINGS_BOUNDS.questionsPerCategory.max}
          disabled={readOnly}
          changedNote={changedNote("questionsPerCategory")}
          onChange={(questionsPerCategory) => change({ questionsPerCategory })}
        />
        <Stepper
          label={de.settings.maxPlayers}
          value={settings.maxPlayers}
          min={Math.max(SETTINGS_BOUNDS.maxPlayers.min, playerCount)}
          max={SETTINGS_BOUNDS.maxPlayers.max}
          disabled={readOnly}
          changedNote={changedNote("maxPlayers")}
          onChange={(maxPlayers) => change({ maxPlayers })}
        />
        <ListRow onClick={() => setView("categories")} data-testid="settings-categories-row">
          <span className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 flex-col">
              <span>{de.settings.categories}</span>
              {categoriesNote ? <span className="text-caption text-text-2">{categoriesNote}</span> : null}
            </span>
            <span className={cx("truncate text-label", categoriesNote ? "text-primary" : "text-text-2")}>
              {categorySummary(settings.categoryIds, categories)}
            </span>
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
            changedNote={changedNote("answerSec")}
            onChange={(answerSec) => change({ answerSec })}
          />
          <Stepper
            label={de.settings.afterQuestion}
            value={settings.afterQuestionSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            disabled={readOnly}
            changedNote={changedNote("afterQuestionSec")}
            onChange={(afterQuestionSec) => change({ afterQuestionSec })}
          />
          <Stepper
            label={de.settings.afterTurn}
            value={settings.afterTurnSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            disabled={readOnly}
            changedNote={changedNote("afterTurnSec")}
            onChange={(afterTurnSec) => change({ afterTurnSec })}
          />
          <Stepper
            label={de.settings.afterRound}
            value={settings.afterRoundSec}
            options={ADVANCE_SECONDS}
            format={de.settings.advanceValue}
            disabled={readOnly}
            changedNote={changedNote("afterRoundSec")}
            onChange={(afterRoundSec) => change({ afterRoundSec })}
          />
        </div>
        <p className="pt-1 text-caption text-text-2">
          {asGuest ? de.settings.advanceHintOther : de.settings.advanceHint}
        </p>
        <h3 className="pt-4 text-label text-text-2">{asGuest ? de.settings.hostTitleOther : de.settings.hostTitle}</h3>
        {hostNote ? <p className="text-caption text-text-2">{hostNote}</p> : null}
        <ul className={cx("flex flex-col", !suggestionsToggle && "pb-2")} data-testid="settings-host-mode">
          <li>
            <ListRow selected={settings.hostPlays} onClick={selectable({ hostPlays: true })}>
              {asGuest ? de.settings.hostPlaysOther(hostName) : de.settings.hostPlays}
            </ListRow>
          </li>
          <li>
            <ListRow selected={!settings.hostPlays} onClick={selectable({ hostPlays: false })}>
              {asGuest ? de.settings.hostPresentsOther(hostName) : de.settings.hostPresents}
            </ListRow>
          </li>
        </ul>
        {suggestionsToggle ? (
          <>
            <h3 className="pt-4 text-label text-text-2">{de.suggestions.toggleTitle}</h3>
            <ul className="flex flex-col pb-2" data-testid="settings-suggestions">
              <li>
                <ListRow selected={settings.allowSuggestions} onClick={selectable({ allowSuggestions: true })}>
                  {de.suggestions.allow}
                </ListRow>
              </li>
              <li>
                <ListRow selected={!settings.allowSuggestions} onClick={selectable({ allowSuggestions: false })}>
                  {de.suggestions.deny}
                </ListRow>
              </li>
            </ul>
          </>
        ) : null}
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
