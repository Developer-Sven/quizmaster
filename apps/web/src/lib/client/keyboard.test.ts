import { describe, expect, it } from "vitest";
import {
  answerShortcut,
  categoryShortcut,
  createModalityTracker,
  isEditableElement,
  keyboardOperation,
  type ShortcutGuard,
  shortcutsAllowed,
  shouldClaimFocus,
} from "./keyboard";

/** Alle Bedingungen erfüllt: Overlay aktiv, Seite sichtbar, Fokus in der Gruppe, kein Modal, kein Eingabefeld. */
const READY: ShortcutGuard = {
  overlayActive: true,
  pageVisible: true,
  focusInGroup: true,
  modalOpen: false,
  editableFocused: false,
};

describe("Tastatur-Zuordnung (docs/09 §12)", () => {
  it("ordnet Antworten 1–4 und A–D (auch klein, auch mit Umschalt) zu", () => {
    expect(["1", "2", "3", "4"].map((key) => answerShortcut({ key }, READY))).toEqual([0, 1, 2, 3]);
    expect(["a", "b", "c", "d"].map((key) => answerShortcut({ key }, READY))).toEqual([0, 1, 2, 3]);
    expect(["A", "B", "C", "D"].map((key) => answerShortcut({ key }, READY))).toEqual([0, 1, 2, 3]);
    expect(answerShortcut({ key: "5" }, READY)).toBeNull();
    expect(answerShortcut({ key: "e" }, READY)).toBeNull();
    expect(answerShortcut({ key: "Enter" }, READY)).toBeNull();
  });

  it("ordnet Kategorien 1–3 zu – nur so viele, wie angeboten werden", () => {
    expect(["1", "2", "3"].map((key) => categoryShortcut({ key }, READY))).toEqual([0, 1, 2]);
    expect(categoryShortcut({ key: "4" }, READY)).toBeNull();
    expect(categoryShortcut({ key: "a" }, READY)).toBeNull();
    expect(categoryShortcut({ key: "3" }, READY, 2)).toBeNull();
  });
});

