import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { JoinScreen } from "@/components/lobby/join-screen";
import { de } from "@/i18n/de";
import { displayLobbyCode, lobbyCodeFromParam } from "@/lib/client/lobby-code";
import { joinPath } from "@/lib/client/paths";
import { getMaintenanceNotice } from "@/lib/server/maintenance";
import { getPublicRuntimeConfig } from "@/lib/server/runtime-config";

export const metadata: Metadata = {
  title: de.actions.join,
  robots: { index: false, follow: false },
};

interface JoinPageProps {
  params: Promise<{ code: string }>;
}

/**
 * Kurzlink `/j/[code]` aus Einladung und QR-Code (docs/09 §6): Code steht fest, nur Name + „Beitreten“.
 * Ungültige Codes → 404 („Lobby nicht gefunden“); Schreibweisen wie `/j/abc-234` → `/j/ABC234`.
 */
export default async function JoinPage({ params }: JoinPageProps) {
  const { code: raw } = await params;
  const code = lobbyCodeFromParam(raw);
  if (!code) notFound();
  if (raw !== code) redirect(joinPath(code));
  const [config, maintenance] = await Promise.all([getPublicRuntimeConfig(), getMaintenanceNotice()]);
  return (
    <JoinScreen
      code={code}
      displayCode={displayLobbyCode(code)}
      realtimeUrl={config.realtimeUrl}
      turnstile={config.turnstile}
      maintenance={maintenance}
    />
  );
}
