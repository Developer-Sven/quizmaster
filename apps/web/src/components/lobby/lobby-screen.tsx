"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { LiveToasts } from "@/components/app/live-toasts";
import { LiveGame } from "@/components/game/live-game";
import { ConnectionOverlay } from "@/components/game/overlays/connection-overlay";
import { preloadOverlays } from "@/components/game/overlays/preload";
import { loadCategoryCatalog } from "@/lib/client/categories";
import { pageModalityTracker } from "@/lib/client/keyboard";
import { joinPath } from "@/lib/client/paths";
import { getRealtimeClient } from "@/lib/client/realtime-client";
import { readMembership, readStoredSoundOn } from "@/lib/client/storage";
import {
  gameActions,
  selectCategoriesMissing,
  selectExit,
  selectPhase,
  selectSawState,
  useGameStore,
} from "@/stores/game-store";
import { LiveLobby } from "./live-lobby";
import { LobbyAnnouncer } from "./lobby-announcer";
import { LobbyLoadingView } from "./lobby-loading-view";
import { LobbyExitView, LobbyFatalView, LobbyStalledView } from "./lobby-status-views";

/** So lange darf es verbunden ohne Lobby-Zustand dauern, bevor statt des Skeletons ein Hinweis erscheint. */
const STATE_WAIT_MS = 15_000;

export interface LobbyScreenProps {
  /** normalisierter, gültiger Code aus der Route */
  code: string;
  /** „ABC 234“ */
  displayCode: string;
  /** Realtime-URL aus der Laufzeit-Konfiguration ("" = gleiche Origin, ADR-023) */
  realtimeUrl: string;
  /** Dev-Bots erlaubt (nur Entwicklung) */
  devBots: boolean;
}

/**
 * Lobby- und Spielseite `/lobby/[code]` (docs/02): verbindet sich, synchronisiert per `lobby:resume` und
 * zeigt je nach Phase die Lobby oder das Spiel. Das Verbindungs-Overlay liegt im Haupt-Bundle, die
 * Spiel-Overlays werden beim Betreten vorgeladen (docs/07) – sobald der erste Zustand da ist: vorher
 * konkurrierten ihre neun Chunks mit Ticket und Handshake um die Bandbreite und verzögerten die Lobby.
 * Wer die Seite ohne Mitgliedschaft öffnet (geteilter Lobby-Link), landet auf der Beitreten-Seite.
 */
export function LobbyScreen({ code, displayCode, realtimeUrl, devBots }: LobbyScreenProps) {
  const router = useRouter();
  const exit = useGameStore(selectExit);
  const phase = useGameStore(selectPhase);
  const fatal = useGameStore((state) => state.connection.fatal);
  const connected = useGameStore((state) => state.connection.status === "connected");
  const categoriesMissing = useGameStore(selectCategoriesMissing);
  // Gab es schon einen Zustand dieser Lobby? (Bleibt nach dem Ende gesetzt – „nicht gefunden“ vs. Beitreten)
  const sawState = useGameStore(selectSawState);
  // Beim Betreten gemerkt: war diese Person hier schon Mitglied? (entscheidet über „nicht gefunden“ vs. Beitreten)
  const [memberAtEntry, setMemberAtEntry] = useState<boolean | null>(null);
  const [stalled, setStalled] = useState(false);
  const waitingForState = phase === null && exit === null && fatal === null && connected;
  const hasState = phase !== null;

  useEffect(() => {
    setMemberAtEntry(readMembership() === code);
    gameActions.setSoundOn(readStoredSoundOn());
    // Eingabeart früh verfolgen (Fokusring schon bei der ersten Kategoriewahl), unabhängig vom Vorladen.
    pageModalityTracker();
    const client = getRealtimeClient({ realtimeUrl });
    client.enterLobby(code);
    return () => client.releaseLobby();
  }, [code, realtimeUrl]);

  useEffect(() => {
    if (hasState) preloadOverlays();
  }, [hasState]);

  // Verbunden, aber kein Zustand (Resync scheitert dauerhaft): nach 15 s Hinweis statt endlosem Skeleton.
  // Der Client versucht es im Hintergrund weiter – kommt der Zustand doch noch, verschwindet der Hinweis.
  useEffect(() => {
    if (!waitingForState) return;
    const timer = window.setTimeout(() => setStalled(true), STATE_WAIT_MS);
    return () => {
      window.clearTimeout(timer);
      setStalled(false);
    };
  }, [waitingForState]);

  // Kategorien früherer Züge unbekannt (z. B. neuer Tab mitten im Spiel): einmal die öffentliche Liste laden.
  useEffect(() => {
    if (!categoriesMissing) return;
    let active = true;
    void loadCategoryCatalog().then((options) => {
      if (active && options.length > 0) gameActions.addCategories(options);
    });
    return () => {
      active = false;
    };
  }, [categoriesMissing]);

  const toJoin = exit?.kind === "error" && exit.code === "LOBBY_NOT_FOUND" && !sawState && memberAtEntry === false;

  useEffect(() => {
    if (toJoin) router.replace(joinPath(code));
  }, [toJoin, code, router]);

  let content: ReactNode;
  if (fatal) content = <LobbyFatalView code={fatal} />;
  else if (toJoin) content = <LobbyLoadingView />;
  else if (exit) content = <LobbyExitView exit={exit} />;
  else if (phase === null) content = stalled ? <LobbyStalledView /> : <LobbyLoadingView />;
  else if (phase === "lobby") {
    content = <LiveLobby code={code} displayCode={displayCode} realtimeUrl={realtimeUrl} devBots={devBots} />;
  } else content = <LiveGame realtimeUrl={realtimeUrl} />;

  return (
    <>
      {content}
      <ConnectionOverlay />
      <LiveToasts />
      <LobbyAnnouncer />
    </>
  );
}
