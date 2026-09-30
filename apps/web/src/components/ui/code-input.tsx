"use client";

import { type ChangeEvent, type ClipboardEvent, type Ref, type SyntheticEvent, useId, useState } from "react";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { TriangleAlertIcon } from "../../lib/ui/icons";
import {
  applyCodeInput,
  applyCodePaste,
  type CodeInputChange,
  LOBBY_CODE_LENGTH,
  normalizeCodeInput,
} from "../../lib/ui/lobby-code";

const CELLS = [0, 1, 2, 3, 4, 5] as const;

export interface CodeInputProps {
  /** Sichtbare Beschriftung (Standard „Lobby-Code“) */
  label?: string;
  /** Kontrollierter Wert (wird normalisiert angezeigt) */
  value?: string;
  /** Startwert ohne Kontrolle von außen */
  defaultValue?: string;
  /** Jede Änderung, bereits normalisiert (Großbuchstaben, ohne Leerzeichen/Bindestriche, max. 6) */
  onChange?: (code: string) => void;
  /** Sobald eine Eingabe den Code auf 6 Zeichen vervollständigt (Auto-Beitritt) */
  onComplete?: (code: string) => void;
  /** Fehler: alle Zellen roter Rahmen, Hinweis darunter */
  error?: string | null;
  disabled?: boolean;
  name?: string;
  ref?: Ref<HTMLInputElement>;
  /** Nur für /dev/ui: Zustand „aktiv“ statisch zeigen */
  "data-force"?: "focus";
}

/**
 * CodeInput (docs/09 §5): 6 Zellen à 48 × 56, Lücke nach Zelle 3, Zeichen im Stil `code`.
 * Ein einziges (unsichtbares) Eingabefeld liegt über den Zellen: Tastatur, Einfügen, Autokorrektur-
 * Schutz und Screenreader funktionieren wie bei einem normalen Feld.
 */
export function CodeInput({
  label = de.fields.lobbyCode,
  value,
  defaultValue = "",
  onChange,
  onComplete,
  error,
  disabled = false,
  name,
  ref,
  "data-force": force,
}: CodeInputProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const [uncontrolled, setUncontrolled] = useState(() => normalizeCodeInput(defaultValue));
  const [focused, setFocused] = useState(false);
  const code = value === undefined ? uncontrolled : normalizeCodeInput(value);
  const invalid = Boolean(error);
  const showActive = (focused || force === "focus") && !disabled;
  const activeIndex = Math.min(code.length, LOBBY_CODE_LENGTH - 1);

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

  // Die Zellen zeigen immer das Ende der Eingabe: Einfügemarke ans Ende (Alles-Markieren bleibt erlaubt).
  const keepCaretAtEnd = (event: SyntheticEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const end = input.value.length;
    const all = input.selectionStart === 0 && input.selectionEnd === end;
    if (!all && (input.selectionStart !== end || input.selectionEnd !== end)) input.setSelectionRange(end, end);
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
          onSelect={keepCaretAtEnd}
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
          aria-describedby={invalid ? errorId : undefined}
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
      {invalid ? (
        <p id={errorId} role="alert" className="flex items-center gap-1 text-caption text-danger">
          <TriangleAlertIcon size={16} className="shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
