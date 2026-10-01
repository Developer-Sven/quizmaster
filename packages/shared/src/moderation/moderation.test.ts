import { describe, expect, it } from "vitest";
import { drawLobbyCode, generateLobbyCode } from "../lobby-code.ts";
import {
  checkName,
  EXTRA_TERM_WHOLE_WORD_BELOW,
  findNameViolation,
  GERMAN_BLOCKLIST,
  isCodeAcceptable,
  isNameAcceptable,
  moderationForms,
  NS_NUMBER_CODES,
} from "./index.ts";

/** Übliche Vornamen in Deutschland (alle Generationen, verschiedene Herkunft) – dürfen nie treffen. */
const FIRST_NAMES = `
Mia Emma Hannah Sofia Sophie Emilia Lina Marie Mila Ella Lea Leonie Amelie Clara Luisa Johanna Anna Lena Laura
Lara Frieda Ida Greta Paula Charlotte Maja Nele Emily Lilly Lotta Mathilda Elisa Helena Isabella Pia Jana Julia
Katharina Sarah Lisa Vanessa Jessica Jennifer Nadine Sabrina Stefanie Nicole Melanie Christina Sandra Andrea Claudia
Susanne Petra Sabine Birgit Monika Ursula Renate Gisela Ingrid Helga Karin Brigitte Elke Heike Anja Tanja Katja
Silke Ute Uta Gabriele Martina Kerstin Manuela Simone Nina Miriam Franziska Theresa Carolin Annalena Annika Antonia
Alina Aylin Ayşe Elif Zeynep Fatma Emine Merve Esra Büşra Hatice Selin Defne Leyla Amira Yasmin Samira Nour Aisha
Fatima Mariam Olga Natalia Natascha Anastasia Swetlana Tatjana Ewa Agnieszka Katarzyna Magdalena Joanna Giulia
Chiara Francesca Ioanna Eleni Linh Thao Huong Mai Ngoc Bich Chantal Jacqueline Mandy Peggy Cindy Doreen Ronja Finja
Merle Thea Nora Mira Luna Elena Marlene Hedwig Gertrud Irmgard Waltraud Rosemarie Hildegard Annemarie Hannelore
Lieselotte Annalisa Analena Anke Svenja Wiebke Imke Frauke Maren Doris Bettina Corinna Dagmar Jutta Regina Sigrid
Tamara Verena Yvonne Zoe Rebecca Josephine Henriette Valentina Viktoria Luise Lucia Tessa Wilma Zara Noah Leon Paul
Ben Finn Elias Felix Henry Louis Jonas Emil Theo Anton Matteo Liam Lukas Luca Maximilian Max Moritz Jakob David
Oskar Julian Leo Niklas Tim Tom Jan Jannik Fabian Florian Tobias Sebastian Alexander Christian Daniel Dennis Thomas
Michael Andreas Stefan Markus Martin Matthias Frank Jürgen Uwe Klaus Wolfgang Peter Hans Günter Horst Dieter Manfred
Helmut Werner Gerhard Heinz Walter Karl Karl-Heinz Heinrich Friedrich Wilhelm Hermann Rolf Bernd Jörg Ralf Holger
Sven Torsten Dirk Kai Lars Jens Björn Nils Ole Hauke Henning Arne Malte Sönke Timo Philipp Benedikt Benjamin Dominik
Kevin Marvin Justin Pascal Patrick Robin Marco Mario Marcel Sascha Oliver Simon Johannes Jonathan Joshua Konstantin
Vincent Valentin Raphael Samuel Aaron Adrian Dustin Mike Nico Ronny Maik Enrico Steffen Carsten Hendrik Erik Ludwig
Otto Fritz Kurt Erwin Rudolf Alfred Arthur Hugo Kilian Lasse Linus Mats Mika Rasmus Titus Magnus Marius Darius Silas
Mehmet Mustafa Ahmet Ali Hasan Hüseyin Ibrahim Ismail Yusuf Murat Emre Burak Can Cem Deniz Kerem Kaan Mert Onur
Serkan Volkan Cumali Cuma Cumhur Fuat Oguz Tarkan Emin Kemal Osman Ömer Omar Mohammed Muhammad Karim Tarek Nazim Nazir
Nazira Samir Amir Yasin Bilal Hamza Hussein Dmitri Sergej Wladimir Alexej Nikolai Piotr Krzysztof Tomasz Pawel Marek
Jakub Igor Oleg Dragan Goran Zoran Giuseppe Giovanni Francesco Alessandro Lorenzo Antonio Dimitrios Georgios Nikos
Jose Juan Carlos Miguel Pablo Diego Nguyen Tran Minh Duc Hung Tuan Quang Long Phuc Hieu Kim Wei Chen Hiroshi Kenji
Yuki Georgy Kassandra Cassandra Thure
`
  .split(/\s+/)
  .filter(Boolean);

