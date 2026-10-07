"use client";

import type { AnswerIndex, PrivatePlayerState, PublicLobbyState } from "@quizmaster/shared";
import { AnimatePresence } from "motion/react";
import dynamic from "next/dynamic";
import { useState } from "react";
import {
  answerWaitingCount,
  type CategoryCatalog,
  categoryVisual,
  currentTurnRow,
  findPlayer,
  gameParticipants,
  myChoiceFor,
  summarizeTurn,
} from "@/lib/client/game-view";
import type { StageKind } from "@/lib/client/phase-clock";
import { MotionProvider } from "@/lib/ui/motion";
import type { PendingAnswer, PendingPick } from "@/stores/game-store";
import { stageTransition } from "./choreography";
import type { GameOverOverlayProps } from "./overlays/game-over-overlay";
import { loadOverlay, preloadedOverlays } from "./overlays/loaders";

// Overlays in eigenen Chunks (docs/07) – über dieselben Loader, die preloadOverlays() beim Betreten der Lobby
// aufruft (ein Chunk je Overlay, im Spiel wird nichts nachgeladen). Ist ein Modul schon vorgeladen, rendert
// die Bühne es synchron (siehe `preloadedOverlays`), sonst greift `dynamic()`.
const IntroOverlayLazy = dynamic(() => loadOverlay("intro").then((mod) => mod.IntroOverlay), { ssr: false });
const CategoryPickOverlayLazy = dynamic(() => loadOverlay("categoryPick").then((mod) => mod.CategoryPickOverlay), {
  ssr: false,
});
const CategoryRevealOverlayLazy = dynamic(
  () => loadOverlay("categoryReveal").then((mod) => mod.CategoryRevealOverlay),
  { ssr: false },
);
const QuestionOverlayLazy = dynamic(() => loadOverlay("question").then((mod) => mod.QuestionOverlay), {
  ssr: false,
});
const AnswerRevealOverlayLazy = dynamic(() => loadOverlay("answerReveal").then((mod) => mod.AnswerRevealOverlay), {
  ssr: false,
});
const TurnSummaryOverlayLazy = dynamic(() => loadOverlay("turnSummary").then((mod) => mod.TurnSummaryOverlay), {
  ssr: false,
});
const RoundBoardOverlayLazy = dynamic(() => loadOverlay("roundBoard").then((mod) => mod.RoundBoardOverlay), {
  ssr: false,
});
const GameOverOverlayLazy = dynamic(() => loadOverlay("gameOver").then((mod) => mod.GameOverOverlay), {
  ssr: false,
});

export interface StageProps {
  /** was die Bühne gerade zeigt (`stageAt` aus Phase und Serverzeit) */
  kind: StageKind;
  lobby: PublicLobbyState;
  self: PrivatePlayerState | null;
  categories: CategoryCatalog;
  pendingAnswer: PendingAnswer | null;
  pendingPick: PendingPick | null;
  /** zählt Wiederaufnahmen – Timer starten danach mit der Restzeit neu */
  syncGeneration: number;
  onPick: (categoryId: string) => void;
  onAnswer: (questionId: string, choice: AnswerIndex) => void;
  /** Die Antwortgruppe einer Frage bekam den Fokus nicht – die Frage wird angesagt (QuestionOverlay) */
  onPromptUnfocused?: (questionId: string) => void;
}

/**
 * Die Bühne (docs/09 §7): zeigt je nach Phase und Serverzeit genau ein Overlay. Übergänge innerhalb einer
 * Phase (Kategorie-Einblendung → Frage ab `startsAt`) passieren zum Serverzeitpunkt – für alle gleichzeitig.
 *
 * Ein Overlay bleibt eingehängt, solange seine Phase (bzw. Frage) läuft – auch über eine Wiederaufnahme hinweg:
 * Nach einem Reconnect wird nichts wiederholt; nur Timer starten mit der Restzeit neu (`syncGeneration` in
 * ihrer Lauf-ID). Ein Overlay, das erst mitten in seiner Phase erscheint, setzt die Choreografie an der
 * richtigen Stelle fort (choreography.ts). Von der Frage in die Auflösung gibt es kein Aus-/Einblenden („cut“).
 *
 * Das Spielende zeigt nicht die Bühne, sondern {@link GameOverStage} über Streifen und Bühne (game-screen.tsx):
 * Beim Wechsel ändert sich so kein Layout unter dem ausblendenden Overlay (kein Layout-Sprung, CLS).
 */
export function Stage(props: StageProps) {
  const { kind, lobby } = props;
  const key = `${kind}:${lobby.phaseStartedAt}:${lobby.question?.id ?? ""}`;
  return (
    <MotionProvider>
      <AnimatePresence custom={stageTransition(kind)}>
        <StageOverlay key={key} {...props} />
      </AnimatePresence>
    </MotionProvider>
  );
}

