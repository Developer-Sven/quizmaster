"use client";

import type { AnswerIndex, PrivatePlayerState, PublicLobbyState } from "@quizmaster/shared";
import { type ReactNode, useState } from "react";
import { ActionBar, ActionBarNote } from "@/components/app/action-bar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { de } from "@/i18n/de";
import {
  type CategoryCatalog,
  categoryVisual,
  connectedCount,
  findPlayer,
  hostPlayer,
  isRunningPhase,
} from "@/lib/client/game-view";
import { type StageKind, stageAt, stageBoundaries } from "@/lib/client/phase-clock";
import { ListChecksIcon, RotateCcwIcon } from "@/lib/ui/icons";
import type { PendingAnswer, PendingPick } from "@/stores/game-store";
import { type CategoryArrival, CategoryStrip } from "./category-strip";
import { displayedScores, pointsShown, scoreBoundaries, stageCues } from "./choreography";
import { Hud } from "./hud";
import { PlayerStrip } from "./player-strip";
import { PreviewClock } from "./preview-clock";
import { stageAnnouncement } from "./results";
import { Stage } from "./stage";
import { lockFeedback, useGameAudio, useGameDocument, useServerMoment, useStageCues } from "./use-choreography";

export interface GameHandlers {
  onPick: (categoryId: string) => void;
  onAnswer: (questionId: string, choice: AnswerIndex) => void;
  /** nach Bestätigung „Spiel verlassen?“ (= Aufgeben) */
  onResign: () => void;
  onToggleSound: () => void;
  onRematch: () => void;
  /** nach Bestätigung „Lobby verlassen?“ (Spielende) */
  onLeave: () => void;
  onOpenReview: () => void;
}

export interface GameBusy {
  rematch?: boolean;
  leave?: boolean;
  resign?: boolean;
}

export interface GameScreenProps {
  lobby: PublicLobbyState;
  self: PrivatePlayerState | null;
  categories: CategoryCatalog;
  pendingAnswer: PendingAnswer | null;
  pendingPick: PendingPick | null;
  syncGeneration: number;
  soundOn: boolean;
  handlers: GameHandlers;
  busy?: GameBusy;
  /** Banner unter dem HUD (Wartung, Update) */
  banner?: ReactNode;
}

/**
 * Stufen, in denen der Kategoriestreifen die Kategorie des Zuges zeigt: ab ihrer Einblendung bis zum
 * Zug-Ergebnis. Während der Wahl (auch nach dem Tippen) bleibt er leer, damit die gewählte Kachel zur
 * Einblendung hineinfliegen kann; Intro, Rundentafel und Spielende haben keinen laufenden Zug.
 */
const STRIP_STAGES: ReadonlySet<StageKind> = new Set<StageKind>([
  "category_reveal",
  "lead_in",
  "question",
  "answer_reveal",
  "turn_summary",
]);

/**
 * Spiel-Screen (docs/09 §7 Grundgerüst): HUD ersetzt die Kopfzeile, darunter der Kategoriestreifen, die
 * Bühne mit den Overlays und unten der Spielerstreifen statt der Aktionsleiste. Im Spielende (§6) steht
 * unten die Aktionsleiste: Host „Revanche“, sonst „Warte auf Mia …“; „Fragen ansehen“; „Lobby verlassen“.
 *
 * Die Choreografie (docs/09 §7–8) läuft an Serverzeitpunkten: die Bühne wechselt ihr Overlay, der Streifen
 * empfängt die gewählte Kategorie, die Punkte steigen 400 ms nach Beginn der Auflösung, Töne und Haptik
 * (docs/09 §10) kommen als Cues. Rein darstellend – Daten und Aktionen kommen als Props (Live-Spiel und
 * /dev/game; dort mit eingefrorener bzw. per `?clock=play` laufender Uhr).
 */
export function GameScreen(props: GameScreenProps) {
  return (
    <PreviewClock>
      <GameScreenContent {...props} />
    </PreviewClock>
  );
}

