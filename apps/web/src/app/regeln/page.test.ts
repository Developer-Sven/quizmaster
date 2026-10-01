import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { de } from "../../i18n/de";
import RulesPage, { metadata } from "./page";

/** „kurze Punkte“ (docs/09 §6): höchstens zwei kurze Sätze je Punkt. */
const MAX_POINT_LENGTH = 120;

describe("Regeln-Seite /regeln (docs/09 §6)", () => {
  it("zeigt höchstens 6 kurze Punkte als nummerierte Liste", () => {
    const html = renderToStaticMarkup(RulesPage());
    expect(de.rules.points.length).toBeGreaterThan(0);
    expect(de.rules.points.length).toBeLessThanOrEqual(6);
    expect(html.match(/<li>/g)).toHaveLength(de.rules.points.length);
    expect(html).toMatch(/<ol data-testid="rules-list" class="list-decimal /);
    for (const point of de.rules.points) {
      expect(point.length, point).toBeLessThanOrEqual(MAX_POINT_LENGTH);
      expect(html).toContain(`<li>${point}</li>`);
    }
  });

  it("ist ruhig: Titel „Regeln“, keine orange Hauptaktion, Rückweg „Zur Startseite“ als normaler Link", () => {
    const html = renderToStaticMarkup(RulesPage());
    expect(html).toMatch(/<h1 class="[^"]*\btext-h1\b[^"]*">Regeln<\/h1>/);
    expect(html).not.toContain("bg-primary");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>.*Zur Startseite/);
    expect(html).not.toContain('href="/regeln"');
    expect(metadata.title).toBe("Regeln");
  });

  it("nennt die Spielregeln aus docs/01 – ohne Extras", () => {
    const text = de.rules.points.join(" ").replaceAll("\u00a0", " ");
    for (const fact of [
      "2 bis 8 Personen",
      "ausgelost",
      "3 Kategorien",
      "4 Antworten",
      "20 Sekunden",
      "nicht ändern",
      "1 Punkt",
      "gleichen Platz",
      "aufgegeben",
    ]) {
      expect(text).toContain(fact);
    }
    expect(text).not.toMatch(/joker|bonus|chat|level|abzeichen|werbung/i);
  });

  it("bricht nie zwischen Zahl und Einheit um (geschütztes Leerzeichen)", () => {
    for (const unit of ["Personen", "Kategorien", "Antworten", "Sekunden", "Punkt"]) {
      const point = de.rules.points.find((candidate) => candidate.includes(unit));
      expect(point, unit).toMatch(new RegExp(`\\d\\u00a0${unit}`));
    }
  });
});
