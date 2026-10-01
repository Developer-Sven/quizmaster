"use client";

import { ANSWER_INDEXES, type PublicPlayer, type PublicQuestion } from "@quizmaster/shared";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { AnswerButton } from "@/components/ui/answer-button";
import { QuestionCard } from "@/components/ui/question-card";
import { de } from "@/i18n/de";
import { missedAnswer, pickersByAnswer, revealAnswerStates } from "@/lib/client/game-view";
import { ANSWER_REVEAL_EXIT_AT_MS } from "@/lib/client/phase-clock";
import { useServerNow } from "@/lib/client/use-server-clock";
import { TimerIcon } from "@/lib/ui/icons";
import { transitions } from "@/lib/ui/motion-presets";
import { OverlayFrame } from "./overlay-frame";

export interface AnswerRevealOverlayProps {
  /** aufgelöste Frage (mit `correct` und `picks`, erst ab Phase `reveal`) */
  question: PublicQuestion;
  players: readonly PublicPlayer[];
  selfId: string | null;
  phaseStartedAt: number;
}

/**
 * Auflösung (Phase `reveal`, 3,5 s, docs/09 §7.6): richtige Antwort `correct`, eigene falsche `wrong`
 * mit kurzem Ruck, ab 200 ms Avatare an den gewählten Antworten (max. 4, dann „+3“); ohne eigene Antwort
 * „Zeit abgelaufen“ über der Karte. Das „+1“ zeigt der Spielerstreifen (ScorePill). Ausblenden bei 3.000 ms.
 */
export function AnswerRevealOverlay({ question, players, selfId, phaseStartedAt }: AnswerRevealOverlayProps) {
  const exitAt = phaseStartedAt + ANSWER_REVEAL_EXIT_AT_MS;
  const now = useServerNow([exitAt]);
  const visible = now < exitAt;
  const picks = question.picks;
  const myPick = selfId !== null && picks ? (picks[selfId] ?? null) : null;
  const states = revealAnswerStates(question.correct, myPick);
  const pickers = pickersByAnswer(picks, players);
  const missed = missedAnswer(picks, selfId);

  return (
    <OverlayFrame testId="overlay-answer-reveal">
      <AnimatePresence initial={false}>
        {visible ? (
          <m.div key="reveal" exit={{ opacity: 0, transition: transitions.exit }} className="flex flex-col">
            {missed ? (
              <p
                data-testid="reveal-time-up"
                className="flex items-center justify-center gap-2 pb-3 text-label text-text-2"
              >
                <TimerIcon size={16} className="shrink-0" />
                {de.game.timeUp}
              </p>
            ) : null}
            <QuestionCard prompt={question.prompt} media={question.media} timer={null} />
            <div className="mt-4 flex flex-col gap-4">
              {ANSWER_INDEXES.map((choice) => (
                <AnswerButton
                  key={choice}
                  index={choice}
                  text={question.answers[choice]}
                  state={states[choice] ?? "dimmed"}
                  shake={states[choice] === "wrong"}
                  pickedBy={pickers[choice] ?? []}
                  data-testid={`answer-${choice}`}
                  data-state={states[choice]}
                />
              ))}
            </div>
          </m.div>
        ) : null}
      </AnimatePresence>
    </OverlayFrame>
  );
}