function GameScreenContent({
  lobby,
  self,
  categories,
  pendingAnswer,
  pendingPick,
  syncGeneration,
  soundOn,
  handlers,
  busy = {},
  banner,
}: GameScreenProps) {
  const [leaveOpen, setLeaveOpen] = useState(false);
  const selfId = self?.playerId ?? null;
  const selfPlayer = findPlayer(lobby.players, selfId);
  const phase = lobby.phase;
  const gameOver = phase === "game_over";
  // Frisch bei jedem Rendern (auch direkt nach einem neuen Zustand) und neu an den Serverzeitpunkten.
  const kind = useServerMoment((now) => stageAt(lobby, now), stageBoundaries(lobby));
  const shownPoints = useServerMoment((now) => pointsShown(lobby, now), scoreBoundaries(lobby));

  useStageCues(stageCues(lobby, selfId));
  useGameAudio(soundOn);
  useGameDocument();

  const progress = lobby.progress
    ? de.game.progress(lobby.progress.round, lobby.progress.rounds, lobby.progress.turn, lobby.progress.turnsPerRound)
    : "";
  const question = lobby.question;
  const categoryId = STRIP_STAGES.has(kind) ? (lobby.turn?.categoryId ?? question?.categoryId ?? null) : null;
  const fraction =
    question && (phase === "question" || phase === "reveal") ? de.game.fraction(question.index, question.total) : null;
  const arrival: CategoryArrival | null =
    kind === "category_reveal" && categoryId !== null
      ? { id: String(lobby.phaseStartedAt), at: lobby.phaseStartedAt, categoryId }
      : null;
  const host = hostPlayer(lobby.players);

  const answer = (questionId: string, choice: AnswerIndex) => {
    // Einloggen (docs/09 §7.5): Ton und Haptik sofort im Handler des Tippens bzw. der Taste.
    lockFeedback();
    handlers.onAnswer(questionId, choice);
  };

  return (
    <div data-testid="game-screen" data-phase={phase} className="fixed inset-0 flex flex-col overscroll-none bg-bg">
      <Hud
        progress={progress}
        announcement={stageAnnouncement(lobby, selfId, categories)}
        canResign={isRunningPhase(phase) && selfPlayer?.status === "active"}
        soundOn={soundOn}
        onToggleSound={handlers.onToggleSound}
        onResign={handlers.onResign}
        resigning={busy.resign}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        {banner}
        {gameOver ? null : (
          <CategoryStrip
            category={categoryId ? categoryVisual(categories, categoryId) : null}
            fraction={fraction}
            arrival={arrival}
          />
        )}
        <div data-stage="" className="relative min-h-0 w-full flex-1">
          <Stage
            kind={kind}
            lobby={lobby}
            self={self}
            categories={categories}
            pendingAnswer={pendingAnswer}
            pendingPick={pendingPick}
            syncGeneration={syncGeneration}
            onPick={handlers.onPick}
            onAnswer={answer}
          />
        </div>
        {gameOver ? (
          <ActionBar>
            {self?.isHost ? (
              <Button
                variant="primary"
                icon={RotateCcwIcon}
                block
                disabled={connectedCount(lobby.players) < 2}
                loading={busy.rematch}
                onClick={handlers.onRematch}
                data-testid="game-over-rematch"
              >
                {de.actions.rematch}
              </Button>
            ) : (
              <ActionBarNote testId="game-over-waiting">{host ? de.lobby.waitingFor(host.name) : null}</ActionBarNote>
            )}
            <Button
              variant="secondary"
              icon={ListChecksIcon}
              block
              onClick={handlers.onOpenReview}
              data-testid="game-over-review"
            >
              {de.actions.reviewQuestions}
            </Button>
            <Button variant="ghost" block onClick={() => setLeaveOpen(true)} data-testid="game-over-leave">
              {de.actions.leaveLobby}
            </Button>
          </ActionBar>
        ) : (
          <PlayerStrip
            players={lobby.players}
            selfId={selfId}
            answeredIds={phase === "question" && question ? question.answeredBy : []}
            scores={displayedScores(lobby, shownPoints)}
          />
        )}
      </main>
      <Dialog
        open={leaveOpen}
        title={de.dialogs.leaveLobby.title}
        confirmLabel={de.dialogs.leaveLobby.confirm}
        cancelLabel={de.dialogs.leaveLobby.cancel}
        confirming={busy.leave}
        onConfirm={handlers.onLeave}
        onCancel={() => setLeaveOpen(false)}
      />
    </div>
  );
}
