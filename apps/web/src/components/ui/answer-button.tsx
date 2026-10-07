"use client";

import * as m from "motion/react-m";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import { CircleCheckIcon, CircleXIcon, LockIcon } from "../../lib/ui/icons";
import { MotionProvider } from "../../lib/ui/motion";
import type { PlayerColor } from "../../lib/ui/player";
import { Avatar } from "./avatar";

/**
 * - `idle`: antippbar
 * - `locked`: eigene eingeloggte Antwort (Rahmen primary + Tönung + `lock`)
 * - `dimmed`: übrige Antworten nach dem Einloggen (50 %)
 * - `correct` / `wrong`: Auflösung (Rahmen + Tönung + `circle-check` / `circle-x`)
 * - `disabled`: nicht bedienbar (z. B. Zuschauende)
 * - `view`: nur anzeigen, voll lesbar, nicht bedienbar – das Gerät des anzeigenden Hosts (ADR-046)
 */
export type AnswerState = "idle" | "locked" | "dimmed" | "correct" | "wrong" | "disabled" | "view";

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
   * Personen, die diese Antwort gewählt haben (Auflösung): Avatare 24 gleiten gestaffelt an den rechten Rand,
   * max. 4 sichtbar, danach „+N“. Sie ragen 12 px unter die Karte – Antworten deshalb mit mindestens 16 px Abstand
   * stapeln; unter der letzten Antwort hält der Rahmen der Bühne in Frage und Auflösung gleich viel Platz frei
   * (16 px Innenabstand, overlay-frame.tsx).
   */
  pickedBy?: readonly AnswerPicker[];
  /**
   * Einblendung des Avatars Nr. `position` (motion-Props). Die Bühne plant sie relativ zum Phasenbeginn
   * (docs/09 §7.6: ab 500 ms, 150 ms gestaffelt, 480 ms – `answerRevealPickerMotion`); ohne: sofort sichtbar.
   */
  pickerMotion?: (position: number) => PickerMotion;
}

/** motion-Props einer Avatar-Einblendung (Teilmenge von `EntranceMotion` aus der Choreografie). */
export interface PickerMotion {
  initial: false | { opacity?: number; x?: number };
  animate: { opacity?: number; x?: number };
  transition: { duration: number; ease: readonly [number, number, number, number]; delay: number };
}

const stateClasses: Record<AnswerState, string> = {
  idle: "border-line-strong bg-surface-2 is-hover:bg-surface-3 is-pressed:bg-surface-3 motion-safe:is-pressed:scale-98",
  locked: "border-primary bg-primary-tint",
  dimmed: "border-line-strong bg-surface-2 opacity-50",
  correct: "border-success bg-success-tint",
  wrong: "border-danger bg-danger-tint",
  disabled: "border-line-strong bg-surface-2 opacity-40",
  view: "border-line-strong bg-surface-2",
};

const letterClasses: Record<AnswerState, string> = {
  idle: "border-line-strong text-text-2",
  locked: "border-primary text-text",
  dimmed: "border-line-strong text-text-2",
  correct: "border-success text-text",
  wrong: "border-danger text-text",
  disabled: "border-line-strong text-text-2",
  view: "border-line-strong text-text-2",
};

const stateText: Partial<Record<AnswerState, string>> = {
  locked: de.a11y.answerLocked,
  correct: de.a11y.answerCorrect,
  wrong: de.a11y.answerWrong,
};

const MAX_VISIBLE_PICKERS = 4;

/** Icon im festen Slot rechts: `lock` 16, `circle-check`/`circle-x` 20; idle, dimmed und disabled bleiben leer. */
function StateIcon({ state }: { state: AnswerState }) {
  if (state === "locked") return <LockIcon size={16} className="text-primary" />;
  if (state === "correct") return <CircleCheckIcon size={20} className="text-success" />;
  if (state === "wrong") return <CircleXIcon size={20} className="text-danger" />;
  return null;
}

