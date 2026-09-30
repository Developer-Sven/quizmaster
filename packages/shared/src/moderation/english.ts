/**
 * Englisches Schimpfwort-Dataset von `obscenity` (MIT) mit den empfohlenen Transformern (Verwechsler,
 * Leetspeak, Groß/Klein, Wiederholungen), angepasst an deutsche Namen:
 * - Die „<Buchstabe>anal“-Muster (janal, lanal, sanal …) treffen deutsche/slawische Namen mit
 *   angehängter Initiale („JanaL“, „SwetlanaL“). Die Phrase „anal“ wird deshalb nur mit `|anal`
 *   (Wortanfang) übernommen; deutsche Komposita stehen in der eigenen Blockliste.
 * - Eine Whitelist schützt deutsche Namen/Wörter („Annalena“, „Cumali“, „Kanal“, „Assmann“ …).
 */
import {
  DataSet,
  type EnglishProfaneWord,
  englishDataset,
  englishRecommendedTransformers,
  pattern,
  RegExpMatcher,
} from "obscenity";
import { ENGLISH_DATASET_WHITELIST_DE } from "./blocklist-de.ts";

/** Whitelist der Original-Phrase „anal“ für das verbleibende Muster `|anal`. */
const ANAL_PREFIX_WHITELIST = ["analabos", "analagous", "analav", "analy", "analog"];

let matcher: RegExpMatcher | undefined;

/** Lazy erzeugt (einmal pro Prozess). */
export function englishMatcher(): RegExpMatcher {
  if (!matcher) {
    const dataset = new DataSet<{ originalWord: EnglishProfaneWord }>()
      .addAll(englishDataset)
      .removePhrasesIf((phrase) => phrase.metadata?.originalWord === "anal")
      .addPhrase((phrase) => {
        phrase.setMetadata({ originalWord: "anal" }).addPattern(pattern`|anal`);
        for (const term of ANAL_PREFIX_WHITELIST) phrase.addWhitelistedTerm(term);
        return phrase;
      });
    const { blacklistedTerms, whitelistedTerms = [] } = dataset.build();
    matcher = new RegExpMatcher({
      blacklistedTerms,
      whitelistedTerms: [...whitelistedTerms, ...ENGLISH_DATASET_WHITELIST_DE],
      ...englishRecommendedTransformers,
    });
  }
  return matcher;
}

/** true, wenn einer der Texte einen englischen Begriff enthält. */
export function matchesEnglish(inputs: Iterable<string>): boolean {
  const instance = englishMatcher();
  for (const input of inputs) {
    if (input && instance.hasMatch(input)) return true;
  }
  return false;
}
