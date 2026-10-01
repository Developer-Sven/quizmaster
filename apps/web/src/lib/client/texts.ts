/**
 * Zusätzliche UI-Texte des Web-Clients, die (noch) nicht in `i18n/de.ts` stehen. Gleiche Regeln wie
 * dort (docs/09 §11): Du-Form, kurz, sachlich, keine Ausrufezeichen, keine Emojis. Sollen bei der
 * nächsten Änderung am Designsystem nach `de.ts` umziehen (gemeldet als Root-Änderung).
 */
export const clientTexts = {
  start: {
    /** Name fehlt beim Erstellen oder Beitreten */
    nameRequired: "Gib deinen Namen ein.",
    /** „Beitreten“ mit weniger als 6 Zeichen */
    codeIncomplete: "Gib den ganzen Code ein.",
  },
  lobby: {
    codeCopied: "Code kopiert.",
    linkCopied: "Link kopiert.",
    copyFailed: "Kopieren nicht möglich.",
    /** Text beim Teilen des Einladungslinks (Web Share API) */
    inviteText: (formattedCode: string) => `Tritt meiner Lobby bei: ${formattedCode}`,
    kickTitle: (name: string) => `${name} entfernen?`,
    kickDescription: (name: string) => `${name} kann dieser Lobby nicht wieder beitreten.`,
    kickConfirm: "Entfernen",
    cancel: "Abbrechen",
    /** Nur mit DEV_BOTS_ENABLED (docs/05 §Dev-Bots) */
    addBot: "Bot hinzufügen",
  },
  game: {
    /** Ansage, wenn die eigene Person wählt (docs/09 §7 „Screenreader“) */
    roundPickSelf: (round: number, rounds: number) => `Runde ${round} von ${rounds}. Wähle eine Kategorie.`,
    /** Name des Spielerstreifens für Screenreader */
    playerStrip: "Spielstand",
    /** Kategorie ohne bekannte Darstellung (z. B. nach einem Neuladen mitten im Spiel) */
    unknownCategory: "Kategorie",
  },
  review: {
    empty: "Noch keine Fragen gespielt.",
  },
} as const;
