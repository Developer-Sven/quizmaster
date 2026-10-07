import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WifiOffIcon } from "../../lib/ui/icons";
import { Banner } from "./banner";
import { Dialog } from "./dialog";
import { EmptyState } from "./empty-state";
import { Sheet } from "./sheet";
import { Skeleton } from "./skeleton";
import { renderHtml } from "./ssr-render";
import { Toast, ToastPanel } from "./toast";

const noop = () => {};

describe("Ebenen (Sheet, Dialog, Toast)", () => {
  it("rendern auf dem Server nichts – sie hängen sich erst im Browser an body", () => {
    expect(renderHtml(Sheet, { open: true, onClose: noop, title: "Einstellungen" }, "Inhalt")).toBe("");
    expect(
      renderToStaticMarkup(
        h(Dialog, {
          open: true,
          title: "Spiel verlassen?",
          confirmLabel: "Verlassen",
          cancelLabel: "Weiterspielen",
          onConfirm: noop,
          onCancel: noop,
        }),
      ),
    ).toBe("");
    expect(renderToStaticMarkup(h(Toast, { message: "Danke, wir prüfen die Frage.", onDismiss: noop }))).toBe("");
  });
});

describe("ToastPanel (sichtbarer Teil des Toasts)", () => {
  const longest = "Zu viele offene Verbindungen. Schließ andere Tabs.";

  it("bricht lange Meldungen um statt sie abzuschneiden (docs/09 §11-Texte passen nicht in 1 Zeile)", () => {
    const html = renderToStaticMarkup(h(ToastPanel, { message: longest, tone: "error" }));
    expect(html).toContain(longest);
    expect(html).not.toMatch(/truncate|line-clamp|whitespace-nowrap/);
    expect(html).toContain("lucide-triangle-alert");
  });

  it("ist ein schwebendes Panel der Ebene 2, nicht in Button-/Eingabe-Optik (docs/09 §2)", () => {
    const html = renderToStaticMarkup(h(ToastPanel, { message: "Danke, wir prüfen die Frage.", tone: "info" }));
    expect(html).toContain("rounded-xl border border-line bg-surface-1");
    expect(html).toContain("shadow-level-2");
    expect(html).not.toMatch(/border-line-strong|bg-surface-2|rounded-lg/);
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("Banner", () => {
  it("bietet bei Update „Aktualisieren“ an", () => {
    const html = renderToStaticMarkup(h(Banner, { tone: "update", onAction: noop }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Neue Version verfügbar");
    expect(html).toMatch(/<button[^>]*>.*Aktualisieren/);
    expect(html).toContain("min-h-14");
  });

  it("zeigt lange Wartungstexte vollständig (Schema erlaubt 200 Zeichen), ohne abzuschneiden", () => {
    const message = `${"Wir spielen ein Update ein, laufende Spiele enden vorher sauber. ".repeat(3)}Bis gleich.`;
    const html = renderToStaticMarkup(h(Banner, { tone: "maintenance", message }));
    expect(html).toContain(message);
    expect(html).not.toMatch(/line-clamp|truncate/);
  });

  it("zeigt bei Wartung den Standardtext mit triangle-alert", () => {
    const html = renderToStaticMarkup(h(Banner, { tone: "maintenance" }));
    expect(html).toContain("Wartung – gleich geht es weiter.");
    expect(html).toContain("lucide-triangle-alert");
    expect(html).not.toContain("<button");
  });
});

describe("Skeleton und EmptyState", () => {
  it("pulsiert in surface-2, außer bei reduzierter Bewegung, und ist dekorativ", () => {
    const html = renderToStaticMarkup(h(Skeleton, { shape: "answer" }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-pulse bg-surface-2 motion-reduce:animate-none");
    expect(html).toContain("h-16");
  });

  it("Avatar bleibt neben einer Textzeile ein Kreis 40 × 40 – er schrumpft in einer Zeile nicht (docs/09 §13)", () => {
    const classes = (/class="([^"]*)"/.exec(renderToStaticMarkup(h(Skeleton, { shape: "avatar" })))?.[1] ?? "").split(
      " ",
    );
    expect(classes).toEqual(expect.arrayContaining(["size-10", "shrink-0", "rounded-full"]));
  });

  it("zeigt Icon 40 in text-3, eine Zeile und optional eine Aktion", () => {
    const html = renderToStaticMarkup(
      h(EmptyState, {
        icon: WifiOffIcon,
        message: "Du bist offline.",
        as: "h1",
        action: h("button", { type: "button" }, "x"),
      }),
    );
    expect(html).toContain('width="40"');
    expect(html).toContain("text-text-3");
    expect(html).toContain("<h1");
    expect(html).toContain("Du bist offline.");
    expect(html).toContain('<button type="button">x</button>');
    expect(html).not.toContain("tabindex");
  });

  it("macht den Text fokussierbar, wenn er eine Seite ersetzt (Fokus statt body, WCAG 2.4.3)", () => {
    const html = renderToStaticMarkup(
      h(EmptyState, {
        icon: WifiOffIcon,
        message: "Du wurdest aus der Lobby entfernt.",
        as: "h1",
        headingRef: { current: null },
      }),
    );
    expect(html).toMatch(/<h1 tabindex="-1" class="[^"]*">Du wurdest aus der Lobby entfernt\.<\/h1>/);
  });
});
