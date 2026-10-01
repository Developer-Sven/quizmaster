/**
 * Tastatur im Spiel (docs/09 §12): Antworten mit `1`–`4` bzw. `A`–`D`, Kategorien mit `1`–`3`.
 *
 * **WCAG 2.1.4 (Zeichen-Tastenkürzel, Stufe A) – „nur bei Fokus aktiv“:** Die Kürzel sind reine Einzeltasten.
 * Damit Diktat, Sprachsteuerung, der Fokusmodus von Screenreadern oder versehentliche Tasten keine Antwort
 * auslösen (die sich nicht mehr ändern lässt), gilt ein Kürzel nur, wenn ALLE Bedingungen erfüllt sind:
 *
 * 1. Der Listener hängt an der Antwort- bzw. Kachelgruppe des Overlays (nie global am `document`): Tasten
 *    kommen nur an, solange der Fokus in dieser Gruppe liegt (`focusInGroup`).
 * 2. Das Overlay ist das aktive der Bühne – nicht ausblendend und nicht `inert` (`overlayActive`).
 * 3. Die Seite ist sichtbar (`pageVisible`).
 * 4. Kein Sheet und kein Dialog ist offen (`modalOpen`) und der Fokus steht in keinem Eingabefeld
 *    (`editableFocused`).
 * 5. Keine Modifikatortaste (Alt/Strg/Meta), keine automatische Wiederholung (gehaltene Taste) und keine
 *    laufende IME-Eingabe (`isComposing`).
 *
 * Damit die Kürzel ohne Suchen wirken, bekommt die Gruppe beim Öffnen den Fokus – aber nur, wenn er gerade
 * „frei“ ist (auf `<body>` oder in der Bühne, siehe {@link shouldClaimFocus}); er wird nie aus dem HUD, einem
 * Dialog oder einem Eingabefeld gezogen. Der Fokus der Gruppe ist sichtbar (Ring `primary`, docs/09 §5).
 */
import { type AnswerIndex, answerIndexForKey, categoryIndexForKey } from "../ui/shortcuts";

export interface ShortcutKeyEvent {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** Zustand der Umgebung beim Tastendruck (siehe Bedingungen oben). */
export interface ShortcutGuard {
  overlayActive: boolean;
  pageVisible: boolean;
  focusInGroup: boolean;
  modalOpen: boolean;
  editableFocused: boolean;
}

/** Element-Merkmale, die über „Eingabefeld“ entscheiden (Duck-Typing, ohne DOM testbar). */
export interface ElementLike {
  tagName: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Steht der Fokus in einem Eingabefeld (Text, Auswahl, contenteditable)? */
export function isEditableElement(element: ElementLike | null | undefined): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (TEXT_ENTRY_TAGS.has(element.tagName.toUpperCase())) return true;
  const role = element.getAttribute?.("role");
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

/** Sind Einzeltasten-Kürzel gerade erlaubt? (alle Bedingungen aus dem Modulkommentar) */
export function shortcutsAllowed(event: ShortcutKeyEvent, guard: ShortcutGuard): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return guard.overlayActive && guard.pageVisible && guard.focusInGroup && !guard.modalOpen && !guard.editableFocused;
}

/** Antwort (0–3) zur Taste `1`–`4`/`A`–`D`, wenn Kürzel erlaubt sind, sonst `null`. */
export function answerShortcut(event: ShortcutKeyEvent, guard: ShortcutGuard): AnswerIndex | null {
  return shortcutsAllowed(event, guard) ? answerIndexForKey(event) : null;
}

/** Kategorie (0 … count−1) zur Taste `1`–`3`, wenn Kürzel erlaubt sind, sonst `null`. */
export function categoryShortcut(event: ShortcutKeyEvent, guard: ShortcutGuard, count = 3): number | null {
  if (!shortcutsAllowed(event, guard)) return null;
  const index = categoryIndexForKey(event);
  return index !== null && index < count ? index : null;
}

/** Elemente offener Sheets und Dialoge (`useModalLayer` setzt `aria-modal`). */
const MODAL_SELECTOR = '[aria-modal="true"]';

/** Liest die Bedingungen für die Gruppe `group` aus dem DOM (nur im Browser). */
export function readShortcutGuard(group: HTMLElement): ShortcutGuard {
  const active = document.activeElement;
  return {
    overlayActive: group.closest("[inert], [data-exiting]") === null,
    pageVisible: document.visibilityState === "visible",
    focusInGroup: active !== null && group.contains(active),
    modalOpen: document.querySelector(MODAL_SELECTOR) !== null,
    editableFocused: active instanceof HTMLElement && isEditableElement(active),
  };
}

/**
 * Darf die Gruppe den Fokus übernehmen? Nur wenn er frei ist: nirgends, auf `<body>`/`<html>` oder innerhalb
 * der Bühne (`stage`, z. B. auf einem Element des gerade ausgeblendeten Overlays) – und kein Sheet/Dialog offen.
 */
export function shouldClaimFocus(
  active: Element | null,
  stage: Element | null,
  modalOpen: boolean,
  root: { body: Element | null; documentElement: Element | null },
): boolean {
  if (modalOpen) return false;
  if (active === null || active === root.body || active === root.documentElement) return true;
  return stage?.contains(active) ?? false;
}

/** Setzt den Fokus in die Gruppe, wenn er frei ist (siehe {@link shouldClaimFocus}). */
export function claimGroupFocus(group: HTMLElement, stage: Element | null): void {
  const modalOpen = document.querySelector(MODAL_SELECTOR) !== null;
  if (shouldClaimFocus(document.activeElement, stage, modalOpen, document)) group.focus({ preventScroll: true });
}
