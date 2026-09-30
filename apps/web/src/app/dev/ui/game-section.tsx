"use client";

import { useState } from "react";
import { AnswerButton, type AnswerState } from "../../../components/ui/answer-button";
import { Board, type BoardPlayer, type BoardRowData } from "../../../components/ui/board";
import { Button } from "../../../components/ui/button";
import { CategoryBadge } from "../../../components/ui/category-badge";
import { CategoryTile } from "../../../components/ui/category-tile";
import { QuestionCard } from "../../../components/ui/question-card";
import { ResultSquare } from "../../../components/ui/result-square";
import { TimerBar } from "../../../components/ui/timer-bar";
import { TimerRing } from "../../../components/ui/timer-ring";
import { de } from "../../../i18n/de";
import { LONGEST_ANSWER, LONGEST_QUESTION, SHORT_QUESTION, sampleCategory, samplePlayer } from "./sample-data";
import { ComponentTitle, Demo, Section } from "./section";

const ANSWER_STATES: ReadonlyArray<readonly [AnswerState, string]> = [
  ["idle", "idle"],
  ["locked", "locked (eingeloggt)"],
  ["dimmed", "dimmed"],
  ["correct", "correct"],
  ["wrong", "wrong"],
  ["disabled", "disabled"],
];

const BOARD_ROWS: readonly BoardRowData[] = [
  {
    key: "r1-p1",
    category: sampleCategory(0),
    results: { p1: [true, true, false], p2: [true, false, false], p3: [false, null, true] },
  },
  {
    key: "r1-p2",
    category: sampleCategory(13),
    results: { p1: [true, true, true], p2: [false, true, true], p3: [true, true, false] },
  },
  {
    key: "r1-p3",
    category: sampleCategory(8),
    results: { p1: [true], p2: [false], p3: [] },
  },
];

function boardPlayers(count: number): BoardPlayer[] {
  return Array.from({ length: count }, (_, index) => {
    const player = samplePlayer(index);
    return {
      ...player,
      score: 12 - index,
      rankChange: index === 1 ? "up" : index === 2 ? "down" : null,
      resigned: index === 7,
    };
  });
}

