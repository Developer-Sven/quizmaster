import type { ReactNode } from "react";
import { StickyInset } from "./sticky-inset";

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
 * Bleibt oben stehen, respektiert die Safe Area im Standalone-Modus. Bei Text-Zoom wächst sie mit dem Titel
 * (WCAG 1.4.4); ihre Höhe hält das Dokument als `scroll-padding-top` frei (WCAG 2.4.11).
 * Wird die Spalte schmaler als 16 rem (Container-Abfrage in rem: etwa ab 150 % Text-Zoom bei 360 px), stehen die
 * Icons oben links und rechts und der Titel in voller Breite darunter – zwischen den mitwachsenden Icons bliebe ihm
 * sonst kaum Platz für zwei Buchstaben. Lese- und Tab-Reihenfolge bleiben links · Titel · rechts.
 */
export function AppHeader({ left, title, right }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-hud border-b border-line bg-bg pt-safe">
      <StickyInset edge="top" />
      <div className="@container mx-auto w-full max-w-column px-gutter">
        <div className="flex min-h-14 flex-wrap items-center gap-2 @max-3xs:justify-between @max-3xs:pb-2">
          <div className="flex w-11 shrink-0 justify-start">{left}</div>
          <div className="flex min-w-0 flex-1 justify-center text-center @max-3xs:order-last @max-3xs:basis-full">
            {title}
          </div>
          <div className="flex w-11 shrink-0 justify-end">{right}</div>
        </div>
      </div>
    </header>
  );
}

/**
 * Screen-Titel in der Kopfzeile (Stil `h1`, bei 100 % eine Zeile). Bricht bei Text-Zoom um statt abgeschnitten
 * zu werden (WCAG 1.4.4) – zur Not auch innerhalb eines Wortes, nie über den Rand.
 */
export function HeaderTitle({ children }: { children: ReactNode }) {
  return <h1 className="min-w-0 text-h1 text-text wrap-break-word hyphens-auto">{children}</h1>;
}
