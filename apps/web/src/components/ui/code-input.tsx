"use client";

import { type ChangeEvent, type ClipboardEvent, type Ref, type SyntheticEvent, useId, useRef, useState } from "react";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { TriangleAlertIcon } from "../../lib/ui/icons";
import {
  activeCodeCell,
  applyCodeInput,
  applyCodePaste,
  type CaretSource,
  type CodeInputChange,
  caretAfterSelect,
  normalizeCodeInput,
} from "../../lib/ui/lobby-code";

const CELLS = [0, 1, 2, 3, 4, 5] as const;

interface CodeInputBaseProps {
  /** Sichtbare Beschriftung (Standard „Lobby-Code“) */
  label?: string;
  /** Kontrollierter Wert (wird normalisiert angezeigt) */
  value?: string;
  /** Startwert ohne Kontrolle von außen */
  defaultValue?: string;
  /** Jede Änderung, bereits normalisiert (Großbuchstaben, ohne Leerzeichen/Bindestriche, max. 6) */
  onChange?: (code: string) => void;
  /** Fehler: alle Zellen roter Rahmen, Hinweis darunter */
  error?: string | null;
  disabled?: boolean;
  name?: string;
  ref?: Ref<HTMLInputElement>;
  /** Nur für /dev/ui: Zustand „aktiv“ statisch zeigen */
  "data-force"?: "focus";
}

/**
 * Auto-Beitritt wechselt den Kontext allein durch die Eingabe – das muss vorher angekündigt sein
 * (WCAG 3.2.2): Mit `onComplete` ist `hint` Pflicht (z. B. `de.fields.lobbyCodeHint`).
 */
type CodeInputCompletionProps =
  | {
      onComplete?: undefined;
      /** Hinweis unter den Zellen (`caption`, `text-2`), mit dem Feld verknüpft */
      hint?: string;
    }
  | {
      /** Sobald eine Eingabe den Code auf 6 Zeichen vervollständigt (Auto-Beitritt) */
      onComplete: (code: string) => void;
      /** Kündigt den Auto-Beitritt an; sichtbar vor der Eingabe und per aria-describedby vorgelesen */
      hint: string;
    };

export type CodeInputProps = CodeInputBaseProps & CodeInputCompletionProps;

/**
 * CodeInput (docs/09 §5): 6 Zellen à 48 × 56, Lücke nach Zelle 3, Zeichen im Stil `code`.
 * Ein einziges (unsichtbares) Eingabefeld liegt über den Zellen: Tastatur (inkl. Pfeiltasten),
 * Einfügen, Autokorrektur-Schutz und Screenreader funktionieren wie bei einem normalen Feld; die
 * aktive Zelle folgt der Einfügemarke.
 */
export function CodeInput({
  label = de.fields.lobbyCode,
  value,
  defaultValue = "",
  onChange,
  onComplete,
  hint,
  error,
  disabled = false,
  name,
  ref,
  "data-force": force,
}: CodeInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [uncontrolled, setUncontrolled] = useState(() => normalizeCodeInput(defaultValue));
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState<number | null>(null);
  // Letzte Bedienart: Zeigerbedienung setzt die Marke ans Ende, Tastatur bewegt sie frei.
  const lastInput = useRef<CaretSource>("pointer");
  const code = value === undefined ? uncontrolled : normalizeCodeInput(value);
  const invalid = Boolean(error);
  const showActive = (focused || force === "focus") && !disabled;
  const activeIndex = activeCodeCell(code.length, caret);
  const describedIds: string[] = [];
  if (hint) describedIds.push(hintId);
  if (invalid) describedIds.push(errorId);
  const describedBy = describedIds.length > 0 ? describedIds.join(" ") : undefined;

  const commit = (change: CodeInputChange) => {
    if (value === undefined) setUncontrolled(change.value);
    onChange?.(change.value);
    if (change.completed) onComplete?.(change.value);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    commit(applyCodeInput(code, event.target.value));
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    commit(applyCodePaste(code, event.clipboardData.getData("text")));
  };

  const handleSelect = (event: SyntheticEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const forced = caretAfterSelect(lastInput.current, start, input.selectionEnd ?? start, input.value.length);
    if (forced !== null) input.setSelectionRange(forced, forced);
    setCaret(forced ?? start);
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={cx("text-label text-text", disabled && "opacity-40")}>
        {label}
      </label>
      <div className={cx("relative flex w-fit max-w-full items-center gap-1", disabled && "opacity-40")}>
        <input
          ref={ref}
          id={id}
          name={name}
          value={code}
          onChange={handleChange}
          onPaste={handlePaste}
          onSelect={handleSelect}
          onPointerDown={() => {
            lastInput.current = "pointer";
          }}
          onKeyDown={() => {
            lastInput.current = "keyboard";
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={disabled}
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          data-1p-ignore=""
          data-lpignore="true"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="absolute inset-0 z-1 size-full cursor-text opacity-0 disabled:cursor-not-allowed"
        />
        {CELLS.map((cell) => {
          const active = showActive && cell === activeIndex;
          return (
            <span
              key={cell}
              aria-hidden="true"
              className={cx(
                "flex h-14 w-12 min-w-0 shrink items-center justify-center rounded-lg border bg-surface-2 text-code text-text tabular-nums transition-control",
                cell === 3 && "ml-3",
                invalid ? "border-danger" : active ? "border-primary" : "border-line-strong",
                active && "outline-1 -outline-offset-2",
                active && (invalid ? "outline-danger" : "outline-primary"),
              )}
            >
              {code[cell] ?? ""}
            </span>
          );
        })}
      </div>
      {hint ? (
        <p id={hintId} className={cx("text-caption text-text-2", disabled && "opacity-40")}>
          {hint}
        </p>
      ) : null}
      {invalid ? (
        <p id={errorId} role="alert" className="flex items-center gap-1 text-caption text-danger">
          <TriangleAlertIcon size={16} className="shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
