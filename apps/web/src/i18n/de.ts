import type { ErrorCode, KickReason, ReportReason } from "@quizmaster/shared";

/**
 * Alle UI-Texte (docs/09 §11): Du-Form, kurz, sachlich, freundlich. Keine Emojis, keine
 * Ausrufezeichen, keine Floskeln. Platzhalter (Namen, Zahlen) sind Funktionsparameter.
 * `message` vom Server wird nie angezeigt – Fehlercodes laufen über {@link errorPresentation}.
 */

function plural(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}

/** Kategorienamen für Screenreader: „Bücher & Wörter“ → „Bücher und Wörter“ (docs/09 §7). */
export function spokenCategoryName(name: string): string {
  return name.replaceAll("&", "und").replace(/\s+/g, " ").trim();
}

const MAINTENANCE_FALLBACK = "Wartung – gleich geht es weiter.";

export const de = {
  app: {
    name: "quizmaster",
    claim: "Das Quiz-Duell für deine Runde.",
  },

  /** Beschriftungen von Buttons (docs/09 §11) */
  actions: {
    createLobby: "Lobby erstellen",
    join: "Beitreten",
    startGame: "Spiel starten",
    done: "Fertig",
    rematch: "Revanche",
    reviewQuestions: "Fragen ansehen",
    leaveLobby: "Lobby verlassen",
    toStart: "Zur Startseite",
    retry: "Erneut versuchen",
    update: "Aktualisieren",
    installApp: "Als App installieren",
    back: "Zurück",
    close: "Schließen",
  },

  fields: {
    name: "Dein Name",
    lobbyCode: "Lobby-Code",
    /** Kündigt den Auto-Beitritt des CodeInput an (WCAG 3.2.2) – die eine Hilfezeile der Startseite */
    lobbyCodeHint: "Nach dem 6. Zeichen trittst du automatisch bei.",
  },

  start: {
    or: "oder",
    rules: "Regeln",
    imprint: "Impressum",
    privacy: "Datenschutz",
    /** Name fehlt beim Erstellen oder Beitreten */
    nameRequired: "Gib deinen Namen ein.",
    /** „Beitreten“ mit weniger als 6 Zeichen */
    codeIncomplete: "Gib den ganzen Code ein.",
  },

  lobby: {
    title: "Lobby",
    players: (count: number, max: number) => `Spieler ${count}/${max}`,
    waitingFor: (name: string) => `Warte auf ${name} …`,
    /** Zusammenfassung der Einstellungen, z. B. „3 Runden · 3 Fragen je Kat.“ */
    settingsSummary: (rounds: number, questionsPerCategory: number) =>
      `${rounds} ${plural(rounds, "Runde", "Runden")} · ${questionsPerCategory} ${plural(questionsPerCategory, "Frage", "Fragen")} je Kat.`,
    /** Gesamtfragen und geschätzte Dauer, z. B. „27 Fragen · ca. 9 Min.“ */
    durationSummary: (questions: number, minutes: number) =>
      `${questions} ${plural(questions, "Frage", "Fragen")} · ca. ${minutes} Min.`,
    host: "Host",
    offline: "offline",
    copyCode: "Code kopieren",
    shareLink: "Link teilen",
    showQrCode: "QR-Code zeigen",
    hideQrCode: "QR-Code ausblenden",
    qrCodeAlt: "QR-Code zum Beitreten",
    settings: "Einstellungen",
    kick: (name: string) => `${name} entfernen`,
    codeCopied: "Code kopiert.",
    linkCopied: "Link kopiert.",
    copyFailed: "Kopieren nicht möglich.",
    /** Text beim Teilen des Einladungslinks (Web Share API) */
    inviteText: (formattedCode: string) => `Tritt meiner Lobby bei: ${formattedCode}`,
    /** Nur mit DEV_BOTS_ENABLED (docs/05 §Dev-Bots) */
    addBot: "Bot hinzufügen",
  },

  settings: {
    title: "Einstellungen",
    rounds: "Runden",
    questionsPerCategory: "Fragen pro Kategorie",
    maxPlayers: "Personen maximal",
    decrease: (label: string) => `${label} verringern`,
    increase: (label: string) => `${label} erhöhen`,
  },

  game: {
    /** HUD-Fortschritt, z. B. „Runde 2/3 · Zug 3/4“ */
    progress: (round: number, rounds: number, turn: number, turns: number) =>
      `Runde ${round}/${rounds} · Zug ${turn}/${turns}`,
    resign: "Aufgeben",
    soundOn: "Ton an",
    soundOff: "Ton aus",
    versus: "VS",
    roundTitle: (round: number) => `Runde ${round}`,
    pickSelf: "Wähle eine Kategorie",
    pickOther: (name: string) => `${name} wählt eine Kategorie`,
    /** Unter der Reveal-Kachel, z. B. „3 Fragen · gewählt von Mia“ */
    revealSubtitle: (questions: number, name: string) =>
      `${questions} ${plural(questions, "Frage", "Fragen")} · gewählt von ${name}`,
    questionProgress: (index: number, total: number) => `Frage ${index}/${total}`,
    /** Kurzform im Kategoriestreifen, z. B. „1/3“ */
    fraction: (index: number, total: number) => `${index}/${total}`,
    waitingForOthers: (count: number) => `Warte auf ${count} weitere …`,
    timeUp: "Zeit abgelaufen",
    flagAlt: "Flagge",
    answerLetters: ["A", "B", "C", "D"] as const,
    /** Weitere Avatare an einer Antwort, z. B. „+3“ */
    moreAvatars: (count: number) => `+${count}`,
    /** Punkte eines Zuges bzw. einer Auflösung, z. B. „+2“ */
    pointsGained: (points: number) => `+${points}`,
    roundBoardTitle: (round: number, rounds: number) => `Runde ${round} von ${rounds}`,
    /** Gesamtstand im Duell, z. B. „5 : 4“ */
    duelScore: (left: number, right: number) => `${left} : ${right}`,
    /** Kategorie ohne bekannte Darstellung (z. B. nach einem Neuladen mitten im Spiel) */
    unknownCategory: "Kategorie",
    /** Toast: Die getippte Antwort kam (Verbindung weg) nie beim Server an – die Frage läuft aber noch */
    answerNotReceived: "Deine Antwort kam nicht an. Tippe noch einmal.",
  },

  result: {
    won: "Gewonnen",
    lost: "Verloren",
    draw: "Unentschieden",
    playerWins: (name: string) => `${name} gewinnt`,
    place: (place: number) => `Platz ${place}`,
    resigned: "Aufgegeben",
    history: "Spielverlauf",
    podium: "Podest",
    ranking: "Rangliste",
    points: (points: number) => `${points} ${plural(points, "Punkt", "Punkte")}`,
  },

  dialogs: {
    resign: {
      title: "Spiel verlassen?",
      description: "Du giltst dann als aufgegeben.",
      confirm: "Verlassen",
      cancel: "Weiterspielen",
    },
    leaveLobby: {
      title: "Lobby verlassen?",
      confirm: "Verlassen",
      cancel: "Bleiben",
    },
    /** Host entfernt eine Person aus der Lobby */
    kick: {
      title: (name: string) => `${name} entfernen?`,
      description: (name: string) => `${name} kann dieser Lobby nicht wieder beitreten.`,
      confirm: "Entfernen",
      cancel: "Abbrechen",
    },
  },

  connection: {
    lost: "Verbindung unterbrochen",
  },

  review: {
    title: "Fragen ansehen",
    rateUp: "Gute Frage",
    rateDown: "Schlechte Frage",
    report: "Frage melden",
    reported: "Bereits gemeldet",
    correctAnswer: "Richtige Antwort",
    yourAnswer: "Deine Antwort",
    empty: "Noch keine Fragen gespielt.",
  },

  report: {
    title: "Frage melden",
    reasons: {
      falsch: "Falsch",
      mehrdeutig: "Mehrdeutig",
      veraltet: "Veraltet",
      tippfehler: "Tippfehler",
      unpassend: "Unpassend",
    } satisfies Record<ReportReason, string>,
    thanks: "Danke, wir prüfen die Frage.",
  },

  pwa: {
    install: "Als App installieren",
    /** iOS-Anleitungs-Sheet (docs/10): „Teilen“ → „Zum Home-Bildschirm“ */
    iosInstallTitle: "Als App installieren",
    iosInstallShare: "Tippe auf „Teilen“.",
    iosInstallHomeScreen: "Wähle „Zum Home-Bildschirm“.",
    updateAvailable: "Neue Version verfügbar",
    update: "Aktualisieren",
    offline: "Du bist offline.",
  },

  maintenance: {
    fallback: MAINTENANCE_FALLBACK,
    /** Text aus `appConfig.maintenance.message`, sonst der Standardtext (docs/09 §11) */
    message: (text?: string | null) => text?.trim() || MAINTENANCE_FALLBACK,
  },

  /** Hinweise per Toast (docs/09 §7.10) und Server-Notices (docs/05) */
  notices: {
    hostChanged: (name: string) => `${name} ist jetzt Host.`,
    playerResigned: (name: string) => `${name} hat aufgegeben.`,
    serverRestart: "Neustart – gleich geht es weiter.",
  },

  pages: {
    notFound: "Seite nicht gefunden.",
  },

  /** Texte nur für Screenreader und Bedienhilfen */
  a11y: {
    loading: "Lädt …",
    selected: "ausgewählt",
    timer: "Verbleibende Zeit",
    secondsLeft: (seconds: number) => `Noch ${seconds} ${plural(seconds, "Sekunde", "Sekunden")}`,
    answerLocked: "eingeloggt",
    answerCorrect: "richtig",
    answerWrong: "falsch",
    pickedBy: (names: readonly string[]) => `gewählt von ${names.join(", ")}`,
    resultCorrect: "richtig",
    resultWrong: "falsch",
    resultOpen: "offen",
    resultNone: "keine Antwort",
    statusHost: "Host",
    statusOffline: "offline",
    statusAnswered: "hat geantwortet",
    statusResigned: "aufgegeben",
    statusWinner: "Sieger:in",
    rankUp: "Platz verbessert",
    rankDown: "Platz verschlechtert",
    boardCaption: "Spieltafel",
    boardCategory: "Kategorie",
    boardTotal: "Summe",
    placeColumn: "Platz",
    pointsColumn: "Punkte",
    /** Name des Spielerstreifens im Spiel */
    playerStrip: "Spielstand",
  },

  /** Ansagen der `aria-live`-Region im HUD (docs/09 §7 „Screenreader“) */
  announcements: {
    roundPick: (round: number, rounds: number, name: string) =>
      `Runde ${round} von ${rounds}. ${name} wählt eine Kategorie.`,
    /** wenn die eigene Person wählt */
    roundPickSelf: (round: number, rounds: number) => `Runde ${round} von ${rounds}. Wähle eine Kategorie.`,
    categoryQuestion: (category: string, index: number, total: number) =>
      `${spokenCategoryName(category)}. Frage ${index} von ${total}.`,
    correct: "Richtig. Plus 1 Punkt.",
    wrong: (correctAnswer: string) => `Falsch. Richtig war: ${correctAnswer}.`,
    roundEnded: (round: number, place: number) => `Runde ${round} beendet. Du bist auf Platz ${place}.`,
    connectionLost: "Verbindung unterbrochen",
  },
};

