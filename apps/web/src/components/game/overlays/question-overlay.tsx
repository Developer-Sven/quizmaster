"use client";

import { ANSWER_INDEXES, type AnswerIndex, type PublicQuestion } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { AnswerButton } from "@/components/ui/answer-button";
import { QuestionCard } from "@/components/ui/question-card";
import { de } from "@/i18n/de";
import { questionAnswerStates } from "@/lib/client/game-view";
import { answerShortcut, claimGroupFocus, readShortcutGuard } from "@/lib/client/keyboard";
import { CHOREOGRAPHY, enterMotion } from "../choreography";
import { useOverlayClock, useTimerRun } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";

export interface QuestionOverlayProps {
  question: PublicQuestion;
  /** eigene (eingeloggte) Antwort oder `null` */
  myChoice: AnswerIndex | null;
  /** darf diese Person antworten? (aktiv im Spiel) */
  canAnswer: boolean;
  /** verbundene aktive Personen, die noch antworten müssen (ohne die eigene) */
  waitingCount: number;
  /** Identität des Timer-Laufs, z. B. `${question.id}:${syncGeneration}` – neu → TimerBar mit frischer Restzeit */
  runId: string;
  onAnswer: (choice: AnswerIndex) => void;
}

const QUESTION = CHOREOGRAPHY.question;

/**
 * Frage (Phase `question` ab `startsAt`, 20 s, docs/09 §7.4–5): `QuestionCard` fährt 16 px von unten ein
 * (200 ms), die Antworten folgen gestaffelt (40 ms); die `TimerBar` läuft als CSS über die Restzeit bis
 * `deadline` (ab 5 s Rest rot, dazu `tick` je Sekunde – Cues der Bühne). Tippen loggt sofort ein: getippte
 * Antwort `locked`, übrige `dimmed` (Ton `lock`, Haptik 15 ms im Handler der Bühne), darunter live
 * „Warte auf 2 weitere …“. Nach der Deadline nicht mehr bedienbar.
 * Tastatur: `1`–`4`/`A`–`D`, solange der Fokus in der Antwortgruppe liegt (WCAG 2.1.4, lib/client/keyboard.ts);
 * die Gruppe übernimmt beim Öffnen den Fokus, wenn er frei ist.
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
  const { now, enteredAt } = useOverlayClock(question.startsAt, [question.deadline]);
  const timer = useTimerRun(question.deadline, runId);
  const expired = now >= question.deadline;
  const states = questionAnswerStates(myChoice, canAnswer && !expired);
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const open = canAnswer && myChoice === null && !expired;

  useEffect(() => {
    const group = groupRef.current;
    if (open && group) claimGroupFocus(group, group.closest("[data-stage]"));
  }, [open]);

  const select = (choice: AnswerIndex) => {
    if (states[choice] === "idle") onAnswer(choice);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const choice = answerShortcut(event, readShortcutGuard(event.currentTarget));
    if (choice === null || states[choice] !== "idle") return;
    event.preventDefault();
    onAnswer(choice);
  };

  const card = enterMotion(
    { at: 0, duration: QUESTION.cardMs, from: { opacity: 0, y: QUESTION.cardRisePx } },
    enteredAt,
    reduce,
  );
  const answer = (choice: AnswerIndex) =>
    enterMotion(
      {
        at: QUESTION.answersAtMs + choice * QUESTION.answerStaggerMs,
        duration: QUESTION.answerMs,
        from: { opacity: 0, y: QUESTION.cardRisePx },
      },
      enteredAt,
      reduce,
    );

  return (
    <OverlayFrame testId="overlay-question">
      <m.div {...card}>
        <QuestionCard
          prompt={question.prompt}
          media={question.media}
          timer={{
            runId: timer.runId,
            remainingMs: timer.remainingMs ?? 0,
            durationMs: question.deadline - question.startsAt,
          }}
        />
      </m.div>
      <fieldset
        ref={groupRef}
        aria-label={de.game.questionProgress(question.index, question.total)}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="mt-4 flex min-w-0 flex-col gap-4 rounded-lg"
      >
        {ANSWER_INDEXES.map((choice) => (
          <m.div key={choice} {...answer(choice)}>
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
