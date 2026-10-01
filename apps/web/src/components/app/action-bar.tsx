import type { ReactNode } from "react";

/**
 * Aktionsleiste (docs/09 §4): unten, sticky, Hauptaktion mit 16 px Rand + Safe Area. Höchstens eine
 * orange Hauptaktion pro Screen (Regel 8); wer nichts tun kann, sieht einen Wartetext.
 */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-hud border-t border-line bg-bg pt-4 pb-safe">
      <div className="mx-auto flex w-full max-w-column flex-col gap-3 px-gutter">{children}</div>
    </div>
  );
}

/** Wartetext in der Aktionsleiste, z. B. „Warte auf Mia …“ (text-2, zentriert, Höhe wie ein Button). */
export function ActionBarNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p data-testid={testId} className="flex h-14 items-center justify-center text-center text-body text-text-2">
      {children}
    </p>
  );
}
