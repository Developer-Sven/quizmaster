/**
 * Startseite (docs/09 §6, ADR-039/043): Statuszeile „Trete bei …“ und die Bedienbarkeit während eines laufenden
 * Erstellens bzw. Beitretens. Serverseitig gerendert – geprüft wird das Markup des ersten Renderns.
 */
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { de } from "../../i18n/de";
import { StartScreen, startBusyState } from "./start-screen";

const noop = () => undefined;
const router: AppRouterInstance = {
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
  bfcacheId: "test",
};

function renderStart(): string {
  return renderToStaticMarkup(
    h(
      AppRouterContext.Provider,
      { value: router },
      h(StartScreen, { realtimeUrl: "", turnstile: { enabled: false, siteKey: null } }),
    ),
  );
}

describe("Startseite: Statuszeile beim Auto-Beitritt (WCAG 4.1.3, ADR-039)", () => {
  it("steht von Anfang an als leere Live-Region im DOM – ohne eigene Höhe, die drei Wege bleiben im 16-px-Rhythmus", () => {
    const html = renderStart();
    const status = /<p role="status" data-testid="start-join-status" class="([^"]*)"><\/p>/.exec(html);
    expect(status, "leere Statuszeile im ersten Rendern").not.toBeNull();
    const classes = (status?.[1] ?? "").split(" ");
    // Nie aus dem Accessibility-Tree nehmen (display: none) – sonst sagen viele Screenreader den Text nicht an.
    for (const hiding of ["hidden", "empty:hidden", "sr-only", "invisible"]) expect(classes).not.toContain(hiding);
    // Keine reservierte Zeile (ADR-043: 16 px zwischen den Wegen): „Trete bei …“ liegt außerhalb des Flusses im
    // 16-px-Abstand unter den Code-Zellen – es verschiebt nichts, und im Leerlauf kostet es keinen Platz.
    expect(classes).toEqual(
      expect.arrayContaining(["absolute", "inset-x-0", "top-full", "text-caption", "text-text-2"]),
    );
    expect(classes).not.toContain("min-h-4");
    expect(html).toMatch(/<div class="relative"><div class="flex flex-col gap-2"><label[^>]*>Lobby-Code<\/label>/);
  });

  it("„Lobby erstellen“ ist anfangs bedienbar", () => {
    const button = /<button [^>]*data-testid="start-create"[^>]*>/.exec(renderStart())?.[0] ?? "";
    expect(button).toContain('type="submit"');
    expect(button).not.toContain("aria-disabled");
    expect(button).not.toContain("aria-busy");
  });
});

describe("Startseite bei Text-Zoom 200 % (WCAG 1.4.4, 1.4.10)", () => {
  it("Wortmarke trennt bzw. bricht um wie die Spielende-Überschrift, statt die Seite zu verbreitern", () => {
    const wordmark = /<h1 class="([^"]*)">quizmaster/.exec(renderStart());
    const classes = (wordmark?.[1] ?? "").split(" ");
    expect(classes).toEqual(expect.arrayContaining(["text-wordmark", "hyphens-auto", "wrap-break-word"]));
  });
});

describe("startBusyState: während eines Ablaufs ist kein anderer Weg bedienbar", () => {
  it("ohne Ablauf: alles bedienbar, keine Statusmeldung", () => {
    expect(startBusyState(null)).toEqual({
      createDisabled: false,
      createLoading: false,
      otherWaysDisabled: false,
      joinStatus: "",
    });
  });

  it("Beitritt läuft: „Lobby erstellen“ gesperrt (nicht nur wirkungslos), Code und QR-Scan auch, „Trete bei …“", () => {
    expect(startBusyState("join")).toEqual({
      createDisabled: true,
      createLoading: false,
      otherWaysDisabled: true,
      joinStatus: de.start.joining,
    });
  });

  it("Erstellen läuft: „Lobby erstellen“ zeigt das Laden, Code und QR-Scan gesperrt", () => {
    expect(startBusyState("create")).toEqual({
      createDisabled: false,
      createLoading: true,
      otherWaysDisabled: true,
      joinStatus: "",
    });
  });
});
