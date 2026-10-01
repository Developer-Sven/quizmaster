/**
 * Layout-Stabilität der Spiel-Overlays (CLS-Ziel < 0,05 je Sitzung, docs/07): Was sich innerhalb eines Overlays
 * ändert, darf die übrigen Teile nicht verschieben. Serverseitig gerendert – geprüft wird das Markup.
 */
import type { CategoryOption, PublicPlayer, PublicQuestion } from "@quizmaster/shared";
import { type ComponentType, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { summarizeTurn } from "../../../lib/client/game-view";
import { MotionProvider } from "../../../lib/ui/motion";
import { AnswerRevealOverlay } from "./answer-reveal-overlay";
import { CategoryPickOverlay, type CategoryPickOverlayProps } from "./category-pick-overlay";
import { IntroOverlay } from "./intro-overlay";
import { QuestionOverlay } from "./question-overlay";
import { TurnSummaryOverlay } from "./turn-summary-overlay";

const NOW = Date.now();
const noop = () => {};

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(h(MotionProvider, null, h(component as ComponentType<P>, props)));
}

function player(id: string, name: string): PublicPlayer {
  return { id, name, color: "blue", isHost: false, isBot: false, connected: true, status: "active", score: 0 };
}

const options: [CategoryOption, CategoryOption, CategoryOption] = [
  { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" },
  { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" },
  { id: "kinofilme", name: "Kinofilme", icon: "clapperboard", color: "#EE5858" },
];

function pick(props: Partial<CategoryPickOverlayProps>): string {
  return render(CategoryPickOverlay, {
    options,
    picker: player("p2", "Ben"),
    isPicker: false,
    canPick: false,
    pickedId: null,
    phaseStartedAt: NOW - 2_000,
    phaseEndsAt: NOW + 13_000,
    timerRunId: "run",
    onPick: noop,
    ...props,
  });
}

/** Kopfzeile der Kategoriewahl: alles bis zur Kachelgruppe. */
function header(html: string): string {
  return html.slice(0, html.indexOf("<fieldset"));
}

describe("Kategoriewahl: die Wahl verschiebt nichts", () => {
  it("hält bei Zuschauenden den Platz des Timer-Rings nach der Wahl frei (der Titel bricht nicht neu um)", () => {
    const before = header(pick({}));
    const after = header(pick({ pickedId: "musik-hits" }));
    expect(before).toContain('role="timer"');
    expect(after).not.toContain('role="timer"');
    expect(after).toMatch(/<span aria-hidden="true" class="size-12 shrink-0"><\/span>/);
    expect(after).toContain("Ben wählt eine Kategorie");
    expect(after).toContain("BE");
  });

  it("zeigt der wählenden Person auch nach ihrer Wahl „Wähle eine Kategorie“ ohne eigenen Avatar (docs/09 §7.2)", () => {
    const before = header(pick({ picker: player("p1", "Mia"), isPicker: true, canPick: true }));
    const after = header(pick({ picker: player("p1", "Mia"), isPicker: true, canPick: false, pickedId: "kinofilme" }));
    for (const html of [before, after]) {
      expect(html).toContain("Wähle eine Kategorie");
      expect(html).not.toContain("Mia wählt");
      expect(html).not.toContain(">MI<");
    }
  });
});

describe("Intro: die Titelkarte springt nicht", () => {
  const players = ["Mia", "Ben", "Lea", "Tom", "Ida"].map((name, index) => player(`p${index + 1}`, name));

  it("lässt die Personen unter der Titelkarte als unsichtbaren Platzhalter stehen", () => {
    const html = render(IntroOverlay, { players, phaseStartedAt: NOW - 3_400, round: 1 });
    expect(html).toContain("Runde 1");
    const peopleBlock = /<div aria-hidden="true"[^>]*class="col-start-1 row-start-1[^"]*"/.exec(html);
    expect(peopleBlock).not.toBeNull();
    expect(html).toContain('aria-label="Mia"');
  });

  it("zeigt vorher die Personen ohne Titelkarte", () => {
    const html = render(IntroOverlay, { players, phaseStartedAt: NOW - 1_000, round: 1 });
    expect(html).not.toContain("Runde 1");
    expect(html).not.toMatch(/<div aria-hidden="true"[^>]*class="col-start-1 row-start-1/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Frage → Auflösung (ADR-034): Karte und Antworten stehen still
// ---------------------------------------------------------------------------------------------------

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "wbr",
]);

/** Minimaler Parser für das (wohlgeformte) Markup von renderToStaticMarkup. */
function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, closing, tag = "", rawAttrs = "", selfClosing, text] = match;
    const parent = stack.at(-1) ?? root;
    if (text !== undefined) {
      parent.children.push(text);
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[attr[1] ?? ""] = attr[2] ?? "";
    const node: HtmlNode = { tag: tag.toLowerCase(), attrs, children: [] };
    parent.children.push(node);
    if (!selfClosing && !VOID_TAGS.has(node.tag)) stack.push(node);
  }
  return root;
}

function findNode(node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    if (typeof child === "string") continue;
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

const elements = (node: HtmlNode) => node.children.filter((child): child is HtmlNode => typeof child !== "string");

/**
 * Klassen, die Lage und Größe bestimmen (Box-Modell, Fluss, Schriftstil); Farben, Zustände, Übergänge und
 * Rundungen zählen nicht.
 */
const LAYOUT_CLASS =
  /^(?:-?m[trblxy]?-|-?p[trblxy]?-|(?:min-|max-)?[hw]-|size-|gap-|flex|grid$|block$|inline|hidden$|items-|justify-|self-|grow|shrink|absolute$|relative$|fixed$|sticky$|sr-only$|overflow-|hyphens-|wrap-|whitespace-|border(?:-[0-9])?$|text-(?:display|wordmark|h1|h2|code|title|question|question-long|answer|button|body|label|caption)$)/;

const layoutClasses = (node: HtmlNode) =>
  (node.attrs.class ?? "").split(/\s+/).filter((token) => LAYOUT_CLASS.test(token));

/**
 * Lage-Signatur eines Teilbaums: Tag + Layout-Klassen der Elemente im Fluss. Aus dem Fluss genommen sind
 * `hidden`, `sr-only` und `absolute` (TimerBar, Avatare an den Antworten); Kästen fester Größe (`size-*`: Buchstabe,
 * Icon-Slot) zählen ohne Inhalt; Icons mit ihrer Größe; klassenlose Hüllen um genau ein Element (motion-Wrapper)
 * sind durchsichtig. `skipChildrenOf` lässt den Inhalt einzelner Elemente (der Statuszeile) aus.
 */
function layoutSignature(node: HtmlNode | string, skipChildrenOf?: (node: HtmlNode) => boolean): string | null {
  if (typeof node === "string") return null;
  if (node.tag === "svg") return `svg(${node.attrs.width}x${node.attrs.height})`;
  if ("hidden" in node.attrs) return null;
  const classes = layoutClasses(node);
  if (classes.includes("sr-only") || classes.includes("absolute")) return null;
  const kids = elements(node);
  if (node.tag === "div" && classes.length === 0 && kids.length === 1 && kids[0]) {
    return layoutSignature(kids[0], skipChildrenOf);
  }
  const fixedBox = classes.some((token) => token.startsWith("size-"));
  const inner =
    fixedBox || skipChildrenOf?.(node)
      ? []
      : node.children
          .map((child) => layoutSignature(child, skipChildrenOf))
          .filter((part): part is string => part !== null);
  return `${node.tag}${classes.map((token) => `.${token}`).join("")}${inner.length > 0 ? `[${inner.join(" ")}]` : ""}`;
}

/** Inhalt des Overlays (Kinder der inneren Spalte von OverlayFrame) und die Statuszeile. */
function stageContent(html: string, testId: string) {
  const root = parseHtml(html);
  const section = findNode(root, (node) => node.attrs["data-testid"] === testId);
  const column = section ? elements(section)[0] : undefined;
  if (!section || !column) throw new Error(`${testId} fehlt`);
  const isStatus = (node: HtmlNode) => (node.attrs.class ?? "").includes("min-h-4") && node.tag === "p";
  const children = elements(column);
  return {
    section,
    column,
    children,
    status: children.find(isStatus),
    signature: children.map((child) => layoutSignature(child, isStatus)).filter((part) => part !== null),
  };
}

describe("Frage → Auflösung: Karte und Antworten stehen still (ADR-034)", () => {
  const mia = player("p1", "Mia");
  const ben = player("p2", "Ben");
  const LONG_PROMPT =
    `${"Welche der vier Antworten passt am besten zu dieser Frage aus dem Katalog, ".repeat(2)}`.slice(0, 140);
  const LONG_ANSWERS: [string, string, string, string] = [
    "Richtig ist die längste mögliche Antwort",
    "Eher eine Antwort mit vierzig Buchstaben",
    "Kaum eine Antwort aus dem Jahr 1999 hier",
    "Die Schifffahrtsgesellschaft aus Hamburg",
  ];
  const base: PublicQuestion = {
    id: "q2x7k2m9p4",
    index: 2,
    total: 3,
    categoryId: "buecher-woerter",
    prompt: LONG_PROMPT,
    answers: LONG_ANSWERS,
    media: null,
    startsAt: NOW - 21_000,
    deadline: NOW - 1_000,
    answeredBy: [],
  };
  const question = (props: { myChoice: 0 | 1 | 2 | 3 | null; open: boolean }) =>
    render(QuestionOverlay, {
      question: props.open ? { ...base, startsAt: NOW - 2_000, deadline: NOW + 18_000 } : base,
      myChoice: props.myChoice,
      canAnswer: true,
      waitingCount: 1,
      runId: "q2:0",
      onAnswer: noop,
    });
  const reveal = (picks: Record<string, 0 | 1 | 2 | 3 | null>) =>
    render(AnswerRevealOverlay, {
      question: { ...base, correct: 0, picks },
      players: [mia, ben],
      selfId: "p1",
      phaseStartedAt: NOW - 500,
    });

  const views = {
    "Frage offen": stageContent(question({ myChoice: null, open: true }), "overlay-question"),
    "Frage eingeloggt („Warte auf …“)": stageContent(question({ myChoice: 1, open: true }), "overlay-question"),
    "Frage abgelaufen ohne Antwort": stageContent(question({ myChoice: null, open: false }), "overlay-question"),
    "Auflösung richtig": stageContent(reveal({ p1: 0, p2: 1 }), "overlay-answer-reveal"),
    "Auflösung falsch": stageContent(reveal({ p1: 1, p2: 0 }), "overlay-answer-reveal"),
    "Auflösung ohne eigene Antwort („Zeit abgelaufen“)": stageContent(
      reveal({ p1: null, p2: 0 }),
      "overlay-answer-reveal",
    ),
  };
  const reference = views["Frage offen"];

  it("hat in Frage und Auflösung denselben Aufbau bis zur letzten Antwort – mit und ohne eigene Antwort", () => {
    // Karte (ohne TimerBar, die liegt absolut), Statuszeile, Antwortgruppe mit vier gleich gebauten Antworten
    expect(reference.signature).toHaveLength(3);
    expect(reference.signature[0]).toMatch(/^div\.relative\.overflow-hidden\.border\.p-5\[p\.text-question-long\]$/);
    expect(reference.signature[1]).toBe("p.mt-1.flex.min-h-4.items-center.justify-center.gap-1.text-caption");
    expect(reference.signature[2]?.match(/button\./g)).toHaveLength(4);
    for (const [name, view] of Object.entries(views)) {
      expect(view.signature, name).toEqual(reference.signature);
      // gleicher Rahmen: Kartenoberkante = Innenabstand der Bühne
      expect(view.column.attrs.class, name).toBe(reference.column.attrs.class);
    }
  });

  it("zeigt „Zeit abgelaufen“ (timer 16) in der Statuszeile unter der Karte, nie darüber", () => {
    const missed = views["Auflösung ohne eigene Antwort („Zeit abgelaufen“)"];
    const status = missed.status;
    expect(status).toBeDefined();
    if (!status) return;
    // Im Fluss: Karte, dann die Statuszeile mit dem Hinweis – davor steht nichts Sichtbares mehr (früher: Hinweis
    // über der Karte, Karte und Antworten 32 px tiefer als in der Frage)
    const flow = missed.children.filter((child) => layoutSignature(child) !== null);
    expect(flow.indexOf(status)).toBe(1);
    expect(layoutSignature(flow[0] ?? status)).toMatch(/^div\.relative\.overflow-hidden\.border\.p-5/);
    const hint = findNode(status, (node) => node.attrs["data-testid"] === "reveal-time-up");
    expect(hint && layoutSignature(hint)).toBe("span.flex.items-center.justify-center.gap-1[svg(16x16)]");
    expect(JSON.stringify(status)).toContain("Zeit abgelaufen");
    expect(JSON.stringify(status)).toContain("lucide-timer");
    // Mit eigener Antwort bleibt dieselbe Zeile leer, aber reserviert
    for (const name of ["Auflösung richtig", "Auflösung falsch"] as const) {
      expect(views[name].status?.attrs.class, name).toBe(status.attrs.class);
      expect(elements(views[name].status ?? status), name).toEqual([]);
    }
  });

  it("nutzt in Frage und Auflösung dieselbe Statuszeile (caption, text-2, 16 px reserviert)", () => {
    const waiting = views["Frage eingeloggt („Warte auf …“)"].status;
    expect(waiting?.attrs["data-testid"]).toBe("question-waiting");
    expect(waiting?.attrs["aria-live"]).toBe("polite");
    expect(waiting?.children).toEqual(["Warte auf 1 weitere …"]);
    for (const [name, view] of Object.entries(views)) {
      expect(view.status?.attrs.class, name).toBe(
        "mt-1 flex min-h-4 items-center justify-center gap-1 text-center text-caption text-text-2",
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Zug-Ergebnis (docs/09 §7.7): Sheet unten auf der Bühne
// ---------------------------------------------------------------------------------------------------

describe("Zug-Ergebnis: Sheet fährt von unten hoch (docs/09 §7.7)", () => {
  const mia = player("p1", "Mia");
  const ben = player("p2", "Ben");
  const lea = player("p3", "Lea");
  const summary = summarizeTurn({
    round: 1,
    pickerId: "p2",
    categoryId: "buecher-woerter",
    results: { p1: [true, false, true], p2: [true, true, false], p3: [false, null, false] },
  });
  const category = { name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" };
  const view = (phaseStartedAt: number) =>
    stageContent(
      render(TurnSummaryOverlay, { summary, players: [mia, ben, lea], category, phaseStartedAt }),
      "overlay-turn-summary",
    );

  it("verankert das Sheet unten über dem Spielerstreifen – volle Spaltenbreite, radius-xl oben, Ebene 2", () => {
    const { section, column, children } = view(NOW);
    expect(column.attrs.class).toContain("justify-end");
    expect(column.attrs.class).not.toContain("justify-center");
    expect(column.attrs.class).not.toContain("px-gutter");
    expect(column.attrs.class).not.toMatch(/(?:^|\s)(?:py|pb)-/);
    expect(children).toHaveLength(1);
    const sheet = children[0];
    expect(sheet?.attrs["data-testid"]).toBe("turn-summary-sheet");
    expect(sheet?.attrs.class).toBe(
      "rounded-t-xl border border-b-0 border-line bg-surface-1 px-gutter pt-5 pb-4 shadow-level-2",
    );
    // Der Rahmen selbst blendet nicht ein (keine zweite Bewegung) – nur das Sheet fährt hoch
    expect(section.attrs.style ?? "").not.toContain("opacity:0");
  });

  it("startet zum Phasenbeginn eine Sheet-Höhe tiefer; nach spätem Einstieg steht es schon oben", () => {
    const entering = view(NOW).children[0]?.attrs.style ?? "";
    expect(entering).toContain("translateY(100%)");
    expect(entering).not.toContain("opacity");
    const late = view(NOW - 1_000).children[0]?.attrs.style ?? "";
    expect(late).not.toContain("translateY(100%)");
  });

  it("zeigt Kategorie, Zeilen nach Punkten mit „+2“ und die Besten mit 1 px orangem Rahmen", () => {
    const html = render(TurnSummaryOverlay, { summary, players: [mia, ben, lea], category, phaseStartedAt: NOW });
    expect(html).toMatch(/<h2[^>]*>Bücher &amp; Wörter<\/h2>/);
    const rows = [...html.matchAll(/<li data-testid="turn-summary-row"([^>]*)>([\s\S]*?)<\/li>/g)];
    expect(rows.map((row) => />(Mia|Ben|Lea)</.exec(row[2] ?? "")?.[1])).toEqual(["Mia", "Ben", "Lea"]);
    expect(rows.map((row) => />(\+\d)<\/span><\/span><\/li>$/.exec(`${row[0]}`)?.[1])).toEqual(["+2", "+2", "+0"]);
    for (const [index, row] of rows.entries()) {
      const best = index < 2;
      expect(row[1], `Zeile ${index + 1}`).toContain(best ? "border-primary" : "border-transparent");
      expect(row[1], `Zeile ${index + 1}`).toMatch(/class="[^"]*(?:^|\s)border(?:\s|")/);
    }
  });
});
