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
import { Toast } from "./toast";

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

describe("Banner", () => {
  it("bietet bei Update „Aktualisieren“ an", () => {
    const html = renderToStaticMarkup(h(Banner, { tone: "update", onAction: noop }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Neue Version verfügbar");
    expect(html).toMatch(/<button[^>]*>.*Aktualisieren/);
    expect(html).toContain("min-h-14");
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
  });
});
