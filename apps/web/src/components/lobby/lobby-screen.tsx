"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { LiveToasts } from "@/components/app/live-toasts";
import { LiveGame } from "@/components/game/live-game";
import { ConnectionOverlay } from "@/components/game/overlays/connection-overlay";
import { preloadOverlays } from "@/components/game/overlays/preload";
import { loadCategoryCatalog } from "@/lib/client/categories";
import { joinPath } from "@/lib/client/paths";
import { getRealtimeClient } from "@/lib/client/realtime-client";
import { readMembership, readStoredSoundOn } from "@/lib/client/storage";
import { gameActions, selectCategoriesMissing, selectExit, selectPhase, useGameStore } from "@/stores/game-store";
import { LiveLobby } from "./live-lobby";
import { LobbyLoadingView } from "./lobby-loading-view";
import { LobbyExitView, LobbyFatalView } from "./lobby-status-views";

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
 * Spiel-Overlays werden beim Betreten vorgeladen (docs/07). Wer die Seite ohne Mitgliedschaft öffnet
 * (geteilter Lobby-Link), landet auf der Beitreten-Seite.
 */
export function LobbyScreen({ code, displayCode, realtimeUrl, devBots }: LobbyScreenProps) {
  const router = useRouter();
  const exit = useGameStore(selectExit);
  const phase = useGameStore(selectPhase);
  const fatal = useGameStore((state) => state.connection.fatal);
  const categoriesMissing = useGameStore(selectCategoriesMissing);
  // Beim Betreten gemerkt: war diese Person hier schon Mitglied? (entscheidet über „nicht gefunden“ vs. Beitreten)
  const [memberAtEntry, setMemberAtEntry] = useState<boolean | null>(null);
  const [sawState, setSawState] = useState(false);

  useEffect(() => {
    setMemberAtEntry(readMembership() === code);
    gameActions.setSoundOn(readStoredSoundOn());
    preloadOverlays();
    const client = getRealtimeClient({ realtimeUrl });
    client.enterLobby(code);
    return () => client.releaseLobby();
  }, [code, realtimeUrl]);

  useEffect(() => {
    if (phase !== null) setSawState(true);
  }, [phase]);

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
  else if (phase === null) content = <LobbyLoadingView />;
  else if (phase === "lobby") {
    content = <LiveLobby code={code} displayCode={displayCode} realtimeUrl={realtimeUrl} devBots={devBots} />;
  } else content = <LiveGame realtimeUrl={realtimeUrl} />;

  return (
    <>
      {content}
      <ConnectionOverlay />
      <LiveToasts />
    </>
  );
}
