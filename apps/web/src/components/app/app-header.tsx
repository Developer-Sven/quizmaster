import type { ReactNode } from "react";

export interface AppHeaderProps {
  /** links: zurück/verlassen (IconButton 44) */
  left?: ReactNode;
  /** Mitte: Titel oder Fortschritt */
  title?: ReactNode;
  /** rechts: Einstellungen, Ton, Menü (IconButton 44) */
  right?: ReactNode;
}

/**
 * Kopfzeile (docs/09 §4): 56 px, links zurück/verlassen, Mitte Titel/Fortschritt, rechts Aktion.
 * Bleibt oben stehen, respektiert die Safe Area im Standalone-Modus.
 */
export function AppHeader({ left, title, right }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-hud border-b border-line bg-bg pt-safe">
      <div className="mx-auto flex h-14 w-full max-w-column items-center gap-2 px-gutter">
        <div className="flex w-11 shrink-0 justify-start">{left}</div>
        <div className="flex min-w-0 flex-1 justify-center text-center">{title}</div>
        <div className="flex w-11 shrink-0 justify-end">{right}</div>
      </div>
    </header>
  );
}

/** Screen-Titel in der Kopfzeile (Stil `h1`, eine Zeile). */
export function HeaderTitle({ children }: { children: ReactNode }) {
  return <h1 className="truncate text-h1 text-text">{children}</h1>;
}
