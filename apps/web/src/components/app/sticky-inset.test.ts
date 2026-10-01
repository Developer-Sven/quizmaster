import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { renderHtml } from "../ui/ssr-render";
import { ActionBar, ActionBarNote } from "./action-bar";
import { AppHeader, HeaderTitle } from "./app-header";
import { stickyInsetProperty, stickyInsetValue } from "./sticky-inset";

describe("Klebende Leisten halten den Fokus frei (WCAG 2.4.11)", () => {
  it("melden ihre Höhe als CSS-Variable, aus der globals.css das scroll-padding bildet", () => {
    expect(stickyInsetProperty("top")).toBe("--sticky-top");
    expect(stickyInsetProperty("bottom")).toBe("--sticky-bottom");
    // größte Leiste je Rand, aufgerundet; ohne Leiste 0 (Variable wird dann entfernt)
    expect(stickyInsetValue([57, 88.4])).toBe(89);
    expect(stickyInsetValue([])).toBe(0);
  });

  it("Kopfzeile und Aktionsleiste tragen den Messpunkt (unsichtbar)", () => {
    expect(renderHtml(AppHeader, { title: "Lobby" })).toMatch(/^<header class="sticky top-0[^"]*"><span hidden="">/);
    expect(renderHtml(ActionBar, {}, "x")).toMatch(/^<div class="sticky bottom-0[^"]*"><span hidden="">/);
  });
});

describe("Text-Zoom (WCAG 1.4.4): nichts wird abgeschnitten", () => {
  it("Kopfzeile wächst mit dem Titel, der Titel bricht um statt mit Ellipse zu enden", () => {
    const header = renderHtml(AppHeader, { title: h(HeaderTitle, null, "Beitreten") });
    expect(header).toContain("min-h-14");
    expect(header).not.toMatch(/(?:^|[\s"])h-14(?:[\s"]|$)/);
    expect(header).toMatch(/<h1 class="[^"]*wrap-break-word[^"]*">Beitreten<\/h1>/);
    expect(header).not.toContain("truncate");
  });

  it("Wartetext der Aktionsleiste hat eine Mindesthöhe statt einer festen", () => {
    const note = renderHtml(ActionBarNote, {}, "Warte auf Mia …");
    expect(note).toContain("min-h-14");
    expect(note).not.toMatch(/(?:^|[\s"])h-14(?:[\s"]|$)/);
  });
});
