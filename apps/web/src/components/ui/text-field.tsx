"use client";

import { type ComponentPropsWithRef, useId } from "react";
import { cx } from "../../lib/ui/cx";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import { TriangleAlertIcon } from "../../lib/ui/icons";

export interface TextFieldProps
  extends ForcedStateProps,
    Omit<ComponentPropsWithRef<"input">, "className" | "style" | "children" | "id" | "size"> {
  /** Sichtbare Beschriftung über dem Feld (Stil `label`) */
  label: string;
  /** Fehlertext unter dem Feld (`caption`, rot + `triangle-alert`); setzt `aria-invalid` */
  error?: string | null;
}

/**
 * TextField (docs/09 §5): Label oben, Feld 56 hoch in `surface-2` mit 1 px `line-strong`,
 * Fokus = 2 px primary (ohne Layoutsprung), Fehler rot mit Hinweis darunter, deaktiviert 40 %.
 */
export function TextField({ label, error, disabled = false, "data-force": force, ...rest }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const invalid = Boolean(error);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={cx("text-label text-text", disabled && "opacity-40")}>
        {label}
      </label>
      <input
        {...rest}
        id={id}
        disabled={disabled}
        data-force={force}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        className={cx(
          "h-14 w-full min-w-0 rounded-lg border bg-surface-2 px-4 text-body text-text transition-control is-field-focus:outline-1 is-field-focus:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40",
          invalid
            ? "border-danger is-field-focus:outline-danger"
            : "border-line-strong is-field-focus:border-primary is-field-focus:outline-primary",
        )}
      />
      {invalid ? (
        <p id={errorId} role="alert" className="flex items-center gap-1 text-caption text-danger">
          <TriangleAlertIcon size={16} className="shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