function StageOverlay({
  kind,
  lobby,
  self,
  categories,
  pendingAnswer,
  pendingPick,
  syncGeneration,
  onPick,
  onAnswer,
  onPromptUnfocused,
}: StageProps) {
  // Je Overlay einmal beim Einhängen entschieden: vorgeladenes Modul synchron oder `dynamic()` (nie ein Wechsel
  // mitten im Overlay – das würde es neu einhängen und die Choreografie wiederholen).
  const [modules] = useState(preloadedOverlays);
  const IntroOverlay = modules.intro?.IntroOverlay ?? IntroOverlayLazy;
  const CategoryPickOverlay = modules.categoryPick?.CategoryPickOverlay ?? CategoryPickOverlayLazy;
  const CategoryRevealOverlay = modules.categoryReveal?.CategoryRevealOverlay ?? CategoryRevealOverlayLazy;
  const QuestionOverlay = modules.question?.QuestionOverlay ?? QuestionOverlayLazy;
  const AnswerRevealOverlay = modules.answerReveal?.AnswerRevealOverlay ?? AnswerRevealOverlayLazy;
  const TurnSummaryOverlay = modules.turnSummary?.TurnSummaryOverlay ?? TurnSummaryOverlayLazy;
  const RoundBoardOverlay = modules.roundBoard?.RoundBoardOverlay ?? RoundBoardOverlayLazy;
  const selfId = self?.playerId ?? null;
  const selfPlayer = findPlayer(lobby.players, selfId);
  const question = lobby.question;
  const turn = lobby.turn;

  switch (kind) {
    case "intro":
      return (
        <IntroOverlay
          players={gameParticipants(lobby)}
          phaseStartedAt={lobby.phaseStartedAt}
          round={lobby.progress?.round ?? 1}
        />
      );
    case "category_pick": {
      if (!turn) return null;
      const ownPick = pendingPick?.phaseStartedAt === lobby.phaseStartedAt ? pendingPick.categoryId : null;
      return (
        <CategoryPickOverlay
          options={turn.options}
          picker={findPlayer(lobby.players, turn.pickerId)}
          isPicker={selfId !== null && turn.pickerId === selfId}
          canPick={self?.canPick === true}
          pickedId={turn.categoryId ?? ownPick}
          phaseStartedAt={lobby.phaseStartedAt}
          phaseEndsAt={lobby.phaseEndsAt}
          timerRunId={`${lobby.phaseStartedAt}:${syncGeneration}`}
          onPick={onPick}
        />
      );
    }
    case "category_reveal":
      if (!question) return null;
      return (
        <CategoryRevealOverlay
          category={categoryVisual(categories, question.categoryId)}
          questionCount={question.total}
          pickerName={findPlayer(lobby.players, turn?.pickerId)?.name ?? ""}
          fixed={turn?.options.length === 1}
          sequence={
            lobby.settings.categoryMode === "sequence" && lobby.progress
              ? { round: lobby.progress.round, rounds: lobby.progress.rounds }
              : null
          }
          phaseStartedAt={lobby.phaseStartedAt}
          startsAt={question.startsAt}
        />
      );
    case "question":
      if (!question) return null;
      return (
        <QuestionOverlay
          question={question}
          myChoice={myChoiceFor(question, self, pendingAnswer)}
          canAnswer={selfPlayer?.status === "active"}
          untimed={lobby.settings.answerSec === 0}
          presenting={selfPlayer?.status === "spectator"}
          waitingCount={answerWaitingCount(lobby, selfId)}
          runId={`${question.id}:${question.deadline}:${syncGeneration}`}
          onAnswer={(choice) => onAnswer(question.id, choice)}
          onPromptUnfocused={onPromptUnfocused}
        />
      );
    case "answer_reveal":
      if (!question) return null;
      return (
        <AnswerRevealOverlay
          question={question}
          players={lobby.players}
          selfId={selfId}
          phaseStartedAt={lobby.phaseStartedAt}
          phaseEndsAt={lobby.phaseEndsAt}
        />
      );
    case "turn_summary": {
      const row = currentTurnRow(lobby);
      return (
        <TurnSummaryOverlay
          summary={row ? summarizeTurn(row) : null}
          players={lobby.players}
          category={categoryVisual(categories, row?.categoryId ?? turn?.categoryId)}
          phaseStartedAt={lobby.phaseStartedAt}
        />
      );
    }
    case "round_board":
      return (
        <RoundBoardOverlay
          board={lobby.board}
          participants={gameParticipants(lobby)}
          round={lobby.progress?.round ?? lobby.board.reduce((max, row) => Math.max(max, row.round), 1)}
          rounds={lobby.settings.rounds}
          categories={categories}
          questionsPerTurn={lobby.settings.questionsPerCategory}
          selfId={selfId}
          phaseStartedAt={lobby.phaseStartedAt}
        />
      );
    default:
      // `none` und `game_over` (das Spielende liegt über der Bühne, siehe GameOverStage)
      return null;
  }
}

/**
 * Spielende (docs/09 §6, §7.9) außerhalb der Bühne: gleicher Chunk und gleiche Lade-Regel wie die Overlays der
 * Bühne (vorgeladen synchron, sonst `dynamic()`). game-screen.tsx legt es über Kategoriestreifen, Bühne und
 * Spielerstreifen – die bleiben darunter unverändert stehen, während das letzte Overlay ausblendet.
 */
export function GameOverStage(props: GameOverOverlayProps) {
  const [modules] = useState(preloadedOverlays);
  const GameOverOverlay = modules.gameOver?.GameOverOverlay ?? GameOverOverlayLazy;
  return (
    <MotionProvider>
      <GameOverOverlay {...props} />
    </MotionProvider>
  );
}
