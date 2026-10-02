"use client";

import { useId } from "react";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { MinusIcon, PlusIcon } from "../../lib/ui/icons";
import { IconButton } from "./icon-button";

interface StepperBaseProps {
  /** Beschriftung links, z. B. „Runden“ */
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** Anzeige des Werts (z. B. „5 s“ oder „Host“) – Standard: die Zahl (ADR-045) */
  format?: (value: number) => string;
  /** Ganzer Stepper nicht bedienbar (z. B. Gäste): beide Tasten deaktiviert, Wert bleibt lesbar */
  disabled?: boolean;
  /**
   * Wert weicht vom aktuellen Stand ab (Vorschläge, ADR-053): Hinweis wie „Aktuell: 3“ unter dem Label
   * (`aria-describedby`), der Wert erscheint orange.
   */
  changedNote?: string;
}

/** Zahlenbereich [min, max] mit Schrittweite – oder feste Stufen (`options`, aufsteigend). */
type StepperRange =
  | { min: number; max: number; step?: number; options?: undefined }
  | { options: readonly number[]; min?: undefined; max?: undefined; step?: undefined };

export type StepperProps = StepperBaseProps & StepperRange;

/** Hält einen Wert in [min, max]. */
function clampStep(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Vorherige bzw. nächste Stufe (`null` an der Grenze); ein Wert zwischen den Stufen springt zur nächsten. */
export function stepOption(options: readonly number[], value: number, direction: -1 | 1): number | null {
  if (direction === 1) return options.find((option) => option > value) ?? null;
  return options.findLast((option) => option < value) ?? null;
}

/**
 * Stepper (docs/09 §5): Label links, rechts `minus` · Wert (`label`, tabular) · `plus`
 * (IconButtons 44). An den Grenzen ist die jeweilige Taste deaktiviert, bleibt aber fokussierbar.
 */
export function Stepper(props: StepperProps) {
  const { label, value, onChange, format, disabled = false, changedNote } = props;
  const labelId = useId();
  const noteId = useId();
  const lower =
    props.options === undefined
      ? value > props.min
        ? clampStep(value - (props.step ?? 1), props.min, props.max)
        : null
      : stepOption(props.options, value, -1);
  const higher =
    props.options === undefined
      ? value < props.max
        ? clampStep(value + (props.step ?? 1), props.min, props.max)
        : null
      : stepOption(props.options, value, 1);
  return (
    <fieldset
      aria-labelledby={labelId}
      aria-describedby={changedNote === undefined ? undefined : noteId}
      className="flex min-h-14 min-w-0 items-center gap-2"
    >
      {changedNote === undefined ? (
        <span id={labelId} className="min-w-0 flex-1 text-body text-text">
          {label}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={labelId} className="text-body text-text">
            {label}
          </span>
          <span id={noteId} className="text-caption text-text-2" data-testid="stepper-note">
            {changedNote}
          </span>
        </span>
      )}
      <IconButton
        icon={MinusIcon}
        label={de.settings.decrease(label)}
        disabled={disabled || lower === null}
        onClick={() => {
          if (lower !== null) onChange(lower);
        }}
      />
      {/* Gleiche Breite für Zahlen und „5 s“/„Host“: Die Tasten untereinanderliegender Stepper fluchten. */}
      <output
        aria-live="polite"
        className={cx(
          "w-12 text-center text-label tabular-nums",
          changedNote === undefined ? "text-text" : "text-primary",
        )}
      >
        {format === undefined ? value : format(value)}
      </output>
      <IconButton
        icon={PlusIcon}
        label={de.settings.increase(label)}
        disabled={disabled || higher === null}
        onClick={() => {
          if (higher !== null) onChange(higher);
        }}
      />
    </fieldset>
  );
}
