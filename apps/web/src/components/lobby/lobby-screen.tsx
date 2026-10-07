"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { LiveToasts } from "@/components/app/live-toasts";
import { RulesSheet } from "@/components/app/rules-sheet";
import { MaintenanceNoticeContext } from "@/components/app/status-banners";
import { LiveGame } from "@/components/game/live-game";
import { ConnectionOverlay } from "@/components/game/overlays/connection-overlay";
import { preloadOverlays } from "@/components/game/overlays/preload";
import { type TurnstileClientConfig, TurnstileSlot, useTurnstile } from "@/components/turnstile/turnstile-slot";
import { loadCategoryCatalog } from "@/lib/client/categories";
import { preloadExtendedGlyphs } from "@/lib/client/font-preload";
import { pageModalityTracker } from "@/lib/client/keyboard";
import { joinPath } from "@/lib/client/paths";
import { getRealtimeClient } from "@/lib/client/realtime-client";
import { readMembership, readStoredSoundOn } from "@/lib/client/storage";
import type { MaintenanceNotice } from "@/lib/server/maintenance";
import {
  gameActions,
  selectCategoriesMissing,
  selectExit,
  selectPhase,
  selectRulesOpen,
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
  /** Turnstile (docs/06): nötig, wenn beim Wiederverbinden eine neue Session entsteht */
  turnstile: TurnstileClientConfig;
  /** Serverseitig ermittelter Wartungshinweis vom Seitenaufruf; `null` = keiner */
  maintenance: MaintenanceNotice | null;
}

/**
 * Lobby- und Spielseite `/lobby/[code]` (docs/02): verbindet sich, synchronisiert per `lobby:resume` und
 * zeigt je nach Phase die Lobby oder das Spiel. Das Verbindungs-Overlay liegt im Haupt-Bundle, die
 * Spiel-Overlays werden beim Betreten vorgeladen (docs/07) – sobald der erste Zustand da ist: vorher
 * konkurrierten ihre neun Chunks mit Ticket und Handshake um die Bandbreite und verzögerten die Lobby.
 * Wer die Seite ohne Mitgliedschaft öffnet (geteilter Lobby-Link), landet auf der Beitreten-Seite: meist schon vorher
 * über `LobbyEntry` (Merker im Speicher); ist der Speicher nicht nutzbar, hier nach `lobby:resume` → LOBBY_NOT_FOUND.
 */
export function LobbyScreen({ code, displayCode, realtimeUrl, devBots, turnstile, maintenance }: LobbyScreenProps) {
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
  const solver = useTurnstile(turnstile);
  // Verbindungsaufbau endete mit TURNSTILE_REQUIRED, obwohl die Prüfung bestanden war (Server lehnte das Token ab).
  const turnstileRejected = useGameStore((state) => state.connection.lastError === "TURNSTILE_REQUIRED");

  useEffect(() => {
    setMemberAtEntry(readMembership() === code);
    gameActions.setSoundOn(readStoredSoundOn());
    // Eingabeart früh verfolgen (Fokusring schon bei der ersten Kategoriewahl), unabhängig vom Vorladen.
    pageModalityTracker();
    const client = getRealtimeClient({ realtimeUrl });
    // Läuft die Session beim Wiederverbinden ab, braucht die neue Session ggf. Turnstile (TURNSTILE_ENABLED).
    client.setTurnstileProvider(solver === null ? null : (purpose) => solver.solve(purpose), {
      sessionRequiresToken: turnstile.enabled,
    });
    client.enterLobby(code);
    return () => {
      client.setTurnstileProvider(null);
      client.releaseLobby();
    };
  }, [code, realtimeUrl, solver, turnstile.enabled]);

  useEffect(() => {
    if (!hasState) return;
    preloadOverlays();
    preloadExtendedGlyphs();
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
    <MaintenanceNoticeContext value={maintenance}>
      {content}
      <ConnectionOverlay />
      <LiveToasts />
      <LiveRulesSheet />
      <LobbyAnnouncer />
      {/* Über dem Verbindungs-Overlay: Turnstile beim Wiederverbinden (nur sichtbar bei Bestätigung/Fehler). */}
      <TurnstileSlot
        solver={solver}
        variant="panel"
        rejected={turnstileRejected}
        onRetry={() => getRealtimeClient({ realtimeUrl }).connect()}
      />
    </MaintenanceNoticeContext>
  );
}

/** Regeln-Sheet für Lobby und Spielende (ADR-052): hier eingehängt, damit es den Wechsel Spielende → Lobby übersteht. */
function LiveRulesSheet() {
  const open = useGameStore(selectRulesOpen);
  return <RulesSheet open={open} onClose={closeLiveRules} />;
}

/** „Regeln“ des aktuellen Screens (Lobby bzw. Spielende, `RulesLink`). */
const RULES_TRIGGER = '[data-testid="rules-link"]';

/**
 * Schließt das Regeln-Sheet. Am Spielende geöffnet, gibt es seinen Auslöser nach dem Wechsel in die Lobby nicht mehr
 * (ADR-052): Die Fokus-Rückgabe des Sheets greift dann ins Leere, und der Fokus fiele mit dem ausblendenden Sheet auf
 * `<body>` – Tab begänne wieder oben (WCAG 2.4.3). Steht er nach dem Schließen (die Rückgabe läuft im Commit) noch
 * dort, wo er im Sheet war, oder auf `<body>`, bekommt „Regeln“ der Lobby den Fokus.
 */
function closeLiveRules(): void {
  const inSheet = document.activeElement;
  gameActions.closeRules();
  window.requestAnimationFrame(() => {
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && focused !== inSheet) return;
    document.querySelector<HTMLElement>(RULES_TRIGGER)?.focus({ preventScroll: true });
  });
}
