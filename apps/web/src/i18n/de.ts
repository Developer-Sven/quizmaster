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
const APP_NAME = "quizmaster";

export const de = {
  app: {
    name: APP_NAME,
    claim: "Das Quiz-Duell für deine Runde.",
    /**
     * Seitentitel nach der Vorlage des Layouts („Lobby – quizmaster“), z. B. wenn eine Ansicht die Lobby ersetzt
     * („Du wurdest aus der Lobby entfernt – quizmaster“); ein Schlusspunkt fällt weg.
     */
    pageTitle: (page: string) => `${page.replace(/\.$/, "")} – ${APP_NAME}`,
  },

  /** Beschriftungen von Buttons (docs/09 §11) */
  actions: {
    createLobby: "Lobby erstellen",
    join: "Beitreten",
    startGame: "Spiel starten",
    done: "Fertig",
    reviewQuestions: "Fragen ansehen",
    showResult: "Ergebnis ansehen",
    leaveLobby: "Lobby verlassen",
    toStart: "Zur Startseite",
    retry: "Erneut versuchen",
    update: "Aktualisieren",
    installApp: "Als App installieren",
    back: "Zurück",
    close: "Schließen",
    /** Host schaltet nach Frage, Kategorie oder Zwischenstand weiter (ADR-045) */
    next: "Weiter",
    /** Host löst eine Frage ohne Countdown auf (ADR-049), mit Stand der Antworten */
    revealNow: (answered: number, total: number) => `Auflösen (${answered}/${total} Antworten)`,
    /** Eigenen Namen in der Lobby ändern (ADR-041) */
    rename: "Name ändern",
    save: "Speichern",
  },

  fields: {
    name: "Dein Name",
    lobbyCode: "Lobby-Code",
    /** Kündigt den Auto-Beitritt des CodeInput an (WCAG 3.2.2) – auf der Startseite nur für Screenreader (ADR-043) */
    lobbyCodeHint: "Nach dem 6. Zeichen trittst du automatisch bei.",
  },

  start: {
    or: "oder",
    imprint: "Impressum",
    privacy: "Datenschutz",
    /** Name fehlt beim Erstellen oder Beitreten */
    nameRequired: "Gib deinen Namen ein.",
    /** Enter im Code-Feld mit weniger als 6 Zeichen */
    codeIncomplete: "Gib den ganzen Code ein.",
    /** Status unter dem Code-Feld während des Auto-Beitritts (ADR-039) */
    joining: "Trete bei …",
    scanQr: "QR-Code scannen",
  },

  /** QR-Code einer Lobby mit der Kamera scannen (ADR-039) */
  scan: {
    title: "QR-Code scannen",
    preview: "Kamerabild",
    starting: "Kamera startet …",
    hint: "Halte die Kamera auf den QR-Code der Lobby.",
    foreign: "Dieser QR-Code gehört zu keiner Lobby.",
    denied: "Kein Zugriff auf die Kamera. Erlaube ihn in den Einstellungen des Browsers.",
    noCamera: "Keine Kamera gefunden.",
    unsupported: "Hier lässt sich nicht scannen. Gib den Code ein.",
    failed: "Die Kamera ließ sich nicht starten.",
  },

  lobby: {
    title: "Lobby",
    /** Karte nach einem Spiel: Ergebnis und Fragen des letzten Spiels (ADR-038) */
    lastGame: "Letztes Spiel",
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
    /** Host im Anzeige-Modus (ADR-046) */
    presenting: "zeigt an",
    /** IconButton „Host übertragen“ (ADR-047) */
    makeHost: (name: string) => `${name} zum Host machen`,
    /** Zusatzzeile der Zusammenfassung, nur bei abweichenden Einstellungen (ADR-046/048/049) */
    onlyCategory: (name: string) => `Nur ${name}`,
    categoryCount: (count: number) => `${count} Kategorien`,
    answerTime: (seconds: number) => (seconds === 0 ? "Auflösen per Host" : `${seconds} s pro Frage`),
    hostPresents: (name: string) => `${name} zeigt nur an`,
    /** Schwierigkeit, wenn nicht alle Stufen pro Frage aufsteigend (ADR-055) */
    difficulty: (text: string) => `Schwierigkeit ${text}`,
    copyCode: "Code kopieren",
    shareLink: "Link teilen",
    showQrCode: "QR-Code zeigen",
    hideQrCode: "QR-Code ausblenden",
    qrCodeAlt: "QR-Code zum Beitreten",
    settings: "Einstellungen",
    /** Alle außer dem Host sehen die Einstellungen nur an (ADR-050) */
    viewSettings: "Einstellungen ansehen",
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
    /** Zeit pro Frage (ADR-049) sowie Weiter nach Frage, Kategorie und Zwischenstand (ADR-045) */
    advanceTitle: "Zeit und Weiter",
    answerTime: "Zeit pro Frage",
    afterQuestion: "Nach jeder Frage",
    afterTurn: "Nach jeder Kategorie",
    afterRound: "Nach dem Zwischenstand",
    /** Wert im Stepper: Sekunden bzw. „Host“ (Host tippt „Weiter“) */
    advanceValue: (seconds: number) => (seconds === 0 ? "Host" : `${seconds} s`),
    advanceHint: "„Host“: Es geht erst weiter, wenn du auf „Auflösen“ bzw. „Weiter“ tippst.",
    /** Kategorien begrenzen (ADR-048) */
    categories: "Kategorien",
    categoriesTitle: "Kategorien",
    categoriesAll: "Alle Kategorien",
    categoriesAllShort: "Alle",
    categoriesCount: (count: number) => `${count} ausgewählt`,
    categoriesHint: "Bei einer Kategorie entfällt die Wahl, bei zwei oder drei stehen alle zur Wahl.",
    /** Anzeige-Modus (ADR-046) */
    hostTitle: "Du als Host",
    hostPlays: "Du spielst mit",
    hostPresents: "Du zeigst nur an (großer Bildschirm)",
    /** Nur lesbare Ansicht für alle außer dem Host (ADR-050) */
    readOnlyHint: (host: string) => `Nur ${host} kann die Einstellungen ändern.`,
    hostTitleOther: "Host",
    hostPlaysOther: (host: string) => `${host} spielt mit`,
    hostPresentsOther: (host: string) => `${host} zeigt nur an (großer Bildschirm)`,
    advanceHintOther: "„Host“: Es geht erst weiter, wenn der Host auf „Auflösen“ bzw. „Weiter“ tippt.",
    /** Schwierigkeit (ADR-055): Unteransicht wie „Kategorien“ */
    difficulty: "Schwierigkeit",
    difficultyTitle: "Schwierigkeit",
    difficultyMin: "Von Stufe",
    difficultyMax: "Bis Stufe",
    difficultyScale: "Stufe 1 = sehr leicht, Stufe 5 = sehr schwer.",
    difficultyBasisTitle: "Stufe wechselt",
    difficultyBases: { question: "Pro Frage", category: "Pro Kategorie" },
    difficultyBasisHints: {
      question: "Jede Frage hat ihre eigene Stufe.",
      category: "Alle Fragen einer Kategorie haben dieselbe Stufe.",
    },
    difficultyOrderTitle: "Reihenfolge",
    difficultyOrders: { ascending: "Aufsteigend", random: "Zufällig" },
    difficultyOrderHints: {
      question: {
        ascending: "In jeder Kategorie von leicht nach schwer.",
        random: "Jede Frage zufällig – mal leicht, mal schwer.",
      },
      category: {
        ascending: "Von Kategorie zu Kategorie schwerer.",
        random: "Jede Kategorie bekommt eine zufällige Stufe.",
      },
    },
    /** Kurzform für Zeile und Lobby, z. B. „1–5, pro Frage aufsteigend“ */
    difficultyModes: {
      question: { ascending: "pro Frage aufsteigend", random: "pro Frage zufällig" },
      category: { ascending: "pro Kategorie aufsteigend", random: "pro Kategorie zufällig" },
    },
    difficultyRange: (min: number, max: number, mode: string) => `${min}–${max}, ${mode}`,
    difficultyOnly: (level: number) => `nur Stufe ${level}`,
    /** Vorschau unter den Optionen – zeigt, was tatsächlich passiert */
    difficultyPreviewQuestion: (levels: string) => `So läuft jede Kategorie: Stufe ${levels}`,
    difficultyPreviewCategory: (levels: string) => `Kategorien nacheinander: Stufe ${levels}`,
    difficultyPreviewQuestionRandom: (min: number, max: number) =>
      `Jede Frage bekommt zufällig eine Stufe von ${min} bis ${max}.`,
    difficultyPreviewCategoryRandom: (min: number, max: number) =>
      `Jede Kategorie bekommt zufällig eine Stufe von ${min} bis ${max}.`,
    difficultyPreviewOnly: (level: number) => `Alle Fragen haben Stufe ${level}.`,
  },

  /** Vorschläge für die Einstellungen (ADR-053) */
  suggestions: {
    /** Abschnitt „Vorschläge“ im Einstellungen-Sheet des Hosts */
    toggleTitle: "Vorschläge",
    allow: "Alle dürfen Änderungen vorschlagen",
    deny: "Nur du änderst die Einstellungen",
    /** Sheet der anderen, solange Vorschläge erlaubt sind */
    intro: (host: string) => `Deine Änderungen gehen als Vorschlag an ${host}.`,
    pendingIntro: (host: string) => `Dein Vorschlag liegt bei ${host}. Neu senden ersetzt ihn.`,
    send: "Vorschlag senden",
    replace: "Vorschlag ersetzen",
    sent: "Vorschlag gesendet.",
    notPossible: "Vorschlag nicht möglich. Sieh dir den aktuellen Stand an.",
    /** Eigener offener Vorschlag in der Lobby */
    waiting: (host: string) => `Dein Vorschlag liegt bei ${host}.`,
    withdraw: "Zurückziehen",
    /** Lobby des Hosts: Liste offener Vorschläge */
    title: "Vorschläge",
    from: (name: string) => `Von ${name}`,
    /** Prüfen-Sheet des Hosts */
    reviewTitle: (name: string) => `Vorschlag von ${name}`,
    reviewIntro: (name: string) => `Orange ist, was ${name} ändern möchte. Du kannst noch anpassen.`,
    accept: "Übernehmen",
    decline: "Ablehnen",
    accepted: "Vorschlag übernommen.",
    declined: "Vorschlag abgelehnt.",
    stale: "Der Vorschlag ist nicht mehr offen.",
    /** Unter einem geänderten Wert */
    currently: (value: string) => `Aktuell: ${value}`,
    hostPlaysValue: "spielt mit",
    hostPresentsValue: "zeigt nur an",
  },

  game: {
    /** HUD-Fortschritt, z. B. „Runde 2/3 · Zug 3/4“ */
    progress: (round: number, rounds: number, turn: number, turns: number) =>
      `Runde ${round}/${rounds} · Zug ${turn}/${turns}`,
    resign: "Aufgeben",
    /** Host beendet das Spiel für alle (ADR-051) */
    endGame: "Spiel beenden",
    soundOn: "Ton an",
    soundOff: "Ton aus",
    versus: "VS",
    roundTitle: (round: number) => `Runde ${round}`,
    pickSelf: "Wähle eine Kategorie",
    pickOther: (name: string) => `${name} wählt eine Kategorie`,
    /** Unter der Reveal-Kachel, z. B. „3 Fragen · gewählt von Mia“ */
    revealSubtitle: (questions: number, name: string) =>
      `${questions} ${plural(questions, "Frage", "Fragen")} · gewählt von ${name}`,
    /** Nur eine Kategorie erlaubt (ADR-048) – niemand hat gewählt */
    revealSubtitleFixed: (questions: number) =>
      `${questions} ${plural(questions, "Frage", "Fragen")} · feste Kategorie`,
    questionProgress: (index: number, total: number) => `Frage ${index}/${total}`,
    /** Überschrift (nur Screenreader) über Frage und Auflösung, zugleich Beschreibung der Antwortgruppe */
    questionHeading: (index: number, total: number) => `Frage ${index} von ${total}`,
    /** Hauptüberschrift des Spielscreens (nur Screenreader), z. B. „Runde 2 von 3, Zug 3 von 4“ */
    screenHeading: (round: number, rounds: number, turn: number, turns: number) =>
      `Runde ${round} von ${rounds}, Zug ${turn} von ${turns}`,
    /** Hauptüberschrift des Spielscreens am Spielende (nur Screenreader) */
    gameOverHeading: "Spiel beendet",
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
    /** Gleichbleibender Name des Ton-Umschalters im HUD; an/aus trägt der Schalter-Zustand (`aria-checked`) */
    sound: "Ton",
    /** Name der Bühne, solange sie selbst scrollt und dafür per Tab erreichbar ist (WCAG 2.1.1) */
    stage: "Spielfläche",
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
    /** Titel des Ergebnis-Sheets in der Lobby (Karte „Letztes Spiel“, ADR-038) */
    title: "Ergebnis",
    /** Spielende: danach automatisch zurück in die Lobby (ADR-038) */
    backToLobbySoon: "Gleich geht es zurück in die Lobby …",
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
    /** Host beendet das Spiel vorzeitig (ADR-051) */
    endGame: {
      title: "Spiel für alle beenden?",
      description: "Alle sehen das Ergebnis mit dem aktuellen Stand, danach geht es zurück in die Lobby.",
      confirm: "Beenden",
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
    /** Host übertragen (ADR-047) */
    transferHost: {
      title: (name: string) => `${name} zum Host machen?`,
      description: (name: string) => `${name} stellt dann ein und startet das Spiel.`,
      confirm: "Übertragen",
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
    unavailable: "Die Fragen dieses Spiels sind nicht mehr abrufbar.",
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
    /** Anleitung, wo der Browser nicht selbst installiert (ADR-054) */
    installTitle: "App installieren",
    installAfter: "Danach startest du quizmaster vom Startbildschirm – wie jede App, ohne Adressleiste.",
    installSteps: {
      iosShareSafari: "Tippe auf „Teilen“ – unten in der Leiste, im neuen Safari erst auf „…“.",
      iosShareChrome: "Tippe oben in der Adresszeile auf „Teilen“.",
      iosShareFirefox: "Öffne das Menü und tippe auf „Teilen“.",
      iosShareOther: "Tippe auf „Teilen“ – in der Adresszeile oder im Menü des Browsers.",
      iosAdd: "Wähle „Zum Home-Bildschirm“ – eventuell weiter unten in der Liste.",
      iosConfirm: "Tippe oben rechts auf „Hinzufügen“.",
      androidMenu: "Öffne das Menü des Browsers (⋮ oben rechts).",
      androidMenuFirefox: "Öffne das Menü des Browsers (⋮).",
      androidMenuSamsung: "Öffne das Menü des Browsers (≡ unten rechts).",
      androidAdd: "Tippe auf „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.",
      androidAddFirefox: "Tippe auf „Installieren“ bzw. „Zum Startbildschirm hinzufügen“.",
      androidAddSamsung: "Tippe auf „Seite hinzufügen zu“ und dann auf „Startbildschirm“.",
      androidConfirm: "Bestätige mit „Installieren“ bzw. „Hinzufügen“.",
    },
    updateAvailable: "Neue Version verfügbar",
    update: "Aktualisieren",
    offline: "Du bist offline.",
    /** Web-App-Manifest (docs/10): Name, Beschreibung, Screenshot-Beschriftungen, Kurzbefehle */
    manifest: {
      name: "quizmaster – Das Live-Quiz",
      description: "Quiz-Duelle live mit Freund:innen – ohne Anmeldung.",
      screenshotLobby: "Lobby mit Code",
      screenshotQuestion: "Frage mit Timer",
      shortcutCreate: "Lobby erstellen",
      shortcutJoin: "Lobby beitreten",
    },
  },

  maintenance: {
    fallback: MAINTENANCE_FALLBACK,
    /** Text aus `appConfig.maintenance.message`, sonst der Standardtext (docs/09 §11) */
    message: (text?: string | null) => text?.trim() || MAINTENANCE_FALLBACK,
  },

  /**
   * Cloudflare Turnstile (docs/06 §Bot-Schutz): Läuft die Prüfung unsichtbar, gibt es keinen Text (docs/09 §11
   * TURNSTILE_REQUIRED); sichtbar wird nur die Überschrift, wenn Cloudflare eine Bestätigung verlangt, und der
   * Fehlerfall.
   */
  turnstile: {
    label: "Kurze Sicherheitsprüfung",
    failed: "Sicherheitsprüfung fehlgeschlagen. Versuch es noch mal.",
    retry: "Erneut versuchen",
  },

  /** Hinweise per Toast (docs/09 §7.10) und Server-Notices (docs/05) */
  notices: {
    hostChanged: (name: string) => `${name} ist jetzt Host.`,
    playerResigned: (name: string) => `${name} hat aufgegeben.`,
    serverRestart: "Neustart – gleich geht es weiter.",
    gameEnded: "Der Host hat das Spiel beendet.",
    /** Vorschläge (ADR-053) */
    suggestionReceived: (name: string) => `${name} hat einen Vorschlag gemacht.`,
    suggestionAccepted: (host: string) => `${host} hat deinen Vorschlag übernommen.`,
    suggestionDeclined: (host: string) => `${host} hat deinen Vorschlag abgelehnt.`,
    suggestionsOff: "Vorschläge sind jetzt aus.",
  },

  pages: {
    notFound: "Seite nicht gefunden.",
  },

  /**
   * Regeln-Seite `/regeln` und der Link „Regeln“ in der Fußzeile (docs/09 §6: höchstens 6 kurze Punkte;
   * Inhalt nach docs/01 – nur, was es gibt, keine Extras). Zahl und Einheit mit geschütztem Leerzeichen
   * (`\u00a0`), damit „20 Sekunden“ nie über zwei Zeilen bricht.
   */
  rules: {
    title: "Regeln",
    points: [
      "2 bis 8\u00a0Personen spielen in einer Lobby. Der Host stellt Runden und Fragen pro Kategorie ein und startet das Spiel.",
      "Die Reihenfolge wird ausgelost. In jeder Runde wählt jede Person einmal eine von 3\u00a0Kategorien.",
      "Alle beantworten gleichzeitig dieselben Fragen: 4\u00a0Antworten, genau eine ist richtig, 20\u00a0Sekunden Zeit.",
      "Du hast pro Frage eine Antwort und kannst sie nicht ändern. Ohne Antwort zählt die Frage als falsch.",
      "Jede richtige Antwort bringt 1\u00a0Punkt – Tempo zählt nicht. Gleich viele Punkte bedeuten den gleichen Platz.",
      "Wer das Spiel verlässt oder zu lange getrennt ist, gilt als aufgegeben und landet hinter allen, die zu Ende spielen.",
    ] as const,
    /** Nur für Screenreader, hinter „Regeln“: Der Link öffnet einen neuen Tab (Lobby, Spielende) */
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
    /** Platzwechsel mit Person (Duell-Tafel), z. B. „Mia: Platz verbessert“ */
    rankUpOf: (name: string) => `${name}: Platz verbessert`,
    rankDownOf: (name: string) => `${name}: Platz verschlechtert`,
    /** Gesamtstand im Duell für Screenreader (sichtbar „8 : 11“), z. B. „Mia: 8 Punkte, Ben: 11 Punkte“ */
    duelScore: (left: string, leftScore: number, right: string, rightScore: number) =>
      `${left}: ${leftScore} ${plural(leftScore, "Punkt", "Punkte")}, ${right}: ${rightScore} ${plural(rightScore, "Punkt", "Punkte")}`,
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
    /** Spielende mit dem eigenen Ergebnis, z. B. „Spiel beendet. Gewonnen.“ */
    gameEnded: (headline: string) => `Spiel beendet. ${headline}.`,
    connectionLost: "Verbindung unterbrochen",
    /** Lobby: Beitritt bzw. Austritt (auch Entfernen) einer anderen Person – nur Screenreader */
    playerJoined: (name: string) => `${name} ist beigetreten.`,
    playerLeft: (name: string) => `${name} hat die Lobby verlassen.`,
    /** höflich, kurz nach der Rückkehr (das Overlay blendet still aus, docs/09 §7.10) */
    connectionRestored: "Verbindung wiederhergestellt",
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
