/**
 * Begriffs-Matcher der Namens-Moderation. Begriffe tragen optionale Wortgrenzen wie bei `obscenity`:
 * `|wort|` = ganzes Wort, `|wort` = Wortanfang, `wort|` = Wortende, `wort` = überall im Wort.
 *
 * Wiederholungen: Jede Buchstabenfolge des Begriffs muss im Namen mindestens gleich lang vorkommen
 * („nutte“ trifft „Nuttte“, aber nicht „Nutella“; „fick“ trifft „Fiiick“). Whitelist-Wörter heben
 * Treffer auf, die vollständig in ihnen liegen (Scunthorpe-Schutz: „arsch“ in „Marschall“).
 */
import { foldForModeration, type ModerationForm } from "./normalize.ts";

export type TermKind = "any" | "start" | "end" | "whole";

export interface CompiledTerm {
  /** Begriff wie angegeben (für Logs/Tests). */
  readonly source: string;
  readonly kind: TermKind;
  /** Normalisierter Text ohne Grenzmarker. */
  readonly text: string;
  readonly regex: RegExp;
}

/** Überall-Begriffe werden im zusammengezogenen Namen erst ab dieser Länge gesucht (weniger Fehltreffer). */
export const COMPACT_MIN_ANY_LENGTH = 6;
/** Ein Name aus Wörtern bis zu dieser Länge gilt als zerstückelt („Fo tze“) – dann zählen auch kurze Begriffe. */
export const COMPACT_FRAGMENT_MAX_LENGTH = 3;

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** „nutte“ → `n+u+t{2,}e+` (jede Folge mindestens so lang wie im Begriff). */
function runPattern(text: string): string {
  const chars = Array.from(text);
  let pattern = "";
  for (let i = 0; i < chars.length; ) {
    const char = chars[i] ?? "";
    let run = 1;
    while (chars[i + run] === char) run++;
    pattern += escapeRegex(char) + (run === 1 ? "+" : `{${run},}`);
    i += run;
  }
  return pattern;
}

/** Normalisiert Begriffstext wie Namen (ausgeschriebene Umlaute, „1“ = i) und entfernt Trenner. */
export function normalizeTermText(text: string): string {
  return foldForModeration(text, "expand").replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Übersetzt einen Begriff in ein Suchmuster. `shortWholeWordBelow`: Überall-Begriffe mit weniger
 * Zeichen gelten automatisch als ganzes Wort (Schutz gegen zu kurze Live-Ergänzungen).
 */
export function compileTerm(source: string, shortWholeWordBelow = 0): CompiledTerm | null {
  const trimmed = source.trim();
  const startBound = trimmed.startsWith("|");
  const endBound = trimmed.endsWith("|") && trimmed.length > 1;
  const text = normalizeTermText(trimmed.slice(startBound ? 1 : 0, endBound ? -1 : undefined));
  if (text.length === 0) return null;
  let kind: TermKind = startBound ? (endBound ? "whole" : "start") : endBound ? "end" : "any";
  if (kind === "any" && Array.from(text).length < shortWholeWordBelow) kind = "whole";
  const body = runPattern(text);
  const pattern = kind === "whole" ? `^${body}$` : kind === "start" ? `^${body}` : kind === "end" ? `${body}$` : body;
  return { source, kind, text, regex: new RegExp(pattern, "gu") };
}

type Interval = readonly [start: number, end: number];

function findAll(regex: RegExp, value: string): Interval[] {
  const found: Interval[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(value); match !== null; match = regex.exec(value)) {
    found.push([match.index, match.index + match[0].length]);
    regex.lastIndex = match.index + 1;
  }
  return found;
}

/** Liste gesperrter Begriffe mit Whitelist; prüft die Vergleichsformen eines Namens. */
export class TermMatcher {
  readonly terms: readonly CompiledTerm[];
  private readonly whitelist: readonly RegExp[];

  constructor(terms: readonly string[], whitelist: readonly string[] = [], shortWholeWordBelow = 0) {
    this.terms = terms.flatMap((term) => compileTerm(term, shortWholeWordBelow) ?? []);
    this.whitelist = whitelist.flatMap((word) => {
      const text = normalizeTermText(word);
      return text ? [new RegExp(runPattern(text), "gu")] : [];
    });
  }

  /**
   * Erster Begriff, der in einer der Formen trifft (sonst `undefined`). Wortgrenzen-Begriffe gelten nur
   * je Wort; im zusammengezogenen Namen werden nur Überall-Begriffe gesucht – lange (≥ 6 Zeichen) immer,
   * kürzere nur, wenn der Name ganz aus kurzen Stücken besteht („Fo tze“), damit Kombinationen wie
   * „Cumhur E.“ oder „P. Uta“ nicht fälschlich treffen.
   */
  findIn(forms: readonly ModerationForm[]): CompiledTerm | undefined {
    for (const form of forms) {
      const words = [...new Set([...form.tokens, ...form.camelTokens])];
      for (const word of words) {
        const hit = this.findInValue(word, () => true);
        if (hit) return hit;
      }
      if (form.tokens.length > 1) {
        const fragmented = form.tokens.every((token) => Array.from(token).length <= COMPACT_FRAGMENT_MAX_LENGTH);
        const hit = this.findInValue(
          form.compact,
          (term) => term.kind === "any" && (fragmented || term.text.length >= COMPACT_MIN_ANY_LENGTH),
        );
        if (hit) return hit;
      }
    }
    return undefined;
  }

  private findInValue(value: string, applies: (term: CompiledTerm) => boolean): CompiledTerm | undefined {
    let allowed: Interval[] | undefined;
    for (const term of this.terms) {
      if (!applies(term)) continue;
      const hits = findAll(term.regex, value);
      if (hits.length === 0) continue;
      allowed ??= this.whitelist.flatMap((regex) => findAll(regex, value));
      const covered = (hit: Interval) => allowed?.some(([start, end]) => start <= hit[0] && hit[1] <= end) ?? false;
      if (hits.some((hit) => !covered(hit))) return term;
    }
    return undefined;
  }
}
