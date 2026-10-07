"use client";

import {
  ADVANCE_SECONDS,
  ANSWER_SECONDS,
  formatGameEstimate,
  type LobbySettings,
  SETTINGS_BOUNDS,
  type SettingsUpdate,
  type SuggestableSetting,
} from "@quizmaster/shared";
import { Fragment, type ReactNode, useState } from "react";
import { de } from "../../i18n/de";
import type { CategoryCatalog } from "../../lib/client/game-view";
import type { CategoryVisual } from "../../lib/ui/category";
import { cx } from "../../lib/ui/cx";
import { Button } from "../ui/button";
import { CategoryBadge } from "../ui/category-badge";
import { ListRow } from "../ui/list-row";
import { Sheet } from "../ui/sheet";
import { Stepper } from "../ui/stepper";
import {
  asDifficulty,
  categoriesNote as categoriesNoteOf,
  categoryModeHint,
  categoryOrderNote,
  categoryOrderText,
  categorySummary,
  categoryUpdate,
  difficultyPreview,
  difficultySummary,
  MAX_SEQUENCE_CATEGORIES,
  settingDiffers,
  settingValueText,
  sortedCategories,
  toggleCategory,
} from "./settings-text";

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
 * Sekunden oder „Host“; „Kategorien“ (Unteransicht, ADR-048); „Schwierigkeit“ (Unteransicht: von–bis, pro Frage
 * oder Kategorie, aufsteigend oder zufällig, mit Vorschau – ADR-055); „Du spielst mit“ / „Du zeigst nur an“ (ADR-046);
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
  const [view, setView] = useState<"main" | "categories" | "difficulty">("main");
  // Nur lesbar (ADR-050): Zeilen ohne Handler sind statisch, Stepper deaktiviert – die Werte bleiben lesbar.
  const change = (update: SettingsUpdate) => {
    if (!readOnly) onChange(update);
  };
  const selectable = (update: SettingsUpdate) => (readOnly ? undefined : () => change(update));
  // Vorschläge (ADR-053): „Aktuell: …“ unter jedem Wert, der vom Vergleichsstand abweicht – der Reihe nach zählt
  // die Reihenfolge der Kategorien (ADR-056), wie beim Server.
  const changedNote = (key: SuggestableSetting) =>
    baseline === undefined || !settingDiffers(baseline, settings, key)
      ? undefined
      : de.suggestions.currently(settingValueText(baseline, key, categories));
  // Kategorien (ADR-048/056): „Aktuell: …“, sobald Auswahl, Reihenfolge oder Spielweise abweicht.
  const categoriesNote = categoriesNoteOf(baseline, settings, categories);
  const orderNote = categoryOrderNote(baseline, settings, categories);
  const sequence = settings.categoryMode === "sequence";
  const hostNote = changedNote("hostPlays");
  // Schwierigkeit (ADR-055): die Zeile der Hauptansicht zeigt „Aktuell: …“, sobald eins der vier Felder abweicht.
  const difficultyChanged =
    baseline !== undefined &&
    (["difficultyMin", "difficultyMax", "difficultyBasis", "difficultyOrder"] as const).some(
      (key) => changedNote(key) !== undefined,
    );
  const difficultyNote =
    difficultyChanged && baseline !== undefined ? de.suggestions.currently(difficultySummary(baseline)) : undefined;
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
            <ListRow selected={settings.categoryIds === null} onClick={selectable(categoryUpdate(settings, null))}>
              {de.settings.categoriesAll}
            </ListRow>
          </li>
          {sortedCategories(categories).map((category) => {
            const selected = settings.categoryIds?.includes(category.id) ?? false;
            // Der Reihe nach höchstens 10 – eine je Runde (ADR-056).
            const full = sequence && !selected && (settings.categoryIds?.length ?? 0) >= MAX_SEQUENCE_CATEGORIES;
            return (
              <li key={category.id}>
                <ListRow
                  selected={selected}
                  disabled={full}
                  onClick={selectable(categoryUpdate(settings, toggleCategory(settings.categoryIds, category.id)))}
                  data-testid={`settings-category-${category.id}`}
                >
                  <CategoryChoice category={category} />
                </ListRow>
              </li>
            );
          })}
        </ul>
        <p className="pt-2 pb-2 text-caption text-text-2">{de.settings.categoriesHint}</p>
        {(settings.categoryIds?.length ?? 0) >= 2 ? (
          <>
            <h3 className="pt-2 text-label text-text-2">{de.settings.categoryModeTitle}</h3>
            {changedNote("categoryMode") ? (
              <p className="text-caption text-text-2">{changedNote("categoryMode")}</p>
            ) : null}
            <ul className="flex flex-col" data-testid="settings-category-mode">
              {(["pick", "sequence"] as const).map((mode) => (
                <li key={mode}>
                  <ListRow
                    selected={settings.categoryMode === mode}
                    disabled={mode === "sequence" && (settings.categoryIds?.length ?? 0) > MAX_SEQUENCE_CATEGORIES}
                    onClick={selectable(
                      mode === "sequence"
                        ? { categoryMode: "sequence", rounds: settings.categoryIds?.length ?? settings.rounds }
                        : { categoryMode: "pick" },
                    )}
                  >
                    <span className="flex min-w-0 flex-col py-2">
                      <span>{de.settings.categoryModes[mode]}</span>
                      <span className="text-caption text-text-2">{categoryModeHint(mode, asGuest)}</span>
                    </span>
                  </ListRow>
                </li>
              ))}
            </ul>
            {sequence && settings.categoryIds ? (
              <p
                className={cx("pt-2 text-body", orderNote ? "text-primary" : "pb-2 text-text")}
                data-testid="settings-category-order"
              >
                {de.settings.categorySequence(categoryOrderText(settings.categoryIds, categories))}
              </p>
            ) : null}
            {orderNote ? (
              <p className="pb-2 text-caption text-text-2" data-testid="settings-category-order-note">
                {orderNote}
              </p>
            ) : null}
            {(settings.categoryIds?.length ?? 0) >= MAX_SEQUENCE_CATEGORIES ? (
              <p className="pb-2 text-caption text-text-2">
                {de.settings.categorySequenceMax(MAX_SEQUENCE_CATEGORIES)}
              </p>
            ) : null}
          </>
        ) : null}
      </Sheet>
    );
  }
  if (view === "difficulty") {
    const range = settings.difficultyMin < settings.difficultyMax;
    const basisNote = changedNote("difficultyBasis");
    const orderNote = changedNote("difficultyOrder");
    return (
      <Sheet
        open={open}
        onClose={close}
        title={de.settings.difficultyTitle}
        view="difficulty"
        onBack={() => setView("main")}
        footer={
          <Button
            variant={readOnly ? "secondary" : "primary"}
            block
            onClick={() => setView("main")}
            data-testid="settings-difficulty-done"
          >
            {readOnly ? de.actions.back : de.actions.done}
          </Button>
        }
      >
        <div className="flex flex-col" data-testid="settings-difficulty">
          <Stepper
            label={de.settings.difficultyMin}
            value={settings.difficultyMin}
            min={1}
            max={settings.difficultyMax}
            disabled={readOnly}
            changedNote={changedNote("difficultyMin")}
            onChange={(level) => change({ difficultyMin: asDifficulty(level) })}
          />
          <Stepper
            label={de.settings.difficultyMax}
            value={settings.difficultyMax}
            min={settings.difficultyMin}
            max={5}
            disabled={readOnly}
            changedNote={changedNote("difficultyMax")}
            onChange={(level) => change({ difficultyMax: asDifficulty(level) })}
          />
          <p className="pt-1 text-caption text-text-2">{de.settings.difficultyScale}</p>
          {range ? (
            <>
              <h3 className="pt-4 text-label text-text-2">{de.settings.difficultyBasisTitle}</h3>
              {basisNote ? <p className="text-caption text-text-2">{basisNote}</p> : null}
              <ul className="flex flex-col" data-testid="settings-difficulty-basis">
                {(["question", "category"] as const).map((basis) => (
                  <li key={basis}>
                    <ListRow
                      selected={settings.difficultyBasis === basis}
                      onClick={selectable({ difficultyBasis: basis })}
                    >
                      <span className="flex min-w-0 flex-col py-2">
                        <span>{de.settings.difficultyBases[basis]}</span>
                        <span className="text-caption text-text-2">{de.settings.difficultyBasisHints[basis]}</span>
                      </span>
                    </ListRow>
                  </li>
                ))}
              </ul>
              <h3 className="pt-4 text-label text-text-2">{de.settings.difficultyOrderTitle}</h3>
              {orderNote ? <p className="text-caption text-text-2">{orderNote}</p> : null}
              <ul className="flex flex-col" data-testid="settings-difficulty-order">
                {(["ascending", "random"] as const).map((order) => (
                  <li key={order}>
                    <ListRow
                      selected={settings.difficultyOrder === order}
                      onClick={selectable({ difficultyOrder: order })}
                    >
                      <span className="flex min-w-0 flex-col py-2">
                        <span>{de.settings.difficultyOrders[order]}</span>
                        <span className="text-caption text-text-2">
                          {de.settings.difficultyOrderHints[settings.difficultyBasis][order]}
                        </span>
                      </span>
                    </ListRow>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="pt-4 pb-2 text-body text-text" data-testid="settings-difficulty-preview">
            {difficultyPreview(settings, players)}
          </p>
        </div>
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
          disabled={readOnly || sequence}
          changedNote={changedNote("rounds")}
          onChange={(rounds) => change({ rounds })}
        />
        {sequence ? (
          <p className="pb-1 text-caption text-text-2" data-testid="settings-rounds-sequence">
            {de.settings.roundsFromCategories}
          </p>
        ) : null}
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
          <SettingsValueRow
            label={de.settings.categories}
            value={categorySummary(settings.categoryIds, categories, settings.categoryMode)}
            note={categoriesNote}
          />
        </ListRow>
        <ListRow onClick={() => setView("difficulty")} data-testid="settings-difficulty-row">
          <SettingsValueRow label={de.settings.difficulty} value={difficultySummary(settings)} note={difficultyNote} />
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

/**
 * Inhalt einer Zeile der Kategorien-Auswahl (ADR-048): Icon-Kachel und Name. Die Kachel ist dekorativ – der Name
 * steht daneben und wird so nur einmal vorgelesen (docs/09 §12). Lange Namen brechen bei Text-Zoom um.
 */
export function CategoryChoice({ category }: { category: CategoryVisual }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <CategoryBadge category={category} compact decorative />
      <span className="min-w-0 hyphens-auto wrap-break-word">{category.name}</span>
    </span>
  );
}

/**
 * Inhalt der Zeilen „Kategorien“ und „Schwierigkeit“: links die Beschriftung (bei Vorschlägen darunter „Aktuell: …“),
 * rechts der Wert (`label`; abweichend vom aktuellen Stand in `primary`, ADR-053). Der Wert wird nie gekürzt: Passt er
 * nicht neben die Beschriftung (lange Werte, Text-Zoom), rückt er rechtsbündig in die nächste Zeile.
 */
export function SettingsValueRow({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <span className="flex flex-wrap items-center justify-between gap-x-3 py-2">
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {note ? <span className="text-caption text-text-2">{note}</span> : null}
      </span>
      <span
        className={cx("ml-auto min-w-0 text-right text-label wrap-break-word", note ? "text-primary" : "text-text-2")}
      >
        {value}
      </span>
    </span>
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
