"use client";

import type { AnswerIndex, PrivatePlayerState, PublicLobbyState } from "@quizmaster/shared";
import { type ReactNode, useState } from "react";
import { ActionBar, ActionBarNote } from "@/components/app/action-bar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { de } from "@/i18n/de";
import {
  announcementFor,
  type CategoryCatalog,
  categoryVisual,
  connectedCount,
  findPlayer,
  hostPlayer,
  isRunningPhase,
} from "@/lib/client/game-view";
import { ListChecksIcon, RotateCcwIcon } from "@/lib/ui/icons";
import type { PendingAnswer, PendingPick } from "@/stores/game-store";
import { CategoryStrip } from "./category-strip";
import { Hud } from "./hud";
import { PlayerStrip } from "./player-strip";
import { Stage } from "./stage";

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
 * Spiel-Screen (docs/09 §7 Grundgerüst): HUD ersetzt die Kopfzeile, darunter der Kategoriestreifen, die
 * Bühne mit den Overlays und unten der Spielerstreifen statt der Aktionsleiste. Im Spielende (§6) steht
 * unten die Aktionsleiste: Host „Revanche“, sonst „Warte auf Mia …“; „Fragen ansehen“; „Lobby verlassen“.
 * Rein darstellend – Daten und Aktionen kommen als Props (Live-Spiel und /dev/game).
 */
export function GameScreen({
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
  const progress = lobby.progress
    ? de.game.progress(lobby.progress.round, lobby.progress.rounds, lobby.progress.turn, lobby.progress.turnsPerRound)
    : "";
  const categoryId = lobby.turn?.categoryId ?? null;
  const question = lobby.question;
  const fraction =
    question && (phase === "question" || phase === "reveal") ? de.game.fraction(question.index, question.total) : null;
  const host = hostPlayer(lobby.players);

  return (
    <div data-testid="game-screen" data-phase={phase} className="fixed inset-0 flex flex-col overscroll-none bg-bg">
      <Hud
        progress={progress}
        announcement={announcementFor(lobby, selfId, categories)}
        canResign={isRunningPhase(phase) && selfPlayer?.status === "active"}
        soundOn={soundOn}
        onToggleSound={handlers.onToggleSound}
        onResign={handlers.onResign}
        resigning={busy.resign}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        {banner}
        {gameOver ? null : (
          <CategoryStrip category={categoryId ? categoryVisual(categories, categoryId) : null} fraction={fraction} />
        )}
        <div className="relative min-h-0 w-full flex-1">
          <Stage
            lobby={lobby}
            self={self}
            categories={categories}
            pendingAnswer={pendingAnswer}
            pendingPick={pendingPick}
            syncGeneration={syncGeneration}
            onPick={handlers.onPick}
            onAnswer={handlers.onAnswer}
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
