"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { joinPath } from "@/lib/client/paths";
import { isKnownNonMember } from "@/lib/client/storage";
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

/**
 * Ob hier ein Mitglied ankommt, steht erst nach dem Hydrieren fest (der Merker liegt im Browser). Wer sicher kein
 * Mitglied ist (geteilter Lobby-Link), geht sofort zur Beitreten-Seite – ohne Lobby-Chunk, Session, Ticket und
 * Verbindung; vorher führte erst `lobby:resume` → LOBBY_NOT_FOUND dorthin (docs/perf-report: LCP 4,3 s). Bleibt es
 * unklar (Speicher nicht nutzbar), lädt die Lobby wie bisher und der Server entscheidet (`LobbyScreen`).
 */
export function LobbyEntry(props: LobbyScreenProps) {
  const router = useRouter();
  const { code } = props;
  // Code, für den die Lobby laden darf (an den Code gebunden: ein anderer Code wird neu geprüft).
  const [allowed, setAllowed] = useState<string | null>(null);

  useEffect(() => {
    if (isKnownNonMember(code)) router.replace(joinPath(code));
    else setAllowed(code);
  }, [code, router]);

  return allowed === code ? <LobbyScreen {...props} /> : <LobbyLoadingView />;
}
