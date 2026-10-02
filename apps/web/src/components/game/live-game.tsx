"use client";

import type { AnswerIndex, ContinuePhase } from "@quizmaster/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBanners } from "@/components/app/status-banners";
import { useLobbyActions } from "@/components/lobby/use-lobby-actions";
import { isRunningPhase } from "@/lib/client/game-view";
import { getSoundManager } from "@/lib/client/sound";
import { writeStoredSoundOn } from "@/lib/client/storage";
import { useWakeLock } from "@/lib/client/wake-lock";
import {
  gameActions,
  selectCategories,
  selectLobby,
  selectPendingAnswer,
  selectPendingPick,
  selectSelf,
  selectSoundOn,
  selectSyncGeneration,
  useGameStore,
} from "@/stores/game-store";
import { GameScreen } from "./game-screen";

/** Wartezeit vor dem zweiten Versuch nach TOO_EARLY (Uhrenabgleich minimal ungenau). */
const TOO_EARLY_RETRY_MS = 150;

export interface LiveGameProps {
  realtimeUrl: string;
}

/**
 * Spiel (Phasen `intro` … `game_over`) mit Live-Zustand aus dem Store und Aktionen über den Realtime-Client.
 * Hält während des laufenden Spiels den Bildschirm wach (docs/10, Wake Lock) und speichert den Ton-Umschalter.
 */
export function LiveGame({ realtimeUrl }: LiveGameProps) {
  const router = useRouter();
  const lobby = useGameStore(selectLobby);
  const self = useGameStore(selectSelf);
  const categories = useGameStore(selectCategories);
  const pendingAnswer = useGameStore(selectPendingAnswer);
  const pendingPick = useGameStore(selectPendingPick);
  const syncGeneration = useGameStore(selectSyncGeneration);
  const soundOn = useGameStore(selectSoundOn);
  const actions = useLobbyActions(realtimeUrl);
  const [busy, setBusy] = useState<{ leave?: boolean; resign?: boolean }>({});
  /** Beginn der Phase, für die „Weiter“ gerade gesendet wird (ADR-045) – danach wieder frei */
  const [continuing, setContinuing] = useState<number | null>(null);
  useWakeLock(lobby !== null && isRunningPhase(lobby.phase));
  if (!lobby) return null;

  const pick = async (categoryId: string) => {
    if (pendingPick || !self?.canPick) return;
    gameActions.setPendingPick({ phaseStartedAt: lobby.phaseStartedAt, categoryId });
    const result = await actions.client().emit("game:pick", { categoryId });
    if (!result.ok) {
      gameActions.setPendingPick(null);
      actions.fail(result.code);
    }
  };

  const answer = async (questionId: string, choice: AnswerIndex) => {
    // Einloggen sofort (docs/09 §7.5) – das Ack verrät nie richtig/falsch.
    gameActions.setPendingAnswer({ questionId, choice });
    const client = actions.client();
    let result = await client.emit("game:answer", { questionId, choice });
    if (!result.ok && result.code === "TOO_EARLY") {
      // Die Uhr geht minimal vor: kurz warten und die sichtbare Wahl einmal erneut senden.
      await new Promise((resolve) => window.setTimeout(resolve, TOO_EARLY_RETRY_MS));
      result = await client.emit("game:answer", { questionId, choice });
    }
    if (result.ok) return;
    // Bereits beantwortet: Der Server hat eine Antwort – sie bleibt eingeloggt, `lobby:self` zeigt welche.
    if (result.code === "ALREADY_ANSWERED") return;
    if (result.code === "NETWORK") {
      // Kein Ack: kam vielleicht nie an. Bis `lobby:self` es klärt (nach dem Reconnect bzw. sofort per
      // Resync) bleibt sie eingeloggt; kennt der Server sie nicht, wird sie wieder freigegeben.
      gameActions.answerUnconfirmed(questionId);
      client.resync();
      return;
    }
    // Nicht angenommen: wieder freigeben (still synchronisieren bzw. Hinweis).
    gameActions.setPendingAnswer(null);
    actions.fail(result.code);
  };

  const continueGame = async (phase: ContinuePhase) => {
    const startedAt = lobby.phaseStartedAt;
    if (continuing === startedAt) return;
    setContinuing(startedAt);
    const result = await actions.client().emit("game:continue", { phase });
    // INVALID_PHASE: schon weiter (Doppeltipp, zweites Gerät); TOO_EARLY: Frage noch im Vorlauf – kein Hinweis.
    if (!result.ok && (result.code === "INVALID_PHASE" || result.code === "TOO_EARLY")) {
      setContinuing(null);
      return;
    }
    if (!result.ok) {
      setContinuing(null);
      actions.fail(result.code);
    }
  };

  const leave = async (kind: "leave" | "resign") => {
    setBusy((current) => ({ ...current, [kind]: true }));
    await actions.client().leaveLobby();
    router.push("/");
  };

  return (
    <GameScreen
      lobby={lobby}
      self={self}
      categories={categories}
      pendingAnswer={pendingAnswer}
      pendingPick={pendingPick}
      syncGeneration={syncGeneration}
      soundOn={soundOn}
      busy={{ ...busy, continue: continuing === lobby.phaseStartedAt }}
      banner={lobby.phase === "game_over" ? <StatusBanners /> : null}
      handlers={{
        onPick: (categoryId) => void pick(categoryId),
        onAnswer: (questionId, choice) => void answer(questionId, choice),
        onResign: () => void leave("resign"),
        onToggleSound: () => {
          // Der Sound-Manager speichert die Einstellung (storage.ts) und stoppt beim Ausschalten laufende Töne.
          const manager = getSoundManager();
          if (manager) manager.setEnabled(!soundOn);
          else writeStoredSoundOn(!soundOn);
          gameActions.setSoundOn(!soundOn);
        },
        onLeave: () => void leave("leave"),
        onContinue: (phase) => void continueGame(phase),
      }}
    />
  );
}
