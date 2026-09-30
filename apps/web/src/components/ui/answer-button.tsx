"use client";

import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import { CircleCheckIcon, CircleXIcon, LockIcon } from "../../lib/ui/icons";
import { MotionProvider } from "../../lib/ui/motion";
import { transitions } from "../../lib/ui/motion-presets";
import type { PlayerColor } from "../../lib/ui/player";
import { DURATION_MS, OFFSET_PX, STAGGER_MS, seconds } from "../../lib/ui/tokens";
import { Avatar } from "./avatar";

/**
 * - `idle`: antippbar
 * - `locked`: eigene eingeloggte Antwort (Rahmen primary + Tönung + `lock`)
 * - `dimmed`: übrige Antworten nach dem Einloggen (50 %)
 * - `correct` / `wrong`: Auflösung (Rahmen + Tönung + `circle-check` / `circle-x`)
 * - `disabled`: nicht bedienbar (z. B. Zuschauende)
 */
export type AnswerState = "idle" | "locked" | "dimmed" | "correct" | "wrong" | "disabled";

export interface AnswerPicker {
  id: string;
  name: string;
  color: PlayerColor;
}

export interface AnswerButtonProps extends ForcedStateProps {
  /** Position 0–3 → Buchstabe A–D und Tastenkürzel 1–4 / A–D */
  index: 0 | 1 | 2 | 3;
  text: string;
  state?: AnswerState;
  onSelect?: () => void;
  /** Kurzer Seitwärtsruck – nur für die eigene falsche Antwort (`state="wrong"`) */
  shake?: boolean;
  /**
   * Personen, die diese Antwort gewählt haben (Auflösung): Avatare 24 gleiten ab 200 ms gestaffelt
   * an den rechten Rand, max. 4 sichtbar, danach „+N“. Sie ragen 12 px unter die Karte –
   * Antworten deshalb mit mindestens 16 px Abstand stapeln.
   */
  pickedBy?: readonly AnswerPicker[];
}

const stateClasses: Record<AnswerState, string> = {
  idle: "border-line-strong bg-surface-2 is-hover:bg-surface-3 is-pressed:bg-surface-3 motion-safe:is-pressed:scale-98",
  locked: "border-primary bg-primary-tint",
  dimmed: "border-line-strong bg-surface-2 opacity-50",
  correct: "border-success bg-success-tint",
  wrong: "border-danger bg-danger-tint",
  disabled: "border-line-strong bg-surface-2 opacity-40",
};

const letterClasses: Record<AnswerState, string> = {
  idle: "border-line-strong text-text-2",
  locked: "border-primary text-text",
  dimmed: "border-line-strong text-text-2",
  correct: "border-success text-text",
  wrong: "border-danger text-text",
  disabled: "border-line-strong text-text-2",
};

const stateText: Partial<Record<AnswerState, string>> = {
  locked: de.a11y.answerLocked,
  correct: de.a11y.answerCorrect,
  wrong: de.a11y.answerWrong,
};

const MAX_VISIBLE_PICKERS = 4;

/**
 * AnswerButton (docs/09 §5): Mindesthöhe 64, `surface-2`, 2 px Rahmen `line-strong`, links
 * Buchstabe A–D (28 × 28), Text `answer` (bis 2 Zeilen). Richtig/falsch zusätzlich per Icon und
 * Screenreader-Text (docs/09 §12). Nur `idle` ist bedienbar.
 */
export function AnswerButton({
  index,
  text,
  state = "idle",
  onSelect,
  shake = false,
  pickedBy = [],
  ...rest
}: AnswerButtonProps) {
  const letter = de.game.answerLetters[index];
  const interactive = state === "idle";
  const srParts = [stateText[state], pickedBy.length > 0 && de.a11y.pickedBy(pickedBy.map((picker) => picker.name))];
  const srText = srParts.filter((part): part is string => typeof part === "string").join(", ");

  return (
    <button
      {...rest}
      type="button"
      aria-disabled={interactive ? undefined : true}
      aria-keyshortcuts={`${index + 1} ${letter}`}
      onClick={interactive ? onSelect : undefined}
      className={cx(
        "relative flex min-h-16 w-full items-center gap-3 rounded-lg border-2 px-3 py-2 text-left select-none touch-manipulation transition-control is-focus:outline-2 is-focus:outline-offset-2 is-focus:outline-primary",
        stateClasses[state],
        shake && state === "wrong" && "motion-safe:animate-shake",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "flex size-7 shrink-0 items-center justify-center rounded-sm border text-label transition-control",
          letterClasses[state],
        )}
      >
        {letter}
      </span>
      <span className="min-w-0 flex-1 text-answer text-text">
        {text}
        {srText ? <span className="sr-only">, {srText}</span> : null}
      </span>
      {state === "locked" ? <LockIcon size={16} className="shrink-0 text-primary" /> : null}
      {state === "correct" ? <CircleCheckIcon size={20} className="shrink-0 text-success" /> : null}
      {state === "wrong" ? <CircleXIcon size={20} className="shrink-0 text-danger" /> : null}
      {pickedBy.length > 0 ? <Pickers pickers={pickedBy} /> : null}
    </button>
  );
}

function Pickers({ pickers }: { pickers: readonly AnswerPicker[] }) {
  const reduce = useReducedMotion() ?? false;
  const visible = pickers.slice(0, MAX_VISIBLE_PICKERS);
  const hidden = pickers.length - visible.length;
  const enter = (position: number) => ({
    initial: { opacity: 0, x: reduce ? 0 : -OFFSET_PX.enter },
    animate: { opacity: 1, x: 0 },
    transition: {
      ...(reduce ? transitions.fade : transitions.enter),
      delay: seconds(DURATION_MS.base + position * STAGGER_MS.pickers),
    },
  });
  return (
    <MotionProvider>
      <span aria-hidden="true" className="pointer-events-none absolute right-3 -bottom-3 flex items-center gap-1">
        {visible.map((picker, position) => (
          <m.span key={picker.id} {...enter(position)} className="flex rounded-full outline-2 outline-bg">
            <Avatar name={picker.name} color={picker.color} size={24} />
          </m.span>
        ))}
        {hidden > 0 ? (
          <m.span
            {...enter(visible.length)}
            className="flex h-6 min-w-6 items-center justify-center rounded-full bg-surface-3 px-1 text-caption text-text outline-2 outline-bg tabular-nums"
          >
            {de.game.moreAvatars(hidden)}
          </m.span>
        ) : null}
      </span>
    </MotionProvider>
  );
}
