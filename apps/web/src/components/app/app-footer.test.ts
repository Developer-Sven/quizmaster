import { describe, expect, it } from "vitest";
import { renderHtml } from "../ui/ssr-render";
import { AppFooter, RulesLink } from "./app-footer";
import { ErrorView } from "./error-view";

describe("Link „Regeln“ (docs/09 §6)", () => {
  it("ist ein normaler Link auf /regeln in caption/text-3 mit 48-px-Trefferfläche", () => {
    const html = renderHtml(RulesLink, {});
    // Kein next/link: Dokument-Navigation, damit der Service Worker die Regeln auch offline liefert.
    expect(html).toMatch(/^<a href="\/regeln" data-testid="rules-link" class="[^"]*">Regeln<\/a>$/);
    expect(html).toContain("text-caption text-text-3 underline");
    expect(html).toContain("min-h-12 min-w-12");
    expect(html).not.toContain("target=");
  });

  it("öffnet in Lobby und Spielende einen neuen Tab – mit noopener und Hinweis für Screenreader", () => {
    const html = renderHtml(RulesLink, { newTab: true });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Regeln<span class="sr-only"> (öffnet in neuem Tab)</span></a>');
  });

  it("steht in einer Fußzeile – Safe-Area-Abstand nur als unterster Block einer Seite", () => {
    expect(renderHtml(AppFooter, {})).toMatch(/^<footer class="flex justify-center"><a href="\/regeln"/);
    expect(renderHtml(AppFooter, { safeArea: true })).toMatch(/^<footer class="flex justify-center pb-safe">/);
    expect(renderHtml(AppFooter, { newTab: true })).toContain('target="_blank"');
  });

  it("bietet weder Impressum noch Datenschutz an (ADR-030)", () => {
    const html = renderHtml(AppFooter, { safeArea: true });
    expect(html).not.toMatch(/Impressum|Datenschutz/);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("steht auf Fehler-, 404- und Offline-Seiten (ErrorView) unter dem Inhalt, außerhalb von main", () => {
    const html = renderHtml(ErrorView, { message: "Seite nicht gefunden.", testId: "not-found" });
    expect(html).toMatch(
      /<main data-testid="not-found"[^>]*>.*Zur Startseite.*<\/main><footer[^>]*><a href="\/regeln"/,
    );
    expect(html).not.toContain('target="_blank"');
  });
});
