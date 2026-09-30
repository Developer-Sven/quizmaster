# Test-Fixtures: Fragenkatalog

Synthetischer Katalog für Tests, CI und E2E (ADR-021: der echte Katalog `content/` ist privat und nicht im Repo).

- 19 Kategorien mit Namen, Icon, Farbe und Reihenfolge wie im echten Katalog, sonst nur neutrale Texte.
- Je Kategorie 10–12 Fragen („Fixture-Frage 3 zu Comics?“), Flaggen-Bildfragen unter
  `questions/rund-um-die-welt/flaggen.json`, Zahlenfragen (`displayOrder: "asc"`) unter `…/zahlen.json`.
- `answers[0]` ist richtig und beginnt mit „Richtig“; `targets.minPlayable` = 3.
- Pro Kategorie eine `approved`-Frage; je eine `needs_fix`- (Comics) und `retired`-Frage (Kinofilme).

Nicht von Hand ändern – neu erzeugen (deterministisch):

```sh
pnpm --filter @quizmaster/scripts content:fixtures        # schreibt und formatiert
node scripts/content/make-fixtures.ts --check             # prüft, ob die Dateien aktuell sind
```

Der Seed erkennt die Fixtures (Pfad bzw. Markierung in `categories.json`) und verweigert sie gegen Produktion.
