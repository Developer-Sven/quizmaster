import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { de } from "../../i18n/de";
import { PlayIcon, SmartphoneIcon } from "../../lib/ui/icons";
import { Button, ButtonLink } from "./button";
import { CodeInput } from "./code-input";
import { IconButton } from "./icon-button";
import { ListRow } from "./list-row";
import { renderHtml } from "./ssr-render";
import { Stepper, stepOption } from "./stepper";
import { TextField } from "./text-field";

const noop = () => {};

describe("Button", () => {
  it("ist ein Button vom Typ button mit Variante, Höhe 56 und Fokus-Ring", () => {
    const html = renderHtml(Button, { variant: "primary", icon: PlayIcon }, "Spiel starten");
    expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(html).toContain("bg-primary text-on-primary");
    expect(html).toContain("min-h-14");
    expect(html).toContain("is-focus:outline-2 is-focus:outline-offset-2 is-focus:outline-primary");
    expect(html).toContain("lucide-play");
    expect(html).toContain("Spiel starten");
  });

  it("deaktiviert per aria-disabled und bleibt fokussierbar", () => {
    const html = renderHtml(Button, { variant: "secondary", disabled: true }, "Beitreten");
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled=""/);
    expect(html).toContain("cursor-not-allowed opacity-40");
  });

  it("zeigt beim Laden loader-circle, behält den Text und meldet aria-busy", () => {
    const html = renderHtml(Button, { variant: "primary", loading: true, icon: PlayIcon }, "Beitreten");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("lucide-loader-circle");
    expect(html).toContain("animate-spin motion-reduce:animate-none");
    expect(html).toContain("cursor-wait");
    expect(html).not.toContain("opacity-40");
    expect(html).not.toContain("lucide-play");
    expect(html).toContain("Beitreten");
  });

  it("hat kompakt 44 px Höhe mit 48-px-Trefferfläche", () => {
    const html = renderHtml(Button, { variant: "ghost", size: "compact" }, "Revanche");
    expect(html).toContain("min-h-11");
    expect(html).toContain("before:-inset-y-0.5");
  });

  it("gibt destructive roten Text ohne rote Fläche", () => {
    const html = renderHtml(Button, { variant: "destructive" }, "Verlassen");
    expect(html).toContain("text-danger");
    expect(html).not.toContain("bg-danger");
  });

  it("zeigt die Hauptaktion auch im Kontrastmodus als Button: transparenter Rahmen (WCAG 1.4.11)", () => {
    // forced-colors macht die orange Fläche zu Canvas – nur ein Rahmen (dann in Systemfarbe) bleibt sichtbar.
    const primary = renderHtml(Button, { variant: "primary" }, "Spiel starten");
    expect(primary).toContain("border border-transparent bg-primary");
    // Sekundär und destruktiv tragen ihren sichtbaren Rahmen ohnehin.
    expect(renderHtml(Button, { variant: "secondary" }, "Beitreten")).toContain("border border-line-strong");
    expect(renderHtml(Button, { variant: "destructive" }, "Verlassen")).toContain("border border-line-strong");
  });

  it("schneidet Beschriftungen nie ab: bricht bei Text-Zoom um und wächst mit (WCAG 1.4.4)", () => {
    for (const html of [
      renderHtml(Button, { variant: "primary", icon: PlayIcon, block: true }, "Spiel starten"),
      renderHtml(Button, { variant: "ghost", size: "compact" }, "QR-Code zeigen"),
      renderHtml(ButtonLink, { variant: "secondary", href: "/" }, "Zur Startseite"),
    ]) {
      expect(html).not.toContain("truncate");
      expect(html).not.toMatch(/(?:^|[\s"])h-1[14](?:[\s"]|$)/);
      expect(html).toMatch(/<span class="min-w-0 text-center wrap-break-word">[^<]+<\/span>/);
    }
  });

  it("rendert ButtonLink als Link mit denselben Klassen", () => {
    const html = renderHtml(ButtonLink, { variant: "primary", href: "/" }, "Zur Startseite");
    expect(html).toMatch(/^<a[^>]*href="\/"/);
    expect(html).toContain("bg-primary");
  });
});

describe("IconButton", () => {
  it("braucht ein Label für aria-label und title und ist 44 × 44 mit 48-px-Trefferfläche", () => {
    const html = renderToStaticMarkup(h(IconButton, { icon: SmartphoneIcon, label: "Als App installieren" }));
    expect(html).toContain('aria-label="Als App installieren"');
    expect(html).toContain('title="Als App installieren"');
    expect(html).toContain("size-11");
    expect(html).toContain("before:-inset-0.5");
    expect(html).toContain('aria-hidden="true"');
  });

  it("zeigt aktive Umschalter orange mit aria-pressed", () => {
    const active = renderToStaticMarkup(h(IconButton, { icon: PlayIcon, label: "Gute Frage", pressed: true }));
    expect(active).toContain('aria-pressed="true"');
    expect(active).toContain("text-primary");
    const idle = renderToStaticMarkup(h(IconButton, { icon: PlayIcon, label: "Gute Frage" }));
    expect(idle).not.toContain("aria-pressed");
  });
});

