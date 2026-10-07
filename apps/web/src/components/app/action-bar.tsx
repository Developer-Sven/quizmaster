import type { ReactNode } from "react";
import { cx } from "../../lib/ui/cx";
import { StickyInset } from "./sticky-inset";

/**
 * Aktionsleiste (docs/09 §4): unten, sticky, Hauptaktion mit 16 px Rand + Safe Area. Höchstens eine
 * orange Hauptaktion pro Screen (Regel 8); wer nichts tun kann, sieht einen Wartetext. Ihre Höhe hält das
 * Dokument als `scroll-padding-bottom` frei – fokussierte Elemente landen nie unter ihr (WCAG 2.4.11).
 */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-hud border-t border-line bg-bg pt-4 pb-safe">
      <StickyInset edge="bottom" />
      <div className="mx-auto flex w-full max-w-column flex-col gap-3 px-gutter">{children}</div>
    </div>
  );
}

/**
 * Wartetext in der Aktionsleiste, z. B. „Warte auf Mia …“ (text-2, zentriert, Höhe wie ein Button – bei
 * Text-Zoom wächst er mit, statt überzulaufen). `compact`: Höhe wie ein kompakter Button (44) – so steht derselbe
 * Hinweis im Spiel in der Zone des Spielerstreifens (ADR-060), sonst gleich wie in der Lobby.
 */
export function ActionBarNote({
  children,
  testId,
  compact = false,
}: {
  children: ReactNode;
  testId?: string;
  compact?: boolean;
}) {
  return (
    <p
      data-testid={testId}
      className={cx(
        "flex items-center justify-center text-center text-body text-text-2 wrap-break-word",
        compact ? "min-h-11" : "min-h-14",
      )}
    >
      {children}
    </p>
  );
}
