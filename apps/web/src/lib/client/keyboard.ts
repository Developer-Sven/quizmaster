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
 * Dialog oder einem Eingabefeld gezogen.
 *
 * **Fokusring der Gruppe:** Der Ring (`primary`, docs/09 §5) erscheint nur, wenn die Seite zuletzt per Tastatur
 * bedient wurde ({@link createModalityTracker}), und nur, solange die Gruppe bedienbar ist. Ein oranger Rahmen um
 * alle Antworten bzw. Kacheln wirkte sonst wie eine Auswahl (Orange = „antippbar oder zählt gerade“), etwa nach
 * dem Auto-Beitritt per Code-Eingabe oder nach dem Einloggen. Den Fokus selbst übernimmt die Gruppe trotzdem:
 * Kürzel wirken auch für Maus-plus-Tastatur, und Screenreader lesen beim Öffnen die Frage (Gruppenname).
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
 * Darf die Gruppe den Fokus übernehmen? Nur wenn er frei ist: nirgends, auf `<body>`/`<html>`, innerhalb der
 * Bühne (`stage`, z. B. auf einem Element des gerade ausgeblendeten Overlays) oder in einem inerten Bereich
 * (dort ist er ohnehin verloren, z. B. unter dem Spielende) – und kein Sheet/Dialog offen.
 */
export function shouldClaimFocus(
  active: Element | null,
  stage: Element | null,
  modalOpen: boolean,
  root: { body: Element | null; documentElement: Element | null },
): boolean {
  if (modalOpen) return false;
  if (active === null || active === root.body || active === root.documentElement) return true;
  if (typeof active.closest === "function" && active.closest("[inert]") !== null) return true;
  return stage?.contains(active) ?? false;
}

/**
 * Setzt den Fokus in die Gruppe, wenn er frei ist (siehe {@link shouldClaimFocus}). Liefert, ob die Gruppe den
 * Fokus jetzt hat (z. B. für eine Ansage, wenn nicht).
 */
export function claimGroupFocus(group: HTMLElement, stage: Element | null): boolean {
  const modalOpen = document.querySelector(MODAL_SELECTOR) !== null;
  if (shouldClaimFocus(document.activeElement, stage, modalOpen, document)) group.focus({ preventScroll: true });
  return document.activeElement === group;
}

// ---------------------------------------------------------------------------------------------------
// Eingabeart (Tastatur oder Zeigen/Tippen) – nur für die Sichtbarkeit des Gruppen-Fokusrings
// ---------------------------------------------------------------------------------------------------

export type InputModality = "keyboard" | "pointer";

export interface ModalityKeyEvent {
  key: string;
  /** 229 = Eingabe über eine Bildschirmtastatur bzw. IME (Android) */
  keyCode?: number;
  isComposing?: boolean;
}

/** Reine Modifikatoren bedienen nichts. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Fn", "CapsLock"]);

/** In einem Eingabefeld zählen nur diese Tasten als Bedienung der Seite (Fokus wechseln, absenden, abbrechen). */
const FIELD_NAVIGATION_KEYS = new Set(["Tab", "Enter", "Escape"]);

/** IME-Tastendrücke tragen keinen echten Tastenwert. */
const IME_KEYS = new Set(["Process", "Unidentified"]);

/**
 * Bedient dieser Tastendruck die Seite per Tastatur? Nein bei Bildschirmtastatur/IME (`keyCode` 229,
 * `isComposing`), reinen Modifikatoren und beim Tippen in ein Eingabefeld (`editable`) – etwa dem Lobby-Code mit
 * Auto-Beitritt; dort zählen nur Tab, Enter und Esc.
 */
export function keyboardOperation(event: ModalityKeyEvent, editable: boolean): boolean {
  if (event.isComposing || event.keyCode === 229 || IME_KEYS.has(event.key)) return false;
  if (MODIFIER_KEYS.has(event.key)) return false;
  return !editable || FIELD_NAVIGATION_KEYS.has(event.key);
}

export interface ModalityTracker {
  /** zuletzt benutzte Eingabeart; `null`, solange nichts davon geschah */
  current(): InputModality | null;
  /** meldet jeden Wechsel; liefert die Abmeldung */
  subscribe(listener: () => void): () => void;
  stop(): void;
}

function isModalityKeyEvent(event: Event): event is Event & ModalityKeyEvent {
  return typeof (event as Partial<ModalityKeyEvent>).key === "string";
}

/**
 * Verfolgt die Eingabeart an `target` (im Browser `document`, Capture-Phase): Bedien-Tasten (siehe
 * {@link keyboardOperation}) → „keyboard“, `pointerdown` (Maus, Finger, Stift) → „pointer“.
 */
export function createModalityTracker(
  target: EventTarget,
  isEditable: (target: EventTarget | null) => boolean,
): ModalityTracker {
  let modality: InputModality | null = null;
  const listeners = new Set<() => void>();
  const change = (next: InputModality) => {
    if (modality === next) return;
    modality = next;
    for (const listener of listeners) listener();
  };
  const onKeyDown = (event: Event) => {
    if (isModalityKeyEvent(event) && keyboardOperation(event, isEditable(event.target))) change("keyboard");
  };
  const onPointerDown = () => change("pointer");
  target.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
  target.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  return {
    current: () => modality,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      target.removeEventListener("keydown", onKeyDown, { capture: true });
      target.removeEventListener("pointerdown", onPointerDown, { capture: true });
      listeners.clear();
    },
  };
}

let pageTracker: ModalityTracker | null = null;

/**
 * Eingabeart dieser Seite (einmal je Seite, im Browser). Früh starten – beim Betreten der Lobby
 * (`preloadOverlays`) –, damit schon die erste Kategoriewahl weiß, ob per Tastatur bedient wird.
 */
export function pageModalityTracker(): ModalityTracker | null {
  if (typeof document === "undefined") return null;
  pageTracker ??= createModalityTracker(document, (target) => target instanceof Element && isEditableElement(target));
  return pageTracker;
}