/** Scunthorpe-Fälle: harmlose Wörter/Namen, die gesperrte Begriffe enthalten. */
const SCUNTHORPE = [
  "Jess",
  "Ross",
  "Hesse",
  "Rossmann",
  "Bossmann",
  "Marschall",
  "Barsch",
  "Harsch",
  "Warschau",
  "Marschner",
  "Barschel",
  "Schurek",
  "Assmann",
  "Assel",
  "Kanal",
  "Analyse",
  "Schweinsteiger",
  "Passau",
  "Nassau",
  "Dickmann",
  "Wankel",
  "Scunthorpe",
  "Arsenal",
  "Fagott",
  "Fickert",
  "Mongolei",
  "Churer",
  "Moses",
  "Mose",
  "Möser",
  "Klitschko",
  "Titanic",
  "Therapist",
  "Cocktail",
  "Sussex",
  "Essex",
  "Shitake",
  "Spaßtiger",
  "Spaßvogel",
  "Klassenarbeit",
  "Ambassador",
  "Hodenberg",
  "Minute",
  "Nutella",
  "Penne",
  "Vergaser",
  "Sporn",
  "Hitzig",
  "Milford",
  "Uranus",
  "Dickens",
];

/** Namen mit Initialen, Zahlen und Nachnamen (Kombinationen, die Fehltreffer provozieren könnten). */
const COMBINATIONS = [
  "Anna L",
  "AnnaL",
  "JanaL",
  "SwetlanaL",
  "Anna123",
  "Jana123",
  "Cumhur E.",
  "P. Uta",
  "TranY",
  "HiroshiT",
  "JörgY",
  "ArthurE",
  "Max1988",
  "Marc18",
  // Angehängte Zahlen (z. B. Geburtsjahr „88“) allein sperren nicht – nur eindeutige NS-Codes (siehe BLOCKED).
  "Lisa88",
  "Tom 88",
  "Tom88",
  "Mia 88",
  "A 88",
  "88 Max",
  "Noah 88",
  "Jess88",
  "Siegfried 88",
  "Heiko88",
  "Tom HH",
  "Olaf Otzen",
  "Arthur Ehlers",
  "Anna Zimmer",
  "Johanna Lang",
  "Lisa M.",
  "xXLeonXx",
  "MIA",
  "tom_k",
  "Ben 2",
];

