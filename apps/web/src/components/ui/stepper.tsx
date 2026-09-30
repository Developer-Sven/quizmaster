"use client";

import { useId } from "react";
import { de } from "../../i18n/de";
import { MinusIcon, PlusIcon } from "../../lib/ui/icons";
import { IconButton } from "./icon-button";

export interface StepperProps {
  /** Beschriftung links, z. B. „Runden“ */
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  step?: number;
  /** Ganzer Stepper nicht bedienbar (z. B. Gäste): beide Tasten deaktiviert, Wert bleibt lesbar */
  disabled?: boolean;
}

/** Hält einen Wert in [min, max]. */
function clampStep(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Stepper (docs/09 §5): Label links, rechts `minus` · Wert (`label`, tabular) · `plus`
 * (IconButtons 44). An den Grenzen ist die jeweilige Taste deaktiviert, bleibt aber fokussierbar.
 */
export function Stepper({ label, value, min, max, onChange, step = 1, disabled = false }: StepperProps) {
  const labelId = useId();
  return (
    <fieldset aria-labelledby={labelId} className="flex min-h-14 min-w-0 items-center gap-2">
      <span id={labelId} className="min-w-0 flex-1 text-body text-text">
        {label}
      </span>
      <IconButton
        icon={MinusIcon}
        label={de.settings.decrease(label)}
        disabled={disabled || value <= min}
        onClick={() => onChange(clampStep(value - step, min, max))}
      />
      <output aria-live="polite" className="w-8 text-center text-label text-text tabular-nums">
        {value}
      </output>
      <IconButton
        icon={PlusIcon}
        label={de.settings.increase(label)}
        disabled={disabled || value >= max}
        onClick={() => onChange(clampStep(value + step, min, max))}
      />
    </fieldset>
  );
}
