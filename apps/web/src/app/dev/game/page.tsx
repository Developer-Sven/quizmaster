import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GamePreview } from "./game-preview";
import { isPreviewViewId, type PreviewPlayers } from "./sample-states";

export const metadata: Metadata = {
  title: "Spiel-Vorschau",
  robots: { index: false, follow: false },
};

interface DevGamePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * /dev/game – jede Spielphase und jedes Overlay mit Beispiel-Zuständen (2, 6 und 8 Personen) ohne Server,
 * für Design-Reviews und Screenshots. Nur in Entwicklung erreichbar, in Produktion 404.
 * Aufruf: `/dev/game?view=question&players=6` (ohne `view` die Übersicht).
 */
export default async function DevGamePage({ searchParams }: DevGamePageProps) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view, players } = await searchParams;
  const count: PreviewPlayers = players === "8" ? 8 : players === "6" ? 6 : 2;
  return <GamePreview view={isPreviewViewId(view) ? view : null} players={count} />;
}