/** Kategorie-, Frage-, Timer- und Tafel-Komponenten in allen Zuständen. */
export function GameSection() {
  const [timerRun, setTimerRun] = useState(0);
  const [shakeRun, setShakeRun] = useState(0);
  const [boardRun, setBoardRun] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const pickers = [
    samplePlayer(1),
    samplePlayer(2),
    samplePlayer(3),
    samplePlayer(4),
    samplePlayer(5),
    samplePlayer(6),
  ];

  return (
    <Section id="game" title="Spiel">
      <ComponentTitle>CategoryBadge</ComponentTitle>
      <div className="flex flex-wrap items-center gap-3">
        <Demo label="normal">
          <CategoryBadge category={sampleCategory(12)} />
        </Demo>
        <Demo label="kompakt">
          <CategoryBadge category={sampleCategory(12)} compact />
        </Demo>
      </div>

      <ComponentTitle>CategoryTile</ComponentTitle>
      <div className="flex flex-col gap-3">
        {[0, 5, 16].map((index, position) => (
          <CategoryTile
            key={index}
            category={sampleCategory(index)}
            selected={picked === position}
            onSelect={() => setPicked(position)}
            shortcut={String(position + 1)}
          />
        ))}
      </div>
      <Demo label="pressed · selected · hervorgehoben (Zuschauende) · view-only">
        <div className="flex flex-col gap-3">
          <CategoryTile category={sampleCategory(9)} data-force="pressed" />
          <CategoryTile category={sampleCategory(10)} selected />
          <CategoryTile category={sampleCategory(11)} viewOnly highlighted />
          <CategoryTile category={sampleCategory(12)} viewOnly />
        </div>
      </Demo>

      <ComponentTitle>QuestionCard und TimerBar</ComponentTitle>
      <QuestionCard key={`q-${timerRun}`} prompt={SHORT_QUESTION} timer={{ remainingMs: 20_000, durationMs: 20_000 }} />
      <Demo label="lange Frage (140 Zeichen, question-long) · letzte 5 s rot">
        <QuestionCard
          key={`l-${timerRun}`}
          prompt={LONGEST_QUESTION}
          timer={{ remainingMs: 7_000, durationMs: 20_000 }}
        />
      </Demo>
      <Demo label="Bildfrage (Flagge) · Timer abgelaufen">
        <QuestionCard
          prompt="Zu welchem Land gehört diese Flagge?"
          media={{ kind: "flag", code: "de" }}
          timer={{ remainingMs: 0, durationMs: 20_000 }}
        />
      </Demo>
      <Demo label="TimerBar einzeln (läuft)">
        <TimerBar key={`b-${timerRun}`} remainingMs={12_000} durationMs={20_000} announce={false} />
      </Demo>

      <ComponentTitle>TimerRing</ComponentTitle>
      <div className="flex flex-wrap items-center gap-6">
        <Demo label="läuft (15 s)">
          <TimerRing key={`r-${timerRun}`} remainingMs={15_000} durationMs={15_000} />
        </Demo>
        <Demo label="letzte 5 s">
          <TimerRing key={`d-${timerRun}`} remainingMs={4_500} durationMs={15_000} announce={false} />
        </Demo>
        <Demo label="abgelaufen">
          <TimerRing remainingMs={0} durationMs={15_000} />
        </Demo>
      </div>
      <Button variant="ghost" size="compact" onClick={() => setTimerRun((run) => run + 1)}>
        Timer neu starten
      </Button>

      <ComponentTitle>AnswerButton</ComponentTitle>
      <div className="flex flex-col gap-4">
        {ANSWER_STATES.map(([state, label], index) => (
          <Demo key={state} label={label}>
            <AnswerButton
              index={(index % 4) as 0 | 1 | 2 | 3}
              text={index === 0 ? LONGEST_ANSWER : "Canberra"}
              state={state}
            />
          </Demo>
        ))}
        <Demo label="pressed">
          <AnswerButton index={1} text="Sydney" data-force="pressed" />
        </Demo>
        <Demo label="Auflösung: eigene falsche Antwort mit Ruck, Avatare der Wählenden">
          <div className="flex flex-col gap-4 pb-3">
            <AnswerButton index={0} text="Canberra" state="correct" pickedBy={pickers} key={`c-${shakeRun}`} />
            <AnswerButton
              index={1}
              text="Sydney"
              state="wrong"
              shake
              pickedBy={[samplePlayer(0)]}
              key={`w-${shakeRun}`}
            />
          </div>
        </Demo>
      </div>
      <Button variant="ghost" size="compact" onClick={() => setShakeRun((run) => run + 1)}>
        Auflösung wiederholen
      </Button>

      <ComponentTitle>ResultSquare</ComponentTitle>
      <div className="flex flex-wrap items-center gap-6">
        <Demo label={de.a11y.resultCorrect}>
          <ResultSquare result="correct" />
        </Demo>
        <Demo label={de.a11y.resultWrong}>
          <ResultSquare result="wrong" />
        </Demo>
        <Demo label={de.a11y.resultOpen}>
          <ResultSquare result="open" />
        </Demo>
        <Demo label={de.a11y.resultNone}>
          <ResultSquare result="none" />
        </Demo>
      </div>

      <ComponentTitle>Board</ComponentTitle>
      <Demo label="3 Personen · neueste Zeile füllt sich animiert">
        <Board
          key={`b3-${boardRun}`}
          players={boardPlayers(3)}
          rows={BOARD_ROWS}
          questionsPerTurn={3}
          animateFromRow={2}
        />
      </Demo>
      <Demo label="8 Personen · horizontal scrollbar, erste Spalte fixiert">
        <Board players={boardPlayers(8)} rows={BOARD_ROWS} questionsPerTurn={3} label="Spieltafel mit 8 Personen" />
      </Demo>
      <Button variant="ghost" size="compact" onClick={() => setBoardRun((run) => run + 1)}>
        Zeile neu füllen
      </Button>
    </Section>
  );
}