describe("TextField", () => {
  it("verknüpft Label und Feld", () => {
    const html = renderToStaticMarkup(h(TextField, { label: "Dein Name", defaultValue: "Mia" }));
    const id = /<input[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain("h-14");
    expect(html).toContain("border-line-strong is-field-focus:border-primary is-field-focus:outline-primary");
  });

  it("zeigt Fehler rot mit triangle-alert und verknüpft ihn", () => {
    const html = renderToStaticMarkup(h(TextField, { label: "Dein Name", error: "Name nicht erlaubt." }));
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('role="alert"');
    expect(html).toContain("lucide-triangle-alert");
    expect(html).toContain("border-danger");
  });
});

describe("CodeInput", () => {
  it("zeigt 6 Zellen mit Lücke nach Zelle 3 und normalisiert den Startwert", () => {
    const html = renderToStaticMarkup(h(CodeInput, { defaultValue: "abc-234" }));
    const cells = html.match(/<span aria-hidden="true" class="flex h-14 w-12[^"]*"[^>]*>[^<]*<\/span>/g) ?? [];
    expect(cells).toHaveLength(6);
    expect(cells.map((cell) => />([^<]*)</.exec(cell)?.[1])).toEqual(["A", "B", "C", "2", "3", "4"]);
    expect(cells[3]).toContain("ml-3");
    expect(html).toContain("Lobby-Code");
    expect(html).toContain('value="ABC234"');
    expect(html).toContain('autoCapitalize="characters"');
  });

  it("färbt im Fehlerzustand alle Zellen rot", () => {
    const html = renderToStaticMarkup(h(CodeInput, { defaultValue: "XY", error: "Lobby nicht gefunden." }));
    expect(html.match(/border-danger/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('aria-invalid="true"');
  });

  it("kündigt den Auto-Beitritt vorab an und verknüpft Hinweis und Fehler (WCAG 3.2.2)", () => {
    const html = renderToStaticMarkup(
      h(CodeInput, { onComplete: noop, hint: "Nach dem 6. Zeichen trittst du automatisch bei." }),
    );
    const hintId = /<p id="([^"]+)"[^>]*>Nach dem 6\. Zeichen trittst du automatisch bei\.<\/p>/.exec(html)?.[1];
    expect(hintId).toBeTruthy();
    expect(html).toContain(`aria-describedby="${hintId}"`);
    const withError = renderToStaticMarkup(
      h(CodeInput, { onComplete: noop, hint: "Hinweis", error: "Lobby nicht gefunden." }),
    );
    const describedBy = /aria-describedby="([^"]+)"/.exec(withError)?.[1]?.split(" ") ?? [];
    expect(describedBy).toHaveLength(2);
    for (const id of describedBy) expect(withError).toContain(`id="${id}"`);
  });

  it("kann den Hinweis nur für Screenreader zeigen – weiter verknüpft, aber nicht sichtbar (ADR-043)", () => {
    const html = renderToStaticMarkup(h(CodeInput, { onComplete: noop, hint: "Hinweis", hintHidden: true }));
    const hint = /<p id="([^"]+)" class="([^"]*)"[^>]*>Hinweis<\/p>/.exec(html);
    expect(hint?.[2]).toContain("sr-only");
    expect(hint?.[2]).not.toContain("text-caption");
    expect(html).toContain(`aria-describedby="${hint?.[1]}"`);
  });

  it("verlangt mit Auto-Beitritt einen Hinweis (Typfehler ohne) und bleibt ohne onComplete schlicht", () => {
    // @ts-expect-error hint ist Pflicht, sobald onComplete gesetzt ist (Kontextwechsel, WCAG 3.2.2)
    const withoutHint = renderToStaticMarkup(h(CodeInput, { onComplete: noop }));
    expect(withoutHint).not.toContain("aria-describedby");
    expect(renderToStaticMarkup(h(CodeInput, { defaultValue: "AB" }))).not.toContain("<p");
  });

  it("markiert die aktive Zelle mit 2 px primary", () => {
    const html = renderToStaticMarkup(h(CodeInput, { defaultValue: "AB", "data-force": "focus" }));
    expect(html.match(/border-primary outline-1 -outline-offset-2 outline-primary/g)).toHaveLength(1);
  });
});

