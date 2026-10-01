/**
 * Kleine, fehlertolerante Hülle um `localStorage` (docs/09 §6 Name vorbefüllen, §10 Ton-Einstellung).
 * Im privaten Modus, bei vollem Speicher oder auf dem Server ist der Speicher nicht nutzbar – dann gelten
 * die Standardwerte und die App funktioniert ohne Merker weiter. Nie Geheimnisse ablegen.
 */

const KEYS = {
  name: "qm.name",
  sound: "qm.sound",
  membership: "qm.lobby",
  categories: "qm.categories",
  session: "qm.session",
  /** Nur kurz beschrieben, um die Schreibbarkeit zu prüfen (`isKnownNonMember`). */
  probe: "qm.probe",
} as const;

let warned = false;

/** Meldet einen nicht nutzbaren Speicher einmal pro Sitzung (ohne Inhalte). */
function reportStorageProblem(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn("Lokaler Speicher nicht verfügbar:", error instanceof Error ? error.name : "unbekannt");
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch (error) {
    reportStorageProblem(error);
    return null;
  }
}

function read(key: string): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch (error) {
    reportStorageProblem(error);
    return null;
  }
}

function write(key: string, value: string | null): void {
  const store = storage();
  if (!store) return;
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch (error) {
    reportStorageProblem(error);
  }
}

/** Obergrenze für gespeicherte Namen (entspricht NAME_INPUT_MAX_LENGTH, Prüfung macht der Server). */
const NAME_STORE_MAX = 64;

/** Zuletzt benutzter Name (leer, wenn keiner gespeichert ist). */
export function readStoredName(): string {
  const value = read(KEYS.name);
  return typeof value === "string" ? value.slice(0, NAME_STORE_MAX) : "";
}

export function writeStoredName(name: string): void {
  const trimmed = name.trim().slice(0, NAME_STORE_MAX);
  write(KEYS.name, trimmed === "" ? null : trimmed);
}

/** Ton an/aus (docs/09 §10: Standard an). */
export function readStoredSoundOn(): boolean {
  return read(KEYS.sound) !== "off";
}

export function writeStoredSoundOn(on: boolean): void {
  write(KEYS.sound, on ? "on" : "off");
}

/**
 * Letzte Lobby, der diese Person beigetreten ist (Code). Unterscheidet beim direkten Aufruf von
 * `/lobby/<code>` ein Mitglied (Wiederaufnahme scheitert → Hinweis) von einem Link-Empfänger
 * (→ Beitreten-Seite).
 */
export function readMembership(): string | null {
  return read(KEYS.membership);
}

export function writeMembership(code: string | null): void {
  write(KEYS.membership, code);
}

/**
 * Lässt sich der Speicher lesen UND beschreiben? Manche Browser (privater Modus, volles Kontingent, gesperrte
 * Website-Daten) liefern beim Lesen nur `null`, während jedes Schreiben scheitert – „nichts gespeichert“ hieße
 * dann nichts. Die Probe hinterlässt keinen Eintrag.
 */
function writable(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(KEYS.probe, "1");
    store.removeItem(KEYS.probe);
    return true;
  } catch (error) {
    reportStorageProblem(error);
    return false;
  }
}

/**
 * Sicher kein Mitglied der Lobby `code`: Der Speicher funktioniert und merkt sich keine Mitgliedschaft für diesen
 * Code (nie beigetreten, verlassen, entfernt oder inzwischen in einer anderen Lobby). Dann führt `/lobby/<code>`
 * sofort zur Beitreten-Seite – ohne Lobby-App und ohne Verbindung (Erstaufruf eines geteilten Lobby-Links, docs/07
 * LCP). Ist ein Mitglied doch gemeint (Merker gelöscht, zweiter Tab in einer anderen Lobby), führt „Beitreten“ es
 * zurück: Realtime behandelt `lobby:join` eines Mitglieds wie eine Wiederaufnahme. Im Zweifel (Speicher nicht
 * nutzbar) `false` – dann entscheidet der Server per `lobby:resume`.
 */
export function isKnownNonMember(code: string): boolean {
  return readMembership() !== code && writable();
}

/**
 * Merker „diese Person hat (wahrscheinlich) ein gültiges Session-Cookie“ – nur ein Hinweis, kein Geheimnis
 * (das Cookie selbst ist HttpOnly). Damit holt der Client beim Wiederkommen direkt ein Ticket, statt vorher
 * `POST /api/session` aufzurufen; beim ersten Besuch legt er die Session ohne fehlschlagenden Ticket-Versuch an.
 */
export function readSessionHint(): boolean {
  return read(KEYS.session) === "1";
}

export function writeSessionHint(known: boolean): void {
  write(KEYS.session, known ? "1" : null);
}

/** Gespeicherte Kategorie-Darstellungen einer Lobby als JSON-Text (Prüfung beim Einlesen, siehe categories.ts). */
export function readStoredCategories(): string | null {
  return read(KEYS.categories);
}

export function writeStoredCategories(json: string | null): void {
  write(KEYS.categories, json);
}