/**
 * AnswerButton (docs/09 §5): Mindesthöhe 64, `surface-2`, 2 px Rahmen `line-strong`, links
 * Buchstabe A–D (28 × 28), Text `answer` (bis 2 Zeilen). Richtig/falsch zusätzlich per Icon und
 * Screenreader-Text (docs/09 §12). Nur `idle` ist bedienbar.
 *
 * - **Fester Icon-Slot rechts (20 × 20) in allen Zuständen** – leer bei idle/dimmed/disabled. Der Text hat so in
 *   jedem Zustand dieselbe Breite und bricht beim Einloggen und in der Auflösung nicht neu um (gleiche
 *   Zeilenzahl, nichts springt). Lange Komposita trennt der Browser (`hyphens: auto`, Sprache `de` aus `<html>`).
 * - **Zwei Zeilen = Mindesthöhe:** 6 px Innenabstand oben und unten – eine zweizeilige Antwort ist genau 64 hoch
 *   wie eine einzeilige (2 × 24 + 2 × 6 + 2 × 2 Rahmen). So passen bei 360 × 740 die längste Frage (140 Zeichen)
 *   und vier Antworten mit 40 Zeichen samt der Avatare an Antwort D auf die Bühne, ohne dass sie scrollt.
 * - **Buchstabe im zugänglichen Namen** (WCAG 2.5.3 „Label in Name“): Sichtbar steht „C Canberra“, der Name
 *   beginnt deshalb mit dem Buchstaben – Sprachsteuerung trifft die Antwort auch mit „C“.
 * - **Nicht bedienbar = nicht im Tab-Pfad:** Außer `idle` sind alle Zustände `aria-disabled` und `tabIndex=-1`.
 *   Der Fokus bleibt dabei, wo er ist (z. B. auf der gerade eingeloggten Antwort oder der Antwortgruppe) –
 *   er springt nicht ins Leere, nur Tab führt nicht mehr durch die gesperrten Antworten.
 */
export function AnswerButton({
  index,
  text,
  state = "idle",
  onSelect,
  shake = false,
  pickedBy = [],
  pickerMotion,
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
      tabIndex={interactive ? undefined : -1}
      aria-disabled={interactive ? undefined : true}
      aria-keyshortcuts={`${index + 1} ${letter}`}
      onClick={interactive ? onSelect : undefined}
      className={cx(
        "relative flex min-h-16 w-full items-center gap-3 rounded-lg border-2 px-3 py-1.5 text-left select-none touch-manipulation transition-control is-focus:outline-2 is-focus:outline-offset-2 is-focus:outline-primary",
        stateClasses[state],
        shake && state === "wrong" && "motion-safe:animate-shake",
      )}
    >
      <span
        className={cx(
          "flex size-7 shrink-0 items-center justify-center rounded-sm border text-label transition-control",
          letterClasses[state],
        )}
      >
        {letter}
      </span>
      <span className="min-w-0 flex-1 text-answer text-text hyphens-auto wrap-break-word">
        {text}
        {srText ? <span className="sr-only">, {srText}</span> : null}
      </span>
      <span aria-hidden="true" data-slot="answer-icon" className="flex size-5 shrink-0 items-center justify-center">
        <StateIcon state={state} />
      </span>
      {pickedBy.length > 0 ? <Pickers pickers={pickedBy} motion={pickerMotion} /> : null}
    </button>
  );
}

/** Ohne Choreografie der Bühne (z. B. Galerie): sofort im Endzustand. */
const RESTING_PICKER: PickerMotion = {
  initial: false,
  animate: { opacity: 1, x: 0 },
  transition: { duration: 0, ease: [0, 0, 1, 1], delay: 0 },
};

function Pickers({
  pickers,
  motion,
}: {
  pickers: readonly AnswerPicker[];
  motion: ((position: number) => PickerMotion) | undefined;
}) {
  const visible = pickers.slice(0, MAX_VISIBLE_PICKERS);
  const hidden = pickers.length - visible.length;
  const enter = (position: number): PickerMotion => (motion ? motion(position) : RESTING_PICKER);
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