describe("Stepper", () => {
  it("deaktiviert minus an der Untergrenze", () => {
    const html = renderToStaticMarkup(h(Stepper, { label: "Runden", value: 1, min: 1, max: 10, onChange: noop }));
    expect(html).toContain('aria-label="Runden verringern" title="Runden verringern" aria-disabled="true"');
    expect(html).not.toContain('aria-label="Runden erhöhen" title="Runden erhöhen" aria-disabled="true"');
    expect(html).toMatch(/<output[^>]*>1<\/output>/);
    expect(html).toMatch(/<fieldset aria-labelledby="[^"]+"/);
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("text-primary");
  });

  it("deaktiviert plus an der Obergrenze", () => {
    const html = renderToStaticMarkup(
      h(Stepper, { label: "Personen maximal", value: 8, min: 2, max: 8, onChange: noop }),
    );
    expect(html).toContain(
      'aria-label="Personen maximal erhöhen" title="Personen maximal erhöhen" aria-disabled="true"',
    );
    expect(html).not.toContain(
      'aria-label="Personen maximal verringern" title="Personen maximal verringern" aria-disabled',
    );
  });

  it("feste Stufen mit eigener Anzeige (Weiter nach …, ADR-045): „Host“ bei 0, sonst Sekunden", () => {
    const options = [0, 3, 5, 7, 10, 15, 20, 30] as const;
    const format = (value: number) => (value === 0 ? "Host" : `${value} s`);
    const manual = renderToStaticMarkup(
      h(Stepper, { label: "Nach jeder Frage", value: 0, options, format, onChange: noop }),
    );
    expect(manual).toMatch(/<output[^>]*>Host<\/output>/);
    expect(manual).toContain(
      'aria-label="Nach jeder Frage verringern" title="Nach jeder Frage verringern" aria-disabled="true"',
    );
    const top = renderToStaticMarkup(
      h(Stepper, { label: "Nach jeder Frage", value: 30, options, format, onChange: noop }),
    );
    expect(top).toMatch(/<output[^>]*>30 s<\/output>/);
    expect(top).toContain(
      'aria-label="Nach jeder Frage erhöhen" title="Nach jeder Frage erhöhen" aria-disabled="true"',
    );
    expect(stepOption(options, 5, 1)).toBe(7);
    expect(stepOption(options, 5, -1)).toBe(3);
    expect(stepOption(options, 3, -1)).toBe(0);
    expect(stepOption(options, 30, 1)).toBeNull();
    expect(stepOption(options, 0, -1)).toBeNull();
    // Ein Wert zwischen den Stufen springt zur nächsten passenden.
    expect(stepOption(options, 4, 1)).toBe(5);
    expect(stepOption(options, 4, -1)).toBe(3);
  });
});

describe("ListRow", () => {
  it("ist als Button 56 hoch mit Trennlinie und zeigt ausgewählt ein check", () => {
    const html = renderHtml(ListRow, { onClick: noop, selected: true }, "Falsch");
    expect(html).toMatch(/^<button[^>]*aria-pressed="true"/);
    expect(html).toContain("min-h-14");
    expect(html).toContain("border-b border-line");
    expect(html).toContain("lucide-check");
  });

  it("rendert Link und statische Zeile", () => {
    expect(renderHtml(ListRow, { href: "/regeln" }, "Regeln")).toMatch(/^<a[^>]*href="\/regeln"/);
    expect(renderHtml(ListRow, {}, "Regeln")).toMatch(/^<div/);
  });

  it("nennt die Auswahl einer statischen Zeile auch Screenreadern (Nur-Lesen-Einstellungen, ADR-050)", () => {
    // Das `check` ist aria-hidden; ohne Button gibt es kein aria-pressed – also ein Text nur für Screenreader.
    const selected = renderHtml(ListRow, { selected: true }, "Mia spielt mit");
    expect(selected).toMatch(/^<div/);
    expect(selected).toContain("lucide-check");
    expect(selected).toContain(`<span class="sr-only">${de.a11y.selected}</span>`);
    expect(renderHtml(ListRow, {}, "Mia zeigt nur an")).not.toContain("sr-only");
    // Der Button meldet die Auswahl schon über aria-pressed.
    expect(renderHtml(ListRow, { onClick: noop, selected: true }, "Sport")).not.toContain("sr-only");
  });
});

describe("Stepper mit geändertem Wert (Vorschläge, ADR-053)", () => {
  it("zeigt „Aktuell: …“ unter dem Label, verknüpft es per aria-describedby und färbt den Wert orange", () => {
    const html = renderToStaticMarkup(
      h(Stepper, { label: "Runden", value: 5, min: 1, max: 10, onChange: () => undefined, changedNote: "Aktuell: 3" }),
    );
    const describedBy = /<fieldset[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(
      `id="${describedBy}" class="text-caption text-text-2" data-testid="stepper-note">Aktuell: 3</span>`,
    );
    expect(html).toMatch(/<output[^>]*text-primary[^>]*>5<\/output>/);
  });
});
