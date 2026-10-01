"use client";

import dynamic from "next/dynamic";
import { LobbyLoadingView } from "./lobby-loading-view";
import type { LobbyScreenProps } from "./lobby-screen";

/**
 * Die eigentliche Lobby-/Spiel-App (Realtime-Client, Store, Verträge, Verbindungs-Overlay) liegt in einem
 * eigenen Chunk, der direkt nach der Hydration lädt – das HTML zeigt bis dahin das Skeleton. So bleibt das
 * initiale JS der Seite klein (docs/07: ≤ 180 KB), ohne dass im Spiel etwas nachgeladen wird: die Overlays
 * lädt die App beim Betreten vor, das Verbindungs-Overlay ist Teil der App.
 */
const LobbyScreen = dynamic(() => import("./lobby-screen").then((mod) => mod.LobbyScreen), {
  ssr: false,
  loading: () => <LobbyLoadingView />,
});

export function LobbyEntry(props: LobbyScreenProps) {
  return <LobbyScreen {...props} />;
}
