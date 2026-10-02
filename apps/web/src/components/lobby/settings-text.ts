/**
 * Texte zu Einstellungen: Kategorie-Auswahl (ADR-048) und – für Vorschläge (ADR-053) – Beschriftung und Wert jeder
 * vorschlagbaren Einstellung, „Aktuell: …“ und die Kurzfassung eines Vorschlags.
 */
import {
  applySettingsUpdate,
  type LobbySettings,
  type SettingsChanges,
  SUGGESTABLE_SETTINGS,
  type SuggestableSetting,
} from "@quizmaster/shared";
import { de } from "../../i18n/de";
import type { CategoryCatalog } from "../../lib/client/game-view";

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

/** Beschriftung einer Einstellung wie im Sheet. */
export function settingLabel(key: SuggestableSetting): string {
  switch (key) {
    case "rounds":
      return de.settings.rounds;
    case "questionsPerCategory":
      return de.settings.questionsPerCategory;
    case "maxPlayers":
      return de.settings.maxPlayers;
    case "categoryIds":
      return de.settings.categories;
    case "answerSec":
      return de.settings.answerTime;
    case "afterQuestionSec":
      return de.settings.afterQuestion;
    case "afterTurnSec":
      return de.settings.afterTurn;
    case "afterRoundSec":
      return de.settings.afterRound;
    case "hostPlays":
      return de.settings.hostTitleOther;
  }
}

/** Wert einer Einstellung als Text: „5“, „20 s“ bzw. „Host“, „Alle“/„Sport“/„3 ausgewählt“, „spielt mit“. */
export function settingValueText(settings: LobbySettings, key: SuggestableSetting, catalog: CategoryCatalog): string {
  switch (key) {
    case "categoryIds":
      return categorySummary(settings.categoryIds, catalog);
    case "answerSec":
    case "afterQuestionSec":
    case "afterTurnSec":
    case "afterRoundSec":
      return de.settings.advanceValue(settings[key]);
    case "hostPlays":
      return settings.hostPlays ? de.suggestions.hostPlaysValue : de.suggestions.hostPresentsValue;
    default:
      return String(settings[key]);
  }
}

/** Kurzfassung eines Vorschlags in der Reihenfolge des Sheets, z. B. „Runden: 5 · Zeit pro Frage: 30 s“. */
export function suggestionSummary(changes: SettingsChanges, current: LobbySettings, catalog: CategoryCatalog): string {
  const proposed = applySettingsUpdate(current, changes);
  return SUGGESTABLE_SETTINGS.filter((key) => changes[key] !== undefined)
    .map((key) => `${settingLabel(key)}: ${settingValueText(proposed, key, catalog)}`)
    .join(" · ");
}
