/**
 * Texte zu Einstellungen: Kategorie-Auswahl (ADR-048) und – für Vorschläge (ADR-053) – Beschriftung und Wert jeder
 * vorschlagbaren Einstellung, „Aktuell: …“ und die Kurzfassung eines Vorschlags.
 */
import {
  applySettingsUpdate,
  DIFFICULTIES,
  type Difficulty,
  type LobbySettings,
  type SettingsChanges,
  SUGGESTABLE_SETTINGS,
  type SuggestableSetting,
  spreadDifficulties,
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

/** Stepper-Wert als Schwierigkeitsstufe (die Stepper-Grenzen halten ihn ohnehin in 1–5). */
export function asDifficulty(value: number): Difficulty {
  return DIFFICULTIES.find((level) => level === value) ?? (value < 1 ? 1 : 5);
}

type DifficultySettings = Pick<
  LobbySettings,
  "difficultyMin" | "difficultyMax" | "difficultyBasis" | "difficultyOrder"
>;

/** Wert der Zeile „Schwierigkeit“ (ADR-055): „1–5, pro Frage aufsteigend“ bzw. „nur Stufe 2“. */
export function difficultySummary(settings: DifficultySettings): string {
  const { difficultyMin: min, difficultyMax: max } = settings;
  if (min === max) return de.settings.difficultyOnly(min);
  return de.settings.difficultyRange(
    min,
    max,
    de.settings.difficultyModes[settings.difficultyBasis][settings.difficultyOrder],
  );
}

/** Zeigt die Schwierigkeit nicht den Standard (alle Stufen, pro Frage aufsteigend)? */
export function isCustomDifficulty(settings: DifficultySettings): boolean {
  return (
    settings.difficultyMin !== 1 ||
    settings.difficultyMax !== 5 ||
    settings.difficultyBasis !== "question" ||
    settings.difficultyOrder !== "ascending"
  );
}

/** Höchstens so viele Stufen zeigt die Vorschau „Kategorien nacheinander“, danach „…“. */
const PREVIEW_MAX_TURNS = 12;

/**
 * Vorschau unter den Schwierigkeits-Optionen (ADR-055): was tatsächlich passiert – je Kategorie „1 · 3 · 5“,
 * nacheinander über alle geplanten Züge (`rounds` × Mitspielende) oder „zufällig von … bis …“.
 */
export function difficultyPreview(
  settings: DifficultySettings & Pick<LobbySettings, "rounds" | "questionsPerCategory">,
  players: number,
): string {
  const { difficultyMin: min, difficultyMax: max } = settings;
  if (min === max) return de.settings.difficultyPreviewOnly(min);
  if (settings.difficultyOrder === "random") {
    return settings.difficultyBasis === "question"
      ? de.settings.difficultyPreviewQuestionRandom(min, max)
      : de.settings.difficultyPreviewCategoryRandom(min, max);
  }
  if (settings.difficultyBasis === "question") {
    return de.settings.difficultyPreviewQuestion(
      spreadDifficulties(min, max, settings.questionsPerCategory).join(" · "),
    );
  }
  const turns = spreadDifficulties(min, max, settings.rounds * Math.max(players, 1));
  const shown = turns.slice(0, PREVIEW_MAX_TURNS).join(" · ");
  return de.settings.difficultyPreviewCategory(turns.length > PREVIEW_MAX_TURNS ? `${shown} …` : shown);
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
    case "difficultyMin":
      return de.settings.difficultyMin;
    case "difficultyMax":
      return de.settings.difficultyMax;
    case "difficultyBasis":
      return de.settings.difficultyBasisTitle;
    case "difficultyOrder":
      return de.settings.difficultyOrderTitle;
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
    case "difficultyBasis":
      return de.settings.difficultyBases[settings.difficultyBasis];
    case "difficultyOrder":
      return de.settings.difficultyOrders[settings.difficultyOrder];
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
