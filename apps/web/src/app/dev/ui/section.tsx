import type { ReactNode } from "react";

/** Abschnitt der Musterseite mit Überschrift (nur /dev/ui). */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-6 border-t border-line py-8">
      <h2 id={`${id}-title`} className="text-h2 text-text">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Ein Zustand einer Komponente mit Beschriftung (nur /dev/ui). */
export function Demo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-text-2">{label}</p>
      {children}
    </div>
  );
}

/** Unterüberschrift je Komponente (nur /dev/ui). */
export function ComponentTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-title text-text">{children}</h3>;
}
