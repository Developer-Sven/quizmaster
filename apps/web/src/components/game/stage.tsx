"use client";

import type { AnswerIndex, PrivatePlayerState, PublicLobbyState } from "@quizmaster/shared";
import { AnimatePresence } from "motion/react";
import dynamic from "next/dynamic";
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
import { type StageKind, stageAt, stageBoundaries } from "@/lib/client/phase-clock";
import { useServerNow } from "@/lib/client/use-server-clock";
import { MotionProvider } from "@/lib/ui/motion";
import type { PendingAnswer, PendingPick } from "@/stores/game-store";
import { overlayLoaders } from "./overlays/loaders";

// Overlays in eigenen Chunks (docs/07) – über dieselben Loader, die preloadOverlays() beim Betreten der Lobby
// aufruft (ein Chunk je Overlay, im Spiel wird nichts nachgeladen).
const IntroOverlay = dynamic(() => overlayLoaders.intro().then((mod) => mod.IntroOverlay), { ssr: false });
const CategoryPickOverlay = dynamic(() => overlayLoaders.categoryPick().then((mod) => mod.CategoryPickOverlay), {
  ssr: false,
});
const CategoryRevealOverlay = dynamic(() => overlayLoaders.categoryReveal().then((mod) => mod.CategoryRevealOverlay), {
  ssr: false,
});
const QuestionOverlay = dynamic(() => overlayLoaders.question().then((mod) => mod.QuestionOverlay), { ssr: false });
const AnswerRevealOverlay = dynamic(() => overlayLoaders.answerReveal().then((mod) => mod.AnswerRevealOverlay), {
  ssr: false,
});
const TurnSummaryOverlay = dynamic(() => overlayLoaders.turnSummary().then((mod) => mod.TurnSummaryOverlay), {
  ssr: false,
});
const RoundBoardOverlay = dynamic(() => overlayLoaders.roundBoard().then((mod) => mod.RoundBoardOverlay), {
  ssr: false,
});
const GameOverOverlay = dynamic(() => overlayLoaders.gameOver().then((mod) => mod.GameOverOverlay), { ssr: false });

export interface StageProps {
  lobby: PublicLobbyState;
  self: PrivatePlayerState | null;
  categories: CategoryCatalog;
  pendingAnswer: PendingAnswer | null;
  pendingPick: PendingPick | null;
  /** zählt Wiederaufnahmen – Timer starten danach mit der Restzeit neu */
  syncGeneration: number;
  onPick: (categoryId: string) => void;
  onAnswer: (questionId: string, choice: AnswerIndex) => void;
}

/**
 * Die Bühne (docs/09 §7): zeigt je nach Phase und Serverzeit genau ein Overlay. Übergänge innerhalb einer
 * Phase (Kategorie-Reveal → Frage ab `startsAt`) passieren zum Serverzeitpunkt – für alle gleichzeitig.
 */
export function Stage(props: StageProps) {
  const { lobby } = props;
  const now = useServerNow(stageBoundaries(lobby));
  const kind = stageAt(lobby, now);
  // Nach einer Wiederaufnahme (`syncGeneration`) neu einblenden: Timer und Choreografie rechnen dann von der
  // aktuellen Serverzeit aus weiter (docs/09 §7.4 „bei Reconnect mit verbleibender Dauer neu gestartet“).
  const key = `${kind}:${lobby.phaseStartedAt}:${lobby.question?.id ?? ""}:${props.syncGeneration}`;
  return (
    <MotionProvider>
      <AnimatePresence initial={false}>
        <StageOverlay key={key} kind={kind} {...props} />
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
}: StageProps & { kind: StageKind }) {
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
          waitingCount={answerWaitingCount(lobby, selfId)}
          runId={`${question.id}:${syncGeneration}`}
          onAnswer={(choice) => onAnswer(question.id, choice)}
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
        />
      );
    case "turn_summary": {
      const row = currentTurnRow(lobby);
      return (
        <TurnSummaryOverlay
          summary={row ? summarizeTurn(row) : null}
          players={lobby.players}
          category={categoryVisual(categories, row?.categoryId ?? turn?.categoryId)}
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
        />
      );
    case "game_over":
      return (
        <GameOverOverlay
          results={lobby.results}
          participants={gameParticipants(lobby)}
          board={lobby.board}
          categories={categories}
          questionsPerTurn={lobby.settings.questionsPerCategory}
          selfId={selfId}
        />
      );
    default:
      return null;
  }
}
