/**
 * Kategorie-Darstellungen einer Lobby (Name, Icon, Farbe). Der Server schickt sie mit jedem Zug als
 * `turn.options`; der Client merkt sie sich, damit Tafel und „Fragen ansehen“ auch frühere Züge
 * darstellen können – über ein Neuladen hinweg im lokalen Speicher (nur die aktuelle Lobby, geprüft).
 */
import {
  type CategoryOption,
  categoryIdSchema,
  categoryOptionSchema,
  hexColorSchema,
  iconNameSchema,
} from "@quizmaster/shared";
import { array, object, record, string } from "zod";
import type { CategoryCatalog } from "./game-view";

/** Höchstens so viele Kategorien werden gespeichert (es gibt 19). */
const MAX_STORED = 64;

const storedSchema = object({
  code: string().max(16),
  categories: record(categoryIdSchema, categoryOptionSchema),
});

/** Gespeicherter Katalog für `code` – leer, wenn nichts, etwas Ungültiges oder eine andere Lobby gespeichert ist. */
export function parseStoredCategories(json: string | null, code: string): CategoryCatalog {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // Beschädigter Eintrag: verwerfen, der Katalog füllt sich mit dem nächsten Zug neu.
    return {};
  }
  const parsed = storedSchema.safeParse(raw);
  if (!parsed.success || parsed.data.code !== code) return {};
  const entries = Object.entries(parsed.data.categories).filter(([id, option]) => id === option.id);
  return Object.fromEntries(entries.slice(0, MAX_STORED)) as Record<string, CategoryOption>;
}

export function serializeCategories(code: string, catalog: CategoryCatalog): string {
  const categories = Object.fromEntries(Object.entries(catalog).slice(0, MAX_STORED));
  return JSON.stringify({ code, categories });
}

/** Antwort von `GET /api/categories` (nur die Felder, die der Client braucht; weitere werden ignoriert). */
const categoriesResponseSchema = object({
  categories: array(
    object({
      id: categoryIdSchema,
      name: string().min(1).max(64),
      icon: iconNameSchema,
      color: hexColorSchema,
    }),
  ).max(MAX_STORED),
});

/** Liest die Antwort von `GET /api/categories`; ungültige Antworten ergeben eine leere Liste. */
export function parseCategoriesResponse(body: unknown): CategoryOption[] {
  const parsed = categoriesResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.categories : [];
}

let catalogRequest: Promise<CategoryOption[]> | null = null;

/**
 * Lädt die öffentliche Kategorienliste einmal pro Seite – nur als Ersatz, wenn Tafel oder Rückblick
 * Kategorien früherer Züge zeigen, die dieser Client nicht gesehen hat (z. B. neuer Tab mitten im Spiel).
 */
export function loadCategoryCatalog(): Promise<CategoryOption[]> {
  catalogRequest ??= fetch("/api/categories", { headers: { accept: "application/json" }, credentials: "same-origin" })
    .then(async (response) => (response.ok ? parseCategoriesResponse(await response.json()) : []))
    .catch((error: unknown) => {
      console.warn("Kategorien nicht geladen:", error instanceof Error ? error.name : "unbekannt");
      catalogRequest = null;
      return [];
    });
  return catalogRequest;
}
