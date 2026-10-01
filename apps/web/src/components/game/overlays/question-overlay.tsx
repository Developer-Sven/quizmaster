"use client";

import { ANSWER_INDEXES, type AnswerIndex, type PublicQuestion } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type KeyboardEvent, useEffect, useEffectEvent, useId, useRef } from "react";
import { de } from "../../../i18n/de";
import { questionAnswerStates } from "../../../lib/client/game-view";
import { answerShortcut, claimGroupFocus, readShortcutGuard } from "../../../lib/client/keyboard";
import { cx } from "../../../lib/ui/cx";
import { selectConnectionOverlayVisible, useGameStore } from "../../../stores/game-store";
import { AnswerButton } from "../../ui/answer-button";
import { QuestionCard } from "../../ui/question-card";
import { CHOREOGRAPHY, enterMotion } from "../choreography";
import { useKeyboardModality, useOverlayClock, useTimerRun } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";
import { StatusLine } from "./status-line";

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
  /**
   * Die Antwortgruppe konnte den Fokus nicht übernehmen (er liegt z. B. im HUD): Dann liest kein Screenreader
   * die Frage beim Öffnen – die Bühne sagt sie über die Live-Region des HUD an.
   */
  onPromptUnfocused?: (questionId: string) => void;
}

const QUESTION = CHOREOGRAPHY.question;

/**
 * Frage (Phase `question` ab `startsAt`, 20 s, docs/09 §7.4–5): `QuestionCard` fährt 16 px von unten ein
 * (200 ms), die Antworten folgen gestaffelt (40 ms); die `TimerBar` läuft als CSS über die Restzeit bis
 * `deadline` (ab 5 s Rest rot, dazu `tick` je Sekunde – Cues der Bühne). Tippen loggt sofort ein: getippte
 * Antwort `locked`, übrige `dimmed` (Ton `lock`, Haptik 15 ms im Handler der Bühne), in der Statuszeile unter der
 * Karte live „Warte auf 2 weitere …“ (ADR-034: Zeile immer reserviert und mit der Auflösung geteilt – dort steht
 * „Zeit abgelaufen“; Karte und Antworten springen nicht). Nach der Deadline nicht mehr bedienbar.
 *
 * Screenreader (WCAG 1.3.1, 4.1.2): Die Antwortgruppe heißt wie die Frage und ist mit „Frage 2 von 3“
 * beschrieben; darüber steht dieselbe Angabe als Überschrift (nur Screenreader). Die Gruppe übernimmt beim
 * Öffnen den Fokus, wenn er frei ist – Screenreader lesen so die Frage; sonst sagt das HUD sie an.
 * Tastatur: `1`–`4`/`A`–`D`, solange der Fokus in der Antwortgruppe liegt (WCAG 2.1.4, lib/client/keyboard.ts).
 * Der Fokusring der Gruppe erscheint nur nach Bedienung per Tastatur und nur, solange sie bedienbar ist.
 */
export function QuestionOverlay({
  question,
  myChoice,
  canAnswer,
  waitingCount,
  runId,
  onAnswer,
  onPromptUnfocused,
}: QuestionOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const { now, enteredAt } = useOverlayClock(question.startsAt, [question.deadline]);
  const timer = useTimerRun(question.deadline, runId);
  const expired = now >= question.deadline;
  const states = questionAnswerStates(myChoice, canAnswer && !expired);
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const open = canAnswer && myChoice === null && !expired;
  const keyboard = useKeyboardModality();
  // Solange das Verbindungs-Overlay steht, ist die Bühne inert; danach wird der Fokus erneut übernommen.
  const connectionLost = useGameStore(selectConnectionOverlayVisible);
  const promptId = useId();
  const headingId = useId();
  const reportUnfocused = useEffectEvent(() => onPromptUnfocused?.(question.id));

  useEffect(() => {
    const group = groupRef.current;
    if (!open || connectionLost || !group) return;
    if (!claimGroupFocus(group, group.closest("[data-stage]"))) reportUnfocused();
  }, [open, connectionLost]);

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
      <h2 id={headingId} className="sr-only">
        {de.game.questionHeading(question.index, question.total)}
      </h2>
      {/* Name der Antwortgruppe: der Fragetext (sichtbar steht er in der Karte; ausgeblendet, nie doppelt gelesen) */}
      <span id={promptId} hidden>
        {question.prompt}
      </span>
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
      <StatusLine live testId="question-waiting">
        {myChoice !== null && waitingCount > 0 ? de.game.waitingForOthers(waitingCount) : ""}
      </StatusLine>
      <fieldset
        ref={groupRef}
        aria-labelledby={promptId}
        aria-describedby={headingId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx(
          "mt-2 flex min-w-0 flex-col gap-4 rounded-lg",
          // Ring nur als Tastatur-Hinweis auf eine bedienbare Gruppe – nie als zweiter oranger Rahmen
          !(open && keyboard) && "focus-visible:outline-hidden",
        )}
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
    </OverlayFrame>
  );
}
