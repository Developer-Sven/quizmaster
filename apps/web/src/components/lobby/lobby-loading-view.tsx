import { AppHeader, HeaderTitle } from "@/components/app/app-header";
import { AppShell } from "@/components/app/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { de } from "@/i18n/de";

/** Ladezustand der Lobby-Seite (docs/09 Regel 11: Skeleton statt leerer Fläche). */
export function LobbyLoadingView() {
  return (
    <AppShell testId="lobby-loading" header={<AppHeader title={<HeaderTitle>{de.lobby.title}</HeaderTitle>} />}>
      <div aria-busy="true" className="flex flex-col gap-8">
        <span className="sr-only">{de.a11y.loading}</span>
        <Skeleton shape="block" />
        <div className="flex flex-col gap-3">
          <Skeleton shape="text" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Skeleton shape="avatar" />
              <Skeleton shape="text" />
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
