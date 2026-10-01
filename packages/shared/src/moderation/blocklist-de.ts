/**
 * Eigene Blockliste für Spielernamen (ADR-021: liegt im Code, live ergänzbar über
 * `appConfig.blockedTerms`). Ergänzt das englische `obscenity`-Dataset um deutsche Schimpfwörter und
 * Beleidigungen, sexuelle Begriffe, rassistische/diskriminierende Begriffe, NS-Bezüge und verbreitete
 * Beleidigungen aus anderen Sprachen, die auf deutschen Schulhöfen üblich sind.
 *
 * Syntax (siehe terms.ts): `|wort|` ganzes Wort · `|wort` Wortanfang · `wort|` Wortende · `wort` überall.
 * Schreibweise: Kleinbuchstaben, Umlaute ausgeschrieben (ae/oe/ue/ss). Leetspeak, Trennzeichen und
 * Wiederholungen deckt die Normalisierung ab; Varianten ohne Umlaut stehen zusätzlich in der Liste.
 */

/** Beleidigungen und Schimpfwörter. */
const INSULTS = [
  "arsch",
  "dummarsch",
  "hurensohn",
  "|hure",
  "hure|",
  "hurenbock",
  "wichser",
  "wixer",
  "wichsa",
  "|wichs",
  "fotze",
  "votze",
  "fotzn",
  "schlampe",
  "nutte",
  "missgeburt",
  "mistgeburt",
  "spast",
  "spacko",
  "spacken",
  "|mongo|",
  "|mongos|",
  "mongoloid",
  "behindert",
  "behindi",
  "krueppel",
  "kruppel",
  "idiot",
  "trottel",
  "|depp|",
  "|deppen|",
  "dummkopf",
  "dumpfbacke",
  "hohlbirne",
  "hohlkopf",
  "vollpfosten",
  "schwachkopf",
  "schwachmat",
  "mistkerl",
  "|honk|",
  "|opfer|",
  "|opfa|",
  "penner",
  "hackfresse",
  "|fresse|",
  "fick",
  "|fck",
  "verpiss",
  "pisser",
  "|kack",
  "kacke",
  "scheisse",
  "|scheis",
  "drecksau",
  "dummesau",
  "|sau|",
  "|schwein|",
  "dreckschwein",
  "schweinehund",
  "hundesohn",
  "|assi|",
  "|assis|",
  "asozial",
  "flittchen",
  "|abschaum|",
  "deinemutter",
  "leckmich",
  "verreck",
  "|kys|",
  "killyourself",
] as const;

/** Sexuelle Begriffe. */
const SEXUAL = [
  "pimmel",
  "|schwanz",
  "schwanzlutscher",
  "muschi",
  "|moese|",
  "moese|",
  "titten",
  "|bumsen",
  "|bumser",
  "sperma",
  "analsex",
  "analverkehr",
  "vergewaltig",
  "kinderschaender",
  "kinderschander",
  "paedophil",
  "padophil",
  "pedophil",
  "|paedo",
  "inzest",
  "sodomie",
  "nekrophil",
  "zoophil",
  "notgeil",
  "|milf",
  "sexsklav",
] as const;

/** Rassistische und diskriminierende Begriffe. */
const DISCRIMINATION = [
  "neger",
  "kanake",
  "kanacke",
  "zigeuner",
  "bimbo",
  "schlitzauge",
  "kuemmeltuerke",
  "kummelturke",
  "polacke",
  "|itaker|",
  "|muselman",
  "kopftuchmaedchen",
  "kopftuchmadchen",
  "tuerkensau",
  "turkensau",
  "judensau",
  "saujude",
  "judenschwein",
  "drecksjude",
  "judenpack",
  "judenraus",
  "auslaenderraus",
  "auslanderraus",
  "tuerkenraus",
  "turkenraus",
  "untermensch",
  "herrenrasse",
  "rassenschande",
  "schwuchtel",
  "|tunte",
  "|homo|",
  "|homos|",
  "|transe|",
  "|transen|",
  "kampflesbe",
  "|kkk|",
] as const;

/** NS-Bezüge (Zahlencodes wie 88/1488 prüft `NS_NUMBER_CODES`). */
const NAZI = [
  "hitler",
  "siegheil",
  "|nazi",
  "nazi|",
  "neonazi",
  "nsdap",
  "gestapo",
  "waffenss",
  // „SS“ nur als ganzes Wort („SS“, „S.S.“, „SS Mann“) bzw. als Wortanfang zusammengeschrieben („SS-Mann“) –
  // nicht in „Jess“, „Ross“ oder „Assmann“.
  "|ss|",
  "|ssmann",
  "|ssmaenner",
  "|ssmanner",
  "gaskammer",
  "auschwitz",
  "holocaust",
  "kristallnacht",
  "endloesung",
  "endlosung",
  "vergasen",
  "vergast",
  "vergasung",
  "judenstern",
  "hakenkreuz",
  "swastika",
  "|fuehrer|",
  "|fuhrer|",
  "reichsfuehrer",
  "reichsfuhrer",
  "himmler",
  "goebbels",
  "heydrich",
  "mengele",
  "whitepower",
  "whitepride",
  "bloodandhonour",
  "bloodandhonor",
  "|wpww|",
  "rassenkrieg",
  "rahowa",
  "zyklonb",
] as const;

