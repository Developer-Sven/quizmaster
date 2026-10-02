import type { PublicLobbyState } from "@quizmaster/shared";
import { de } from "../../i18n/de";
import type { CategoryCatalog } from "../../lib/client/game-view";

/**
 * Zusatzzeile der Zusammenfassung – nur, was vom Standard abweicht: Kategorie-Auswahl (ADR-048), Zeit pro Frage
 * (ADR-049) und der anzeigende Host (ADR-046).
 */
export function settingsExtras(
  settings: Pick<PublicLobbyState["settings"], "categoryIds" | "answerSec">,
  categories: CategoryCatalog,
  presenterName: string | null,
): string[] {
  const parts: string[] = [];
  const ids = settings.categoryIds;
  const [only] = ids ?? [];
  if (ids !== null && ids.length === 1 && only !== undefined) {
    parts.push(de.lobby.onlyCategory(categories[only]?.name ?? only));
  } else if (ids !== null) {
    parts.push(de.lobby.categoryCount(ids.length));
  }
  if (settings.answerSec !== 20) parts.push(de.lobby.answerTime(settings.answerSec));
  if (presenterName !== null) parts.push(de.lobby.hostPresents(presenterName));
  return parts;
}
