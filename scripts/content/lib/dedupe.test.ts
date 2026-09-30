import type { CategorySlug, QuestionFileEntry } from "@quizmaster/shared/content";
import { describe, expect, it } from "vitest";
import { findDuplicates } from "./dedupe.ts";
import type { LoadedQuestion } from "./load.ts";
import { trigrams } from "./text.ts";

let counter = 0;
function q(
  category: CategorySlug,
  prompt: string,
  answer: string,
  extra: Partial<QuestionFileEntry> = {},
): LoadedQuestion {
  counter += 1;
  const prefix = category === "comics" ? "co" : category === "kinofilme" ? "kf" : "rw";
  return {
    category,
    topic: "grundlagen",
    file: `questions/${category}/grundlagen.json`,
    line: counter,
    entry: {
      id: `${prefix}-${String(counter).padStart(8, "0")}`,
      difficulty: 2,
      prompt,
      answers: [answer, "Falsch 1", "Falsch 2", "Falsch 3"],
      status: "unverified",
      ...extra,
    },
  };
}

describe("content:dedupe", () => {
  it("erkennt exakt, ähnlich, gleichen Fakt und umgedrehte Paare", () => {
    const questions = [
      q("comics", "Wie heißt der Hund von Tim?", "Struppi"),
      q("kinofilme", "Wie heißt der Hund von Tim?", "Struppi"),
      q("comics", "Welche Farbe hat der Umhang von Superman?", "Rot"),
      q("comics", "Welche Farbe hat der Umhang von Supermann?", "Rot"),
      q("comics", "In welchem Jahr erschien das erste Heft der Reihe X?", "1938"),
      q("kinofilme", "In welchem Jahr kam das erste Heft der Reihe X heraus?", "1938"),
      q("rund-um-die-welt", "Was ist die Hauptstadt von Frankreich?", "Paris"),
      q("rund-um-die-welt", "Von welchem Land ist Paris die Hauptstadt?", "Frankreich"),
      q("rund-um-die-welt", "Zu welchem Land gehört diese Flagge?", "Japan", { media: { kind: "flag", code: "jp" } }),
      q("rund-um-die-welt", "Zu welchem Land gehört diese Flagge?", "Brasilien", {
        media: { kind: "flag", code: "br" },
      }),
      q("rund-um-die-welt", "Wessen Flagge ist das?", "Japan", { media: { kind: "flag", code: "jp" } }),
      q("comics", "Welches Tier ist Snoopy?", "Hund"),
    ];
    const result = findDuplicates(questions);
    const kinds = result.pairs.map((pair) => `${pair.kind}:${pair.a.entry.answers[0]}`);
    expect(kinds).toContain("exact:Struppi");
    expect(kinds).toContain("similar:Rot");
    expect(kinds).toContain("same_fact:1938");
    expect(kinds).toContain("reversed:Paris");
    expect(kinds).toContain("same_fact:Japan");
    // Gleiche generische Flaggen-Frage mit verschiedenen Flaggen ist KEINE Dublette.
    expect(
      result.pairs.some((pair) => pair.a.entry.answers[0] === "Brasilien" || pair.b.entry.answers[0] === "Brasilien"),
    ).toBe(false);
    expect(result.counts.exact).toEqual({ within: 0, across: 1 });
    const onlyKinofilme = findDuplicates(questions, { category: "kinofilme" });
    expect(
      onlyKinofilme.pairs.every((pair) => pair.a.category === "kinofilme" || pair.b.category === "kinofilme"),
    ).toBe(true);
  });

  it("findet mit dem Präfix-Filter exakt dieselben ähnlichen Paare wie der Vollvergleich", () => {
    // Deterministische Pseudo-Zufallsfragen mit vielen Beinahe-Dubletten.
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const words = [
      "welche",
      "stadt",
      "land",
      "farbe",
      "jahr",
      "heißt",
      "erfand",
      "gewann",
      "spielt",
      "liegt",
      "am",
      "im",
      "der",
      "die",
      "das",
      "berg",
      "fluss",
      "film",
      "held",
      "maler",
    ];
    const base = Array.from({ length: 60 }, () =>
      Array.from({ length: 5 + Math.floor(random() * 5) }, () => words[Math.floor(random() * words.length)]).join(" "),
    );
    const prompts: string[] = [];
    for (const sentence of base) {
      prompts.push(`${sentence}?`);
      const variants = Math.floor(random() * 4);
      for (let v = 0; v < variants; v++) {
        const chars = [...sentence];
        const position = Math.floor(random() * chars.length);
        chars.splice(position, 1, String.fromCharCode(97 + Math.floor(random() * 26)));
        prompts.push(`${chars.join("")}?`);
      }
    }
    const questions = prompts.map((prompt, index) =>
      q(index % 2 === 0 ? "comics" : "kinofilme", prompt, `Antwort ${index}`),
    );
    for (const threshold of [0.8, 0.6]) {
      const found = new Set(
        findDuplicates(questions, { similarThreshold: threshold, sameFactThreshold: 2 })
          .pairs.filter((pair) => pair.kind === "similar" || pair.kind === "exact")
          .map((pair) => [pair.a.entry.id, pair.b.entry.id].sort().join("|")),
      );
      const expected = new Set<string>();
      const sets = questions.map((question) => trigrams(question.entry.prompt));
      for (let i = 0; i < questions.length; i++) {
        for (let j = i + 1; j < questions.length; j++) {
          const a = sets[i] ?? new Set<string>();
          const b = sets[j] ?? new Set<string>();
          let shared = 0;
          for (const gram of a) if (b.has(gram)) shared += 1;
          const similarity = shared / (a.size + b.size - shared);
          if (similarity >= threshold - 1e-9) {
            expected.add([questions[i]?.entry.id, questions[j]?.entry.id].sort().join("|"));
          }
        }
      }
      expect(expected.size).toBeGreaterThan(10);
      expect(found).toEqual(expected);
    }
  });
});
