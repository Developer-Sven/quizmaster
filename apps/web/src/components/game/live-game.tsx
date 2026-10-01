"use client";

import type { AnswerIndex, RatingValue, ReportReason, ReviewItem } from "@quizmaster/shared";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StatusBanners } from "@/components/app/status-banners";
import { useLobbyActions } from "@/components/lobby/use-lobby-actions";
import { markFirstGameFinished } from "@/components/pwa/install-state";
import { de } from "@/i18n/de";
import { actionErrorPlacement } from "@/lib/client/errors";
import { isRunningPhase, reviewSheetOpen } from "@/lib/client/game-view";
import { getRealtimeClient } from "@/lib/client/realtime-client";
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
import { loadOverlay } from "./overlays/loaders";
import type { ReviewStatus } from "./review-sheet";

/** Wartezeit vor dem zweiten Versuch nach TOO_EARLY (Uhrenabgleich minimal ungenau). */
const TOO_EARLY_RETRY_MS = 150;

// Gleicher Loader wie preloadOverlays() (ein Chunk, beim Betreten der Lobby vorgeladen).
const ReviewSheet = dynamic(() => loadOverlay("reviewSheet").then((mod) => mod.ReviewSheet), { ssr: false });

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
  /** `phaseStartedAt` des Spielendes, zu dem „Fragen ansehen“ geöffnet wurde (sonst `null`) */
  const [reviewFor, setReviewFor] = useState<number | null>(null);
  const [busy, setBusy] = useState<{ rematch?: boolean; leave?: boolean; resign?: boolean }>({});
  useWakeLock(lobby !== null && isRunningPhase(lobby.phase));
  const gameOver = lobby?.phase === "game_over";
  // Ein Spiel bis zum Ende gespielt: Ab jetzt darf die Startseite „Als App installieren“ anbieten (docs/10).
  useEffect(() => {
    if (gameOver) markFirstGameFinished();
  }, [gameOver]);
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

  const leave = async (kind: "leave" | "resign") => {
    setBusy((current) => ({ ...current, [kind]: true }));
    await actions.client().leaveLobby();
    router.push("/");
  };

  const rematch = async () => {
    setBusy((current) => ({ ...current, rematch: true }));
    const result = await actions.client().emit("game:rematch", {});
    setBusy((current) => ({ ...current, rematch: false }));
    if (!result.ok) actions.fail(result.code);
  };

  return (
    <>
      <GameScreen
        lobby={lobby}
        self={self}
        categories={categories}
        pendingAnswer={pendingAnswer}
        pendingPick={pendingPick}
        syncGeneration={syncGeneration}
        soundOn={soundOn}
        busy={busy}
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
          onRematch: () => void rematch(),
          onLeave: () => void leave("leave"),
          onOpenReview: () => setReviewFor(lobby.phaseStartedAt),
        }}
      />
      <LiveReviewSheet
        open={reviewSheetOpen(reviewFor, lobby)}
        realtimeUrl={realtimeUrl}
        onClose={() => setReviewFor(null)}
      />
    </>
  );
}

interface LiveReviewSheetProps {
  open: boolean;
  realtimeUrl: string;
  onClose: () => void;
}

/** „Fragen ansehen“ mit `game:review`, Bewerten (`question:rate`) und Melden (`question:report`). */
function LiveReviewSheet({ open, realtimeUrl, onClose }: LiveReviewSheetProps) {
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
        setStatus("error");
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
      players={lobby.players}
      categories={categories}
      selfId={self?.playerId ?? null}
      onClose={onClose}
      onRetry={() => setAttempt((value) => value + 1)}
      onRate={(questionId, value) => void rate(questionId, value)}
      onReport={(questionId, reason) => void report(questionId, reason)}
    />
  );
}
