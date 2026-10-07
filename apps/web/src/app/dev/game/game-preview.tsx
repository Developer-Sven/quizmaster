"use client";

import type { AnswerIndex, RatingValue, ReviewItem } from "@quizmaster/shared";
import Link from "next/link";
import { useState } from "react";
import { GameScreen } from "@/components/game/game-screen";
import { ConnectionPanel } from "@/components/game/overlays/connection-overlay";
import { ReviewSheet } from "@/components/game/review-sheet";
import { LobbyLoadingView } from "@/components/lobby/lobby-loading-view";
import { LobbyExitView, LobbyFatalView } from "@/components/lobby/lobby-status-views";
import { LobbyView } from "@/components/lobby/lobby-view";
import { FrozenClockProvider } from "@/lib/client/clock-context";
import { inviteLink } from "@/lib/client/paths";
import { useOrigin } from "@/lib/client/use-origin";
import { useIsClient } from "@/lib/ui/portal";
import type { PendingAnswer, PendingPick } from "@/stores/game-store";
import {
  PREVIEW_CATALOG,
  PREVIEW_VIEWS,
  type PreviewPlayers,
  type PreviewScene,
  type PreviewViewId,
} from "./sample-states";

const noop = () => {};

export interface GamePreviewProps {
  view: PreviewViewId | null;
  players: PreviewPlayers;
}

/**
 * Vorschau jeder Spielphase und jedes Overlays ohne Server (/dev/game, nur Entwicklung) – für
 * Design-Reviews und Screenshots. Die Uhr ist eingefroren (Zeitpunkte relativ zum Laden); Antworten,
 * Kategoriewahl, Ton und „Fragen ansehen“ reagieren lokal.
 */
export function GamePreview({ view, players }: GamePreviewProps) {
  const isClient = useIsClient();
  if (!isClient) return null;
  if (view === null) return <PreviewIndex />;
  return <PreviewRun key={`${view}-${players}`} view={view} players={players} />;
}

function PreviewRun({ view, players }: { view: PreviewViewId; players: PreviewPlayers }) {
  const [now] = useState(() => Date.now());
  const [scene] = useState(() => PREVIEW_VIEWS[view].build({ now, count: players }));
  return (
    <FrozenClockProvider at={now}>
      <SceneView scene={scene} />
    </FrozenClockProvider>
  );
}

function SceneView({ scene }: { scene: PreviewScene }) {
  switch (scene.kind) {
    case "lobby":
      return <PreviewLobby scene={scene} />;
    case "game":
      return <PreviewGame scene={scene} />;
    case "exit":
      return <LobbyExitView exit={scene.exit} />;
    case "fatal":
      return <LobbyFatalView code={scene.code} />;
    case "loading":
      return (
        <>
          <LobbyLoadingView />
          {scene.connecting ? <ConnectionPanel remainingMs={null} /> : null}
        </>
      );
  }
}

function PreviewLobby({ scene }: { scene: Extract<PreviewScene, { kind: "lobby" }> }) {
  const origin = useOrigin();
  return (
    <LobbyView
      lobby={scene.lobby}
      selfId={scene.self.playerId}
      isHost={scene.self.isHost}
      displayCode="ABC 234"
      inviteUrl={origin ? inviteLink(origin, scene.lobby.code) : ""}
      devBots
      onStart={noop}
      onLeave={noop}
      onKick={noop}
      onChangeSettings={noop}
      onCopyCode={noop}
      onShare={noop}
      onShowRules={noop}
      onAddBot={noop}
      defaultSettingsOpen={scene.settingsOpen}
      defaultQrOpen={scene.qrOpen}
    />
  );
}

function PreviewGame({ scene }: { scene: Extract<PreviewScene, { kind: "game" }> }) {
  const [pendingAnswer, setPendingAnswer] = useState<PendingAnswer | null>(scene.pendingAnswer ?? null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(scene.review !== undefined);
  const [items, setItems] = useState<readonly ReviewItem[]>(scene.review?.items ?? []);

  const rate = (questionId: string, value: RatingValue) =>
    setItems((current) =>
      current.map((item) => (item.questionId === questionId ? { ...item, myRating: value } : item)),
    );

  return (
    <>
      <GameScreen
        lobby={scene.lobby}
        self={scene.self}
        categories={PREVIEW_CATALOG}
        pendingAnswer={pendingAnswer}
        pendingPick={pendingPick}
        syncGeneration={0}
        soundOn={soundOn}
        handlers={{
          onPick: (categoryId) => setPendingPick({ phaseStartedAt: scene.lobby.phaseStartedAt, categoryId }),
          onAnswer: (questionId: string, choice: AnswerIndex) => setPendingAnswer({ questionId, choice }),
          onResign: noop,
          onToggleSound: () => setSoundOn((on) => !on),
          onLeave: noop,
          onContinue: noop,
          onEndGame: noop,
          onShowRules: noop,
        }}
      />
      <ReviewSheet
        open={reviewOpen}
        status="ready"
        items={items}
        players={scene.lobby.players}
        categories={PREVIEW_CATALOG}
        selfId={scene.self.playerId}
        onClose={() => setReviewOpen(false)}
        onRetry={noop}
        onRate={rate}
        onReport={(questionId) =>
          setItems((current) =>
            current.map((item) => (item.questionId === questionId ? { ...item, myReported: true } : item)),
          )
        }
        defaultReportingId={scene.review?.reportingId ?? null}
      />
      {scene.connectionMs !== undefined ? <ConnectionPanel remainingMs={scene.connectionMs} /> : null}
    </>
  );
}

const VIEW_IDS = Object.keys(PREVIEW_VIEWS) as PreviewViewId[];

/** Übersicht aller Vorschauen mit Links (2, 6 und 8 Personen). */
function PreviewIndex() {
  return (
    <main className="mx-auto w-full max-w-column px-gutter pt-safe pb-safe">
      <header className="flex flex-col gap-2 py-8">
        <h1 className="text-h1 text-text">Spiel-Vorschau</h1>
        <p className="text-body text-text-2">Jede Phase und jedes Overlay ohne Server · docs/09 §7</p>
      </header>
      <ul className="flex flex-col">
        {VIEW_IDS.map((id) => {
          const definition: { title: string; byPlayers: boolean } = PREVIEW_VIEWS[id];
          return (
            <li key={id} className="flex min-h-14 items-center gap-3 border-b border-line">
              <span className="min-w-0 flex-1 text-body text-text">{definition.title}</span>
              {(definition.byPlayers ? ([2, 6, 8] as const) : ([2] as const)).map((count) => (
                <Link
                  key={count}
                  href={`/dev/game?view=${id}&players=${count}`}
                  className="rounded-sm text-label text-text-2 underline underline-offset-4"
                >
                  {definition.byPlayers ? `${count} Personen` : "ansehen"}
                </Link>
              ))}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