/** Gesperrte Namen je Kategorie – inklusive Umgehungsversuchen. */
const BLOCKED = {
  insults: ["Hurensohn", "Wichser", "Fotze", "Arschloch", "Schlampe", "Missgeburt", "Spast", "Drecksau", "Hundesohn"],
  sexual: ["Pimmel", "Muschi", "Möse", "Titten", "Sperma", "Vergewaltiger", "Pädophil", "Kinderficker", "Nutte"],
  discrimination: ["Neger", "Kanake", "Zigeuner", "Schlitzauge", "Polacke", "Schwuchtel", "Untermensch", "Judensau"],
  nazi: [
    "Hitler",
    "Adolf Hitler",
    "Sieg Heil",
    "Heil Hitler",
    "Nazi",
    "Neonazi",
    "NSDAP",
    "Hakenkreuz",
    "Zyklon B",
    "SS",
    "S.S.",
    "SS Mann",
    "SS-Mann",
    "SS-Männer",
    "Gaskammer",
  ],
  numberCodes: [
    // „88“ bzw. „HH“ als ganzer Name (auch mit Trennzeichen)
    "88",
    "8 8",
    "88.88",
    "HH",
    "H.H.",
    "h-h",
    // eindeutige Codes überall im Namen
    "1488",
    "14 88",
    "Tom1488",
    "HH88",
    "88HH",
    "TomHH88",
    "C18",
    "C 18",
    "Combat 18",
    // Zahl + NS-Kürzel bzw. -Begriff
    "AH 88",
    "AH18",
    "Adolf 88",
    "Adolf88",
    "SS88",
    "88 SS",
    "Sieg 88",
    "Heil88",
    "Hitler 88",
    "Nazi88",
  ],
  leetspeak: ["Hurens0hn", "W1chser", "F0tze", "4rschl0ch", "N3ger", "H1tler", "Sp4st1", "5chlampe", "@rschloch"],
  umlauts: ["Mißgeburt", "Krüppel", "Kruppel", "Hürensohn", "Scheiße", "Scheisse", "Kümmeltürke"],
  separators: ["H.u.r.e.n.s.o.h.n", "F i c k e r", "Hu-Re", "Sa U", "Fo tze", "N_a_z_i", "S-p-a-s-t"],
  repetitions: ["Hurrrensohn", "Fiiicker", "Nuttte", "Arschhhloch", "Wiiichser"],
  camelCase: ["DummeSau", "DuArschloch", "MaxArsch", "HitlerFan", "SpasTi", "WichSer", "ScheiSSe", "HurE"],
  confusables: ["Нurensohn", "Fоtze", "Nаzi"],
  english: ["Fuck", "Fück", "fUcK", "F.u.c.k", "FuckYou", "Shit", "Bitch", "B1tch", "Cunt", "Nigger", "Asshole"],
  otherLanguages: ["Kurwa", "Amk", "Orospu", "Siktir", "Blyat", "Cazzo", "Puta", "Vaffanculo", "Sharmuta"],
} as const;

