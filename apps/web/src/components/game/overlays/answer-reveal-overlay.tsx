"use client";

import { ANSWER_INDEXES, type PublicPlayer, type PublicQuestion } from "@quizmaster/shared";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useId } from "react";
import { de } from "../../../i18n/de";
import { missedAnswer, pickersByAnswer, revealAnswerStates } from "../../../lib/client/game-view";
import { TimerIcon } from "../../../lib/ui/icons";
import { AnswerButton } from "../../ui/answer-button";
import { QuestionCard } from "../../ui/question-card";
import {
  answerRevealPickerMotion,
  CHOREOGRAPHY,
  enterMotion,
  momentAhead,
  motionPlan,
  overlayLeaveAt,
} from "../choreography";
import { useOverlayClock } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";
import { StatusLine } from "./status-line";

export interface AnswerRevealOverlayProps {
  /** aufgelöste Frage (mit `correct` und `picks`, erst ab Phase `reveal`) */
  question: PublicQuestion;
  players: readonly PublicPlayer[];
  selfId: string | null;
  /** Serverzeit des Phasenbeginns – Anker der Choreografie */
  phaseStartedAt: number;
  /** Serverzeit des Phasenendes; `null` = wartet auf „Weiter“ des Hosts (ADR-045) */
  phaseEndsAt: number | null;
}

const REVEAL = CHOREOGRAPHY.answerReveal;

/** Der Ruck startet bei 0 ms; wer später einsteigt (Reconnect), sieht ihn nicht mehr nachgeholt. */
const SHAKE_LATE_MS = 120;

/**
 * Auflösung (Phase `reveal`, 3,5 s, docs/09 §7.6) – die Karte der Frage bleibt stehen (Übergang „cut“):
 * 0 ms richtige Antwort `correct`, eigene falsche `wrong` mit Seitwärtsruck (2 × 4 px, 160 ms – nur bei
 * eigener falscher Antwort, nicht bei reduzierter Bewegung); ab 500 ms gleiten die Avatare 24 px gestaffelt
 * (150 ms, je 480 ms) an die gewählten Antworten (max. 4, dann „+3“). Das „+1“ zeigt ab 1.200 ms der Spielerstreifen
 * (ScorePill), Ton und Haptik kommen als Cues der Bühne. Ausblenden 500 ms vor dem Phasenende (wartet die
 * Auflösung auf den Host, bleibt sie stehen – ADR-045). Wer erst mitten in der
 * Auflösung einsteigt, sieht den Endzustand ohne Wiederholung.
 *
 * Gleiche Lage wie die Frage (ADR-034): derselbe Aufbau – Karte, Statuszeile unter der Karte, Antwortgruppe mit
 * dem Fragetext als Namen. Ohne eigene Antwort steht „Zeit abgelaufen“ (`timer`-Icon) in genau dieser Statuszeile
 * (dort, wo in der Frage „Warte auf …“ stand), sonst bleibt sie leer. Karte und Antworten stehen beim „cut“ still.
 */
export function AnswerRevealOverlay({
  question,
  players,
  selfId,
  phaseStartedAt,
  phaseEndsAt,
}: AnswerRevealOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const promptId = useId();
  const headingId = useId();
  const leaveAt = overlayLeaveAt("answer_reveal", { phaseStartedAt, phaseEndsAt, question });
  const { now, enteredAt } = useOverlayClock(phaseStartedAt, leaveAt === null ? [] : [leaveAt]);
  const picks = question.picks;
  const myPick = selfId !== null && picks ? (picks[selfId] ?? null) : null;
  const states = revealAnswerStates(question.correct, myPick);
  const pickers = pickersByAnswer(picks, players);
  const missed = missedAnswer(picks, selfId);
  const shake = motionPlan(reduce).shake && momentAhead(0, enteredAt, SHAKE_LATE_MS);
  // Avatare an den Antworten gleiten ab 500 ms ein (relativ zum Phasenbeginn) – nach einem späten Einstieg stehen
  // sie sofort da.
  const pickersFresh = momentAhead(REVEAL.pickersAtMs, enteredAt, 0);
  const pickerMotion = (position: number) => answerRevealPickerMotion(position, enteredAt, reduce);
  const hint = enterMotion({ at: 0, duration: REVEAL.pickersAtMs, from: { opacity: 0 } }, enteredAt, reduce);

  return (
    <OverlayFrame testId="overlay-answer-reveal" leaving={leaveAt !== null && now >= leaveAt}>
      <h2 id={headingId} className="sr-only">
        {de.game.questionHeading(question.index, question.total)}
      </h2>
      <span id={promptId} hidden>
        {question.prompt}
      </span>
      {/* Aufbau wie in der Frage (question-overlay.tsx): Karte, Statuszeile, Antwortgruppe – gleiche Lage */}
      <div>
        <QuestionCard prompt={question.prompt} media={question.media} timer={null} />
      </div>
      <StatusLine testId="reveal-status">
        {missed ? (
          <m.span {...hint} data-testid="reveal-time-up" className="flex items-center justify-center gap-1">
            <TimerIcon size={16} aria-hidden="true" className="shrink-0" />
            {de.game.timeUp}
          </m.span>
        ) : null}
      </StatusLine>
      {/* initial={false} blockiert die Einblendungen darin (Avatare an den Antworten) beim späten Einstieg */}
      <AnimatePresence initial={pickersFresh}>
        <fieldset
          key="answers"
          aria-labelledby={promptId}
          aria-describedby={headingId}
          className="mt-2 flex min-w-0 flex-col gap-4"
        >
          {ANSWER_INDEXES.map((choice) => (
            <AnswerButton
              key={choice}
              index={choice}
              text={question.answers[choice]}
              state={states[choice] ?? "dimmed"}
              shake={shake && states[choice] === "wrong"}
              pickedBy={pickers[choice] ?? []}
              pickerMotion={pickerMotion}
              data-testid={`answer-${choice}`}
              data-state={states[choice]}
            />
          ))}
        </fieldset>
      </AnimatePresence>
    </OverlayFrame>
  );
}
