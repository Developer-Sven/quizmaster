import type { Metadata } from "next";
import { ErrorView } from "@/components/app/error-view";
import { OfflineRetryButton } from "@/components/pwa/offline-retry-button";
import { de } from "@/i18n/de";
import { WifiOffIcon } from "@/lib/ui/icons";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Offline-Seite `/offline` (docs/10, docs/09 §6): `EmptyState` mit `wifi-off`, „Du bist offline.“ und
 * „Erneut versuchen“. Der Service Worker cacht sie beim Install samt ihren `/_next/static`-Dateien und zeigt sie
 * für Navigationen ohne Netz. Ohne externe Ressourcen: keine API, kein Realtime, keine fremden Origins.
 * Dynamisch gerendert wie jede Seite (Root-Layout, CSP-Nonce) – die gecachte Kopie trägt Nonce und CSP derselben
 * Antwort.
 */
export default function OfflinePage() {
  return (
    <ErrorView testId="offline-page" icon={WifiOffIcon} message={de.pwa.offline} action={<OfflineRetryButton />} />
  );
}