describe("Blockliste (ADR-021)", () => {
  it("ist sinnvoll umfangreich und syntaktisch sauber", () => {
    expect(GERMAN_BLOCKLIST.length).toBeGreaterThan(200);
    expect(new Set(GERMAN_BLOCKLIST).size).toBe(GERMAN_BLOCKLIST.length);
    for (const term of GERMAN_BLOCKLIST) expect(term, term).toMatch(/^\|?[a-z]+\|?$/);
  });

  it("NS-Codes sind reine Kleinbuchstaben/Ziffern (sie werden in Suchmuster eingesetzt)", () => {
    const { wholeName, contains, wholeWords, comboWords, comboNumbers } = NS_NUMBER_CODES;
    for (const code of [...wholeName, ...contains, ...wholeWords, ...comboWords, ...comboNumbers]) {
      expect(code, code).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe("isNameAcceptable – keine Fehltreffer", () => {
  it("lässt übliche Vornamen zu", () => {
    expect(FIRST_NAMES.length).toBeGreaterThan(400);
    const blocked = FIRST_NAMES.filter((name) => !isNameAcceptable(name));
    expect(blocked).toEqual([]);
  });

  it("lässt Scunthorpe-Fälle zu", () => {
    expect(SCUNTHORPE.filter((name) => !isNameAcceptable(name))).toEqual([]);
  });

  it("lässt Kombinationen mit Initialen, Nachnamen und Zahlen zu", () => {
    expect(COMBINATIONS.filter((name) => !isNameAcceptable(name))).toEqual([]);
  });
});

describe("isNameAcceptable – Treffer", () => {
  it.each(Object.entries(BLOCKED))("sperrt %s", (_category, names) => {
    expect(names.filter((name) => isNameAcceptable(name))).toEqual([]);
  });

  it("meldet die Quelle des Treffers", () => {
    expect(findNameViolation("Hurensohn")).toBe("german");
    expect(findNameViolation("Fuck")).toBe("english");
    expect(findNameViolation("88")).toBe("number_code");
    expect(findNameViolation("Adolf 88")).toBe("number_code");
    expect(findNameViolation("Tom 88")).toBeNull();
    expect(findNameViolation("Mia")).toBeNull();
  });
});

describe("Live-Ergänzungen (appConfig.blockedTerms)", () => {
  it("sperrt zusätzliche Begriffe – auch mit Leetspeak und Trennzeichen", () => {
    expect(isNameAcceptable("Blubberkopf")).toBe(true);
    expect(isNameAcceptable("Blubberkopf", ["blubber"])).toBe(false);
    expect(isNameAcceptable("BLUBB3R", ["blubber"])).toBe(false);
    expect(isNameAcceptable("B-l-u-b-b-e-r", ["blubber"])).toBe(false);
    expect(findNameViolation("Mia Blubber", ["blubber"])).toBe("extra");
  });

  it("wertet kurze Begriffe als ganzes Wort und versteht Wortgrenzen", () => {
    expect(EXTRA_TERM_WHOLE_WORD_BELOW).toBe(4);
    expect(isNameAcceptable("Box", ["ox"])).toBe(true);
    expect(isNameAcceptable("Ox", ["ox"])).toBe(false);
    expect(isNameAcceptable("Troll", ["|troll|"])).toBe(false);
    expect(isNameAcceptable("Trollinger", ["|troll|"])).toBe(true);
    expect(isNameAcceptable("Trollinger", ["|troll"])).toBe(false);
    expect(isNameAcceptable("Mia", ["", "  ", "|"])).toBe(true);
  });

  it("übernimmt geänderte Listen sofort (Cache je Liste)", () => {
    expect(isNameAcceptable("Keks", ["keks"])).toBe(false);
    expect(isNameAcceptable("Keks", ["kuchen"])).toBe(true);
    expect(isNameAcceptable("Keks")).toBe(true);
  });
});

describe("checkName (lobby:create/join → NAME_REJECTED)", () => {
  it("liefert den normalisierten Namen", () => {
    expect(checkName("  Mia   Sophie ")).toEqual({ ok: true, name: "Mia Sophie" });
  });

  it("unterscheidet Format, reservierte Namen und Blocklisten", () => {
    expect(checkName("M")).toEqual({ ok: false, reason: "format", detail: "too_short" });
    expect(checkName("Mia 😀")).toEqual({ ok: false, reason: "format", detail: "invalid_characters" });
    expect(checkName("Admin")).toEqual({ ok: false, reason: "reserved" });
    expect(checkName("Wichser")).toEqual({ ok: false, reason: "blocked", source: "german" });
    expect(checkName("Keks", ["keks"])).toEqual({ ok: false, reason: "blocked", source: "extra" });
  });
});

describe("isCodeAcceptable", () => {
  it("sperrt Codes mit Schimpfwörtern und NS-Bezügen, auch in Leetspeak", () => {
    for (const code of ["FUCKAB", "SEX234", "5EX234", "NEGER2", "HURE23", "KZ2345", "SS2345", "ARSCH2", "abc-88x"]) {
      expect(isCodeAcceptable(code), code).toBe(false);
    }
  });

  it("lässt unauffällige Codes zu und verwirft nur wenige Zufallscodes", async () => {
    for (const code of ["ABC234", "XYZ789", "HJM3NP"]) expect(isCodeAcceptable(code), code).toBe(true);
    let seed = 42;
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    let rejected = 0;
    for (let i = 0; i < 2_000; i++) if (!isCodeAcceptable(drawLobbyCode(random))) rejected++;
    expect(rejected / 2_000).toBeLessThan(0.1);
    const code = await generateLobbyCode(random, () => false, { isAcceptable: isCodeAcceptable });
    expect(code === null ? false : isCodeAcceptable(code)).toBe(true);
  });
});

describe("Normalisierung", () => {
  it("prüft Umlaute ausgeschrieben und entfernt sowie „1“ als i und l", () => {
    const forms = moderationForms("Hüre1");
    const tokens = forms.flatMap((form) => form.tokens);
    expect(tokens).toEqual(expect.arrayContaining(["huerei", "hurei", "huerel", "hurel"]));
  });
});
