"use client";

import type { PublicPlayer, RatingValue, ReportReason, ReviewItem } from "@quizmaster/shared";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useLobbyActions } from "@/components/lobby/use-lobby-actions";
import { de } from "@/i18n/de";
import { actionErrorPlacement } from "@/lib/client/errors";
import { getRealtimeClient } from "@/lib/client/realtime-client";
import { gameActions, selectCategories, selectLobby, selectSelf, useGameStore } from "@/stores/game-store";
import { loadOverlay } from "./overlays/loaders";
import { type ReviewStatus, reviewStatusAfterError } from "./review-sheet";

// Gleicher Loader wie preloadOverlays() (ein Chunk, beim Betreten der Lobby vorgeladen).
const ReviewSheet = dynamic(() => loadOverlay("reviewSheet").then((mod) => mod.ReviewSheet), { ssr: false });

export interface LiveReviewSheetProps {
  open: boolean;
  realtimeUrl: string;
  onClose: () => void;
  /**
   * Personen des Spiels für die Avatare an den Antworten – in der Lobby die Personen des letzten Spielendes
   * (auch inzwischen Gegangene); Standard: die aktuellen Personen der Lobby.
   */
  players?: readonly PublicPlayer[];
  /** eigene playerId im Spiel (Standard: aus `lobby:self`) */
  selfId?: string | null;
}

/**
 * „Fragen ansehen“ mit `game:review`, Bewerten (`question:rate`) und Melden (`question:report`) – nach dem Spiel
 * aus der Lobby (Karte „Letztes Spiel“, ADR-038).
 */
export function LiveReviewSheet({ open, realtimeUrl, onClose, players, selfId }: LiveReviewSheetProps) {
  const lobby = useGameStore(selectLobby);
  const self = useGameStore(selectSelf);
  const categories = useGameStore(selectCategories);
  const actions = useLobbyActions(realtimeUrl);
  const [status, setStatus] = useState<ReviewStatus>("loading");
  const [items, setItems] = useState<readonly ReviewItem[]>([]);
  const [attempt, setAttempt] = useState(0);

  // Beim Öffnen und bei „Erneut versuchen“ die Liste laden: `attempt` ist der Auslöser des neuen Versuchs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt startet bewusst einen neuen Ladeversuch
  useEffect(() => {
    if (!open) return;
    let active = true;
    setStatus("loading");
    const client = getRealtimeClient({ realtimeUrl });
    void client.emit("game:review", {}).then((result) => {
      if (!active) return;
      if (result.ok) {
        setItems(result.data);
        setStatus("ready");
      } else {
        setStatus(reviewStatusAfterError(result.code));
        if (actionErrorPlacement(result.code) === "resync") client.resync();
      }
    });
    return () => {
      active = false;
    };
  }, [open, attempt, realtimeUrl]);

  const updateItem = (questionId: string, change: Partial<ReviewItem>) => {
    setItems((current) => current.map((item) => (item.questionId === questionId ? { ...item, ...change } : item)));
  };

  const rate = async (questionId: string, value: RatingValue) => {
    const previous = items.find((item) => item.questionId === questionId)?.myRating ?? null;
    if (previous === value) return;
    updateItem(questionId, { myRating: value });
    const result = await actions.client().emit("question:rate", { questionId, value });
    if (!result.ok) {
      updateItem(questionId, { myRating: previous });
      actions.fail(result.code);
    }
  };

  const report = async (questionId: string, reason: ReportReason) => {
    const result = await actions.client().emit("question:report", { questionId, reason });
    if (result.ok) {
      updateItem(questionId, { myReported: true });
      gameActions.showToast("info", de.report.thanks);
    } else {
      actions.fail(result.code);
    }
  };

  if (!lobby) return null;
  return (
    <ReviewSheet
      open={open}
      status={status}
      items={items}
      players={players ?? lobby.players}
      categories={categories}
      selfId={selfId === undefined ? (self?.playerId ?? null) : selfId}
      onClose={onClose}
      onRetry={() => setAttempt((value) => value + 1)}
      onRate={(questionId, value) => void rate(questionId, value)}
      onReport={(questionId, reason) => void report(questionId, reason)}
    />
  );
}
