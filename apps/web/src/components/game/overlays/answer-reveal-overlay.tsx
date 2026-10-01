"use client";

import { ANSWER_INDEXES, type PublicPlayer, type PublicQuestion } from "@quizmaster/shared";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useId } from "react";
import { de } from "../../../i18n/de";
import { missedAnswer, pickersByAnswer, revealAnswerStates } from "../../../lib/client/game-view";
import { cx } from "../../../lib/ui/cx";
import { TimerIcon } from "../../../lib/ui/icons";
import { AnswerButton } from "../../ui/answer-button";
import { QuestionCard } from "../../ui/question-card";
import { CHOREOGRAPHY, enterMotion, momentAhead, motionPlan, overlayLeaveAt } from "../choreography";
import { useOverlayClock } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";

export interface AnswerRevealOverlayProps {
  /** aufgelöste Frage (mit `correct` und `picks`, erst ab Phase `reveal`) */
  question: PublicQuestion;
  players: readonly PublicPlayer[];
  selfId: string | null;
  /** Serverzeit des Phasenbeginns – Anker der Choreografie */
  phaseStartedAt: number;
}

const REVEAL = CHOREOGRAPHY.answerReveal;

/** Der Ruck startet bei 0 ms; wer später einsteigt (Reconnect), sieht ihn nicht mehr nachgeholt. */
const SHAKE_LATE_MS = 120;

/**
 * Auflösung (Phase `reveal`, 3,5 s, docs/09 §7.6) – die Karte der Frage bleibt stehen (Übergang „cut“):
 * 0 ms richtige Antwort `correct`, eigene falsche `wrong` mit Seitwärtsruck (2 × 4 px, 160 ms – nur bei
 * eigener falscher Antwort, nicht bei reduzierter Bewegung); ab 200 ms gleiten die Avatare 24 px gestaffelt
 * (50 ms) an die gewählten Antworten (max. 4, dann „+3“). Das „+1“ zeigt ab 400 ms der Spielerstreifen
 * (ScorePill), Ton und Haptik kommen als Cues der Bühne. Ohne eigene Antwort „Zeit abgelaufen“ über der Karte.
 * Ausblenden bei 3.000 ms. Wer erst mitten in der Auflösung einsteigt, sieht den Endzustand ohne Wiederholung.
 *
 * Gleiche Lage wie die Frage: Unter der Karte bleibt die Statuszeile der Frage frei (leer), damit Karte und
 * Antworten beim „cut“ stehen bleiben; die Antworten sind wie dort eine Gruppe mit dem Fragetext als Namen.
 */
export function AnswerRevealOverlay({ question, players, selfId, phaseStartedAt }: AnswerRevealOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const promptId = useId();
  const headingId = useId();
  const leaveAt = overlayLeaveAt("answer_reveal", { phaseStartedAt, question }) ?? phaseStartedAt;
  const { now, enteredAt } = useOverlayClock(phaseStartedAt, [leaveAt]);
  const picks = question.picks;
  const myPick = selfId !== null && picks ? (picks[selfId] ?? null) : null;
  const states = revealAnswerStates(question.correct, myPick);
  const pickers = pickersByAnswer(picks, players);
  const missed = missedAnswer(picks, selfId);
  const shake = motionPlan(reduce).shake && momentAhead(0, enteredAt, SHAKE_LATE_MS);
  // Avatare an den Antworten gleiten ab 200 ms ein – nach einem späten Einstieg stehen sie sofort da.
  const pickersFresh = momentAhead(REVEAL.pickersAtMs, enteredAt, 0);
  const hint = enterMotion({ at: 0, duration: REVEAL.pickersAtMs, from: { opacity: 0 } }, enteredAt, reduce);

  return (
    <OverlayFrame testId="overlay-answer-reveal" leaving={now >= leaveAt}>
      <h2 id={headingId} className="sr-only">
        {de.game.questionHeading(question.index, question.total)}
      </h2>
      <span id={promptId} hidden>
        {question.prompt}
      </span>
      <div className="flex flex-col">
        {missed ? (
          <m.p
            {...hint}
            data-testid="reveal-time-up"
            className="flex items-center justify-center gap-2 pb-3 text-label text-text-2"
          >
            <TimerIcon size={16} className="shrink-0" />
            {de.game.timeUp}
          </m.p>
        ) : null}
        <QuestionCard prompt={question.prompt} media={question.media} timer={null} />
        {/* Platz der Statuszeile der Frage (mt-1 + 16 px): Die Antworten stehen genau wie in der Frage. Mit
            „Zeit abgelaufen“ über der Karte (docs/09 §7.6) entfällt er – die Antworten rücken so nicht weiter. */}
        {missed ? null : <div aria-hidden="true" className="mt-1 min-h-4" />}
        {/* initial={false} blockiert die Einblendungen darin (Avatare an den Antworten) beim späten Einstieg */}
        <AnimatePresence initial={pickersFresh}>
          <fieldset
            key="answers"
            aria-labelledby={promptId}
            aria-describedby={headingId}
            className={cx("flex min-w-0 flex-col gap-4", missed ? "mt-4" : "mt-2")}
          >
            {ANSWER_INDEXES.map((choice) => (
              <AnswerButton
                key={choice}
                index={choice}
                text={question.answers[choice]}
                state={states[choice] ?? "dimmed"}
                shake={shake && states[choice] === "wrong"}
                pickedBy={pickers[choice] ?? []}
                data-testid={`answer-${choice}`}
                data-state={states[choice]}
              />
            ))}
          </fieldset>
        </AnimatePresence>
      </div>
    </OverlayFrame>
  );
}
