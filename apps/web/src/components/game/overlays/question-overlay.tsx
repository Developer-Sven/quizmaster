"use client";

import { ANSWER_INDEXES, type AnswerIndex, type PublicQuestion } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { AnswerButton } from "@/components/ui/answer-button";
import { QuestionCard } from "@/components/ui/question-card";
import { de } from "@/i18n/de";
import { questionAnswerStates } from "@/lib/client/game-view";
import { useServerNow } from "@/lib/client/use-server-clock";
import { transitions } from "@/lib/ui/motion-presets";
import { answerIndexForKey } from "@/lib/ui/shortcuts";
import { DURATION_MS, EASING, STAGGER_MS, seconds } from "@/lib/ui/tokens";
import { OverlayFrame } from "./overlay-frame";

export interface QuestionOverlayProps {
  question: PublicQuestion;
  /** eigene (eingeloggte) Antwort oder `null` */
  myChoice: AnswerIndex | null;
  /** darf diese Person antworten? (aktiv im Spiel) */
  canAnswer: boolean;
  /** verbundene aktive Personen, die noch antworten müssen (ohne die eigene) */
  waitingCount: number;
  /** Identität des Timer-Laufs, z. B. `${question.id}:${syncGeneration}` */
  runId: string;
  onAnswer: (choice: AnswerIndex) => void;
}

/** Karte fährt 16 px von unten ein (docs/09 §7.4). */
const CARD_RISE_PX = 16;

/**
 * Frage (Phase `question` ab `startsAt`, 20 s, docs/09 §7.4–5): `QuestionCard` mit `TimerBar` (CSS über
 * die Restzeit bis `deadline`), vier Antworten (gestaffelt 40 ms). Tippen loggt sofort ein: getippte
 * Antwort `locked`, übrige `dimmed`, darunter „Warte auf 2 weitere …“. Nach der Deadline nicht mehr
 * bedienbar. Tastatur: 1–4 / A–D (Fokus in der Antwortgruppe).
 */
export function QuestionOverlay({
  question,
  myChoice,
  canAnswer,
  waitingCount,
  runId,
  onAnswer,
}: QuestionOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const now = useServerNow([question.deadline]);
  const expired = now >= question.deadline;
  const states = questionAnswerStates(myChoice, canAnswer && !expired);
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const open = canAnswer && myChoice === null && !expired;

  // Fokus in die Antwortgruppe, damit 1–4/A–D sofort wirken – nur, wenn er nicht gerade woanders steht.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active === null || active === document.body || groupRef.current?.parentElement?.contains(active)) {
      groupRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  const select = (choice: AnswerIndex) => {
    if (states[choice] === "idle") onAnswer(choice);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const choice = answerIndexForKey(event);
    if (choice === null || states[choice] !== "idle") return;
    event.preventDefault();
    onAnswer(choice);
  };

  const enter = (delayMs: number) => ({
    initial: { opacity: 0, y: reduce ? 0 : CARD_RISE_PX },
    animate: { opacity: 1, y: 0 },
    transition: reduce
      ? { ...transitions.fade, delay: seconds(delayMs) }
      : { duration: seconds(DURATION_MS.base), ease: EASING.emphasized, delay: seconds(delayMs) },
  });

  return (
    <OverlayFrame testId="overlay-question">
      <m.div {...enter(0)}>
        <QuestionCard
          prompt={question.prompt}
          media={question.media}
          timer={{
            runId,
            remainingMs: Math.max(0, question.deadline - now),
            durationMs: question.deadline - question.startsAt,
          }}
        />
      </m.div>
      <fieldset
        ref={groupRef}
        aria-label={de.game.questionProgress(question.index, question.total)}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="min-w-0 mt-4 flex flex-col gap-4 outline-none"
      >
        {ANSWER_INDEXES.map((choice) => (
          <m.div key={choice} {...enter(DURATION_MS.base + choice * STAGGER_MS.list)}>
            <AnswerButton
              index={choice}
              text={question.answers[choice]}
              state={states[choice] ?? "disabled"}
              onSelect={() => select(choice)}
              data-testid={`answer-${choice}`}
            />
          </m.div>
        ))}
      </fieldset>
      <p
        aria-live="polite"
        data-testid="question-waiting"
        className="mt-4 min-h-4 text-center text-caption text-text-2"
      >
        {myChoice !== null && waitingCount > 0 ? de.game.waitingForOthers(waitingCount) : ""}
      </p>
    </OverlayFrame>
  );
}
