/**
 * Gemeinsame `$match`-Stufe der Katalog-Watcher (docs/04 §Change-Stream-Watcher): Einfügen, Ersetzen und
 * Löschen werden immer ausgeliefert, Updates nur, wenn sich eines der für den Speicher relevanten Felder
 * geändert hat (oder entfernt wurde). So erreichen die Statistik-Updates jedes Spielabschlusses
 * (`stats.shown`/`stats.correct`), Bewertungen (`stats.likes`/`stats.dislikes`) und Meldungen
 * (`stats.reports`) den Server gar nicht erst.
 *
 * Die Pipeline stammt nur aus Code (nie aus Requests); `watchWithResume` stellt ihr den `$match` auf die
 * Operationen voran.
 */
import type { Document } from "mongodb";

export function relevantChangesPipeline(fields: readonly string[]): Document[] {
  if (fields.length === 0) throw new Error("relevantChangesPipeline: mindestens ein Feld angeben");
  return [
    {
      $match: {
        $or: [
          { operationType: { $in: ["insert", "replace", "delete"] } },
          {
            operationType: "update",
            $or: [
              ...fields.map((field) => ({ [`updateDescription.updatedFields.${field}`]: { $exists: true } })),
              { "updateDescription.removedFields": { $in: [...fields] } },
            ],
          },
        ],
      },
    },
  ];
}