/** Verbreitete Beleidigungen aus anderen Sprachen (Türkisch, Arabisch, Slawisch, Romanisch). */
const OTHER_LANGUAGES = [
  "|amk|",
  "aminakoy",
  "orospu",
  "siktir",
  "sikerim",
  "yarrak",
  "kahpe",
  "|ibne|",
  "pezevenk",
  "sharmuta",
  "charmuta",
  "sharmouta",
  "blyat",
  "bljad",
  "blyad",
  "|suka|",
  "|pidor",
  "pidaras",
  "kurwa",
  "pierdol",
  "jebac",
  "jebem",
  "pizda",
  "kurac",
  "vaffanculo",
  "stronzo",
  "puttana",
  "cazzo",
  "|puta|",
  "hijodeputa",
  "cabron",
  "pendejo",
  "maricon",
  "salope",
  "connard",
  "encule",
  "putain",
] as const;

/** Die vollständige eigene Blockliste. */
export const GERMAN_BLOCKLIST: readonly string[] = [
  ...INSULTS,
  ...SEXUAL,
  ...DISCRIMINATION,
  ...NAZI,
  ...OTHER_LANGUAGES,
];

/**
 * Scunthorpe-Schutz: Treffer, die vollständig in diesen Wörtern liegen, zählen nicht
 * („Marschall“, „Warschau“, „Thure“, „Nazim“, „Spaßtiger“ …).
 */
export const GERMAN_WHITELIST: readonly string[] = [
  "marsch",
  "barsch",
  "harsch",
  "warschau",
  "karsch",
  "thure",
  "schure",
  "fickert",
  "fickenscher",
  "nazim",
  "nazir",
  "nazif",
  "naziha",
  "nazira",
  "nazife",
  "spasst",
  "milford",
];

/**
 * NS-Codes, ohne Leetspeak geprüft (Ziffern bleiben erhalten). Eine angehängte Zahl allein sperrt nicht
 * („Lisa88“, „Tom 88“, „Max1988“ – z. B. ein Geburtsjahr), gesperrt werden nur eindeutige Codes:
 * - `wholeName`: der ganze Name besteht nur aus dem Code, Trennzeichen zählen nicht („88“, „8 8“, „H.H.“);
 * - `contains`: irgendwo im zusammengezogenen Namen („1488“, „Tom1488“, „HH 88“, „Sieg 88“);
 * - `wholeWords`: als eigenes Wort („C18“, „C 18“ – aber nicht „Marc18“);
 * - `comboWords` × `comboNumbers`: NS-Kürzel bzw. -Begriff direkt vor oder hinter der Zahl, zusammen-
 *   oder getrennt geschrieben („Adolf 88“, „AH18“, „88 SS“ – aber nicht „Noah 88“, „Jess88“).
 */
export const NS_NUMBER_CODES: {
  readonly wholeName: readonly string[];
  readonly contains: readonly string[];
  readonly wholeWords: readonly string[];
  readonly comboWords: readonly string[];
  readonly comboNumbers: readonly string[];
} = {
  wholeName: ["88", "hh"],
  contains: ["1488", "hh88", "88hh", "sieg88", "heil88", "combat18"],
  wholeWords: ["c18"],
  comboWords: ["adolf", "ah", "hh", "ss", "sieg", "heil"],
  comboNumbers: ["88", "18"],
};

/**
 * Deutsche Namen und Wörter, die das englische `obscenity`-Dataset fälschlich trifft („Annalena“ →
 * „anal“, „Cumali“ → „cum“, „Kanal“, „Assmann“ …). Schreibweise wie die Whitelist-Transformer von
 * obscenity sie sehen (klein, Doppelbuchstaben außer b/e/o/l/s/g zusammengezogen) plus Originalform.
 */
export const ENGLISH_DATASET_WHITELIST_DE: readonly string[] = [
  "annalena",
  "analena",
  "annalisa",
  "analisa",
  "annalina",
  "analina",
  "cuma",
  "cumali",
  "cumhur",
  "bich",
  "georgy",
  "assmann",
  "assman",
  "assel",
  "sporn",
  "kanal",
  "dickmann",
  "dickman",
  "wankel",
  "fagott",
  "fagot",
];