describe("WCAG 2.1.4: Einzeltasten-Kürzel nur bei Fokus und ohne Störung", () => {
  it("wirkt nur, wenn alle Bedingungen erfüllt sind", () => {
    expect(shortcutsAllowed({ key: "1" }, READY)).toBe(true);
    const blockers: Array<Partial<ShortcutGuard>> = [
      { overlayActive: false }, // Overlay blendet aus oder ist inert
      { pageVisible: false }, // Tab im Hintergrund
      { focusInGroup: false }, // Fokus z. B. im HUD
      { modalOpen: true }, // Dialog „Spiel verlassen?“ oder Sheet offen
      { editableFocused: true }, // Fokus in einem Eingabefeld
    ];
    for (const blocker of blockers) {
      const guard = { ...READY, ...blocker };
      expect(shortcutsAllowed({ key: "1" }, guard), JSON.stringify(blocker)).toBe(false);
      expect(answerShortcut({ key: "a" }, guard)).toBeNull();
      expect(categoryShortcut({ key: "2" }, guard)).toBeNull();
    }
  });

  it("ignoriert Modifikatoren, gehaltene Tasten, IME-Eingaben und bereits behandelte Ereignisse", () => {
    expect(answerShortcut({ key: "1", altKey: true }, READY)).toBeNull();
    expect(answerShortcut({ key: "1", ctrlKey: true }, READY)).toBeNull();
    expect(answerShortcut({ key: "a", metaKey: true }, READY)).toBeNull();
    expect(answerShortcut({ key: "1", repeat: true }, READY)).toBeNull();
    expect(answerShortcut({ key: "a", isComposing: true }, READY)).toBeNull();
    expect(answerShortcut({ key: "1", defaultPrevented: true }, READY)).toBeNull();
    expect(answerShortcut({ key: "constructor" }, READY)).toBeNull();
  });

  it("erkennt Eingabefelder (Text, Auswahl, contenteditable, Textbox-Rollen)", () => {
    expect(isEditableElement({ tagName: "INPUT" })).toBe(true);
    expect(isEditableElement({ tagName: "textarea" })).toBe(true);
    expect(isEditableElement({ tagName: "SELECT" })).toBe(true);
    expect(isEditableElement({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableElement({ tagName: "DIV", getAttribute: () => "textbox" })).toBe(true);
    expect(isEditableElement({ tagName: "BUTTON", getAttribute: () => null })).toBe(false);
    expect(isEditableElement({ tagName: "FIELDSET" })).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe("Fokus für die Kürzel-Gruppe", () => {
  /** Minimales DOM: Elemente als Objekte, `contains` über eine Kinderliste. */
  function element(children: object[] = []): Element {
    return { contains: (other: unknown) => children.includes(other as object) } as Element;
  }
  const body = element();
  const html = element([body]);
  const root = { body, documentElement: html };
  const answerButton = element();
  const stage = element([answerButton]);
  const hudButton = element();

  it("übernimmt den Fokus nur, wenn er frei ist (nirgends, Body, in der Bühne)", () => {
    expect(shouldClaimFocus(null, stage, false, root)).toBe(true);
    expect(shouldClaimFocus(body, stage, false, root)).toBe(true);
    expect(shouldClaimFocus(html, stage, false, root)).toBe(true);
    expect(shouldClaimFocus(answerButton, stage, false, root)).toBe(true);
  });

  it("zieht den Fokus nie aus dem HUD, aus einem Dialog/Sheet oder ohne Bühne", () => {
    expect(shouldClaimFocus(hudButton, stage, false, root)).toBe(false);
    expect(shouldClaimFocus(body, stage, true, root)).toBe(false);
    expect(shouldClaimFocus(hudButton, null, false, root)).toBe(false);
  });

  it("übernimmt einen Fokus, der in einem inerten Bereich liegt (z. B. Bühne unter dem Spielende)", () => {
    const inertButton = { ...element(), closest: (selector: string) => (selector === "[inert]" ? body : null) };
    expect(shouldClaimFocus(inertButton as unknown as Element, null, false, root)).toBe(true);
    expect(shouldClaimFocus(inertButton as unknown as Element, stage, true, root)).toBe(false);
  });
});

describe("Eingabeart für den Fokusring der Kürzel-Gruppe", () => {
  it("zählt Bedien-Tasten als Tastatur – Tippen in ein Eingabefeld (Lobby-Code) nur mit Tab, Enter oder Esc", () => {
    expect(keyboardOperation({ key: "Tab" }, false)).toBe(true);
    expect(keyboardOperation({ key: "1" }, false)).toBe(true);
    expect(keyboardOperation({ key: " " }, false)).toBe(true);
    expect(keyboardOperation({ key: "A" }, true)).toBe(false);
    expect(keyboardOperation({ key: "7" }, true)).toBe(false);
    expect(keyboardOperation({ key: "Backspace" }, true)).toBe(false);
    expect(keyboardOperation({ key: "Tab" }, true)).toBe(true);
    expect(keyboardOperation({ key: "Enter" }, true)).toBe(true);
    expect(keyboardOperation({ key: "Escape" }, true)).toBe(true);
  });

  it("ignoriert Bildschirmtastaturen (IME, keyCode 229) und reine Modifikatoren", () => {
    expect(keyboardOperation({ key: "a", isComposing: true }, false)).toBe(false);
    expect(keyboardOperation({ key: "Unidentified", keyCode: 229 }, false)).toBe(false);
    expect(keyboardOperation({ key: "Process" }, false)).toBe(false);
    expect(keyboardOperation({ key: "1", keyCode: 229 }, false)).toBe(false);
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(keyboardOperation({ key }, false), key).toBe(false);
    }
  });

  /** Tastendruck als Ereignis (Node kennt kein KeyboardEvent): `key`/`keyCode` als eigene Felder. */
  function keydown(key: string, keyCode?: number): Event {
    return Object.assign(new Event("keydown"), { key, keyCode });
  }

  it("verfolgt die zuletzt benutzte Eingabeart und meldet nur Wechsel", () => {
    const target = new EventTarget();
    let editable = false;
    const tracker = createModalityTracker(target, () => editable);
    const seen: Array<string | null> = [];
    const unsubscribe = tracker.subscribe(() => seen.push(tracker.current()));
    expect(tracker.current()).toBeNull();

    // Auto-Beitritt: sechs Zeichen in das Code-Feld getippt – keine Tastatur-Bedienung
    editable = true;
    for (const key of ["A", "B", "C", "2", "3", "4"]) target.dispatchEvent(keydown(key));
    expect(tracker.current()).toBeNull();

    target.dispatchEvent(new Event("pointerdown"));
    expect(tracker.current()).toBe("pointer");
    target.dispatchEvent(keydown("Tab"));
    expect(tracker.current()).toBe("keyboard");
    editable = false;
    target.dispatchEvent(keydown("1"));
    target.dispatchEvent(keydown("Unidentified", 229));
    expect(tracker.current()).toBe("keyboard");
    target.dispatchEvent(new Event("pointerdown"));
    expect(seen).toEqual(["pointer", "keyboard", "pointer"]);

    unsubscribe();
    tracker.stop();
    target.dispatchEvent(keydown("Tab"));
    expect(tracker.current()).toBe("pointer");
    expect(seen).toHaveLength(3);
  });
});
