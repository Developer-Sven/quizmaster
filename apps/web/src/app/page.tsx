import { StartScreen } from "@/components/lobby/start-screen";
import { getPublicRuntimeConfig } from "@/lib/server/runtime-config";

interface StartPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Startseite `/` (docs/09 §6). Öffentliche Laufzeitwerte (Realtime-URL) kommen serverseitig als Props
 * (ADR-023). `?action=create|join` sind die PWA-Kurzbefehle (docs/10) und setzen nur den Fokus.
 */
export default async function StartPage({ searchParams }: StartPageProps) {
  const [{ action }, config] = await Promise.all([searchParams, getPublicRuntimeConfig()]);
  const focus = action === "create" || action === "join" ? action : null;
  return <StartScreen realtimeUrl={config.realtimeUrl} focus={focus} />;
}
