import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LobbyEntry } from "@/components/lobby/lobby-entry";
import { de } from "@/i18n/de";
import { displayLobbyCode, lobbyCodeFromParam } from "@/lib/client/lobby-code";
import { lobbyPath } from "@/lib/client/paths";
import { getMaintenanceNotice } from "@/lib/server/maintenance";
import { getPublicRuntimeConfig } from "@/lib/server/runtime-config";

export const metadata: Metadata = {
  title: de.lobby.title,
  robots: { index: false, follow: false },
};

interface LobbyPageProps {
  params: Promise<{ code: string }>;
}

/**
 * Lobby und Spiel `/lobby/[code]` (docs/02, docs/09 §6–7). Nur diese Seite lädt den Socket.IO-Client
 * (docs/07). Ungültige Codes → 404; andere Schreibweisen → kanonischer Pfad.
 */
export default async function LobbyPage({ params }: LobbyPageProps) {
  const { code: raw } = await params;
  const code = lobbyCodeFromParam(raw);
  if (!code) notFound();
  if (raw !== code) redirect(lobbyPath(code));
  const [config, maintenance] = await Promise.all([getPublicRuntimeConfig(), getMaintenanceNotice()]);
  // Dev-Bots nur, wenn auch der Realtime-Server sie erlaubt (docs/05 §Dev-Bots; zod-validiert, nie in Produktion).
  return (
    <LobbyEntry
      code={code}
      displayCode={displayLobbyCode(code)}
      realtimeUrl={config.realtimeUrl}
      devBots={config.devBots}
      turnstile={config.turnstile}
      maintenance={maintenance}
    />
  );
}