export type Messages = typeof de;

/**
 * Darstellung eines Fehlercodes (docs/09 §11, Codes aus docs/05) – jeder Code hat genau eine:
 * - `message`: Text anzeigen (inline unter dem Feld, als Toast oder EmptyState – je nach Screen)
 * - `update`: `Banner` „Neue Version verfügbar“ mit „Aktualisieren“
 * - `reauth`: still neu anmelden (Session + Ticket); scheitert das, `fallback` anzeigen
 * - `turnstile`: kein Text – Turnstile läuft, danach automatischer zweiter Versuch (docs/06)
 * - `resync`: kein Text – die Oberfläche verhindert den Fall; still per `lobby:resume` synchronisieren
 */
export type ErrorPresentation =
  | { kind: "message"; text: string }
  | { kind: "update" }
  | { kind: "reauth"; fallback: string }
  | { kind: "turnstile" }
  | { kind: "resync" };

const SOMETHING_WENT_WRONG = "Da ist etwas schiefgelaufen. Versuch es noch mal.";

/** Genau eine Darstellung je Code aus @quizmaster/shared (der Typ erzwingt Vollständigkeit). */
export const errorPresentations = {
  LOBBY_NOT_FOUND: { kind: "message", text: "Lobby nicht gefunden." },
  LOBBY_FULL: { kind: "message", text: "Die Lobby ist voll." },
  GAME_IN_PROGRESS: { kind: "message", text: "Das Spiel läuft bereits." },
  NAME_REJECTED: { kind: "message", text: "Name nicht erlaubt." },
  NOT_ENOUGH_PLAYERS: { kind: "message", text: "Mindestens 2 Personen nötig." },
  RATE_LIMITED: { kind: "message", text: "Zu viele Versuche. Warte kurz." },
  SERVER_BUSY: { kind: "message", text: "Gerade ist viel los. Versuch es gleich noch mal." },
  TOO_MANY_CONNECTIONS: { kind: "message", text: "Zu viele offene Verbindungen. Schließ andere Tabs." },
  KICKED: { kind: "message", text: "Du wurdest aus der Lobby entfernt." },
  BANNED: { kind: "message", text: "Du bist vorübergehend gesperrt." },
  RESIGNED: { kind: "message", text: "Du hast dieses Spiel verlassen." },
  LOBBY_CREATION_DISABLED: { kind: "message", text: "Neue Lobbys sind gerade pausiert." },
  UPDATE_REQUIRED: { kind: "update" },
  UNAUTHORIZED: { kind: "reauth", fallback: "Sitzung abgelaufen. Lade die Seite neu." },
  TURNSTILE_REQUIRED: { kind: "turnstile" },
  VALIDATION_FAILED: { kind: "message", text: SOMETHING_WENT_WRONG },
  INTERNAL: { kind: "message", text: SOMETHING_WENT_WRONG },
  NOT_HOST: { kind: "resync" },
  NOT_YOUR_TURN: { kind: "resync" },
  INVALID_OPTION: { kind: "resync" },
  INVALID_PHASE: { kind: "resync" },
  ALREADY_ANSWERED: { kind: "resync" },
  TOO_EARLY: { kind: "resync" },
  TOO_LATE: { kind: "resync" },
} as const satisfies Record<ErrorCode, ErrorPresentation>;

/** Darstellung zu einem Code aus einer Server-Antwort; unbekannte Codes gelten als `INTERNAL`. */
export function errorPresentation(code: string): ErrorPresentation {
  return Object.hasOwn(errorPresentations, code) ? errorPresentations[code as ErrorCode] : errorPresentations.INTERNAL;
}

/** Anzeigetext zu einem Code oder `null`, wenn der Code still behandelt wird (update, reauth, turnstile, resync). */
export function errorMessage(code: string): string | null {
  const presentation = errorPresentation(code);
  return presentation.kind === "message" ? presentation.text : null;
}

/** Hinweis für `kicked { reason }` (docs/05). */
export function kickedMessage(reason: KickReason): string {
  if (reason === "abuse") return errorPresentations.BANNED.text;
  if (reason === "inactive") return "Du wurdest wegen Inaktivität entfernt.";
  return errorPresentations.KICKED.text;
}
