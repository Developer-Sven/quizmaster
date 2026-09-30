"use client";

import { ControlsSection } from "./controls-section";
import { GameSection } from "./game-section";
import { LayersSection } from "./layers-section";
import { PeopleSection } from "./people-section";
import { TokensSection } from "./tokens-section";

const SECTIONS = [
  { id: "tokens", title: "Tokens" },
  { id: "controls", title: "Bedienelemente" },
  { id: "people", title: "Personen" },
  { id: "game", title: "Spiel" },
  { id: "layers", title: "Ebenen" },
] as const;

/** Musterseite des Designsystems: jede Komponente aus docs/09 §5 in allen Zuständen. */
export function Showcase() {
  return (
    <main className="mx-auto w-full max-w-column px-gutter pt-safe pb-safe">
      <header className="flex flex-col gap-2 py-8">
        <h1 className="text-h1 text-text">Designsystem</h1>
        <p className="text-body text-text-2">Quiz-Studio bei Nacht · docs/09</p>
        <nav aria-label="Abschnitte" className="flex flex-wrap gap-x-4 gap-y-2 pt-2">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`} className="text-label text-text-2 underline underline-offset-4">
              {section.title}
            </a>
          ))}
        </nav>
      </header>
      <TokensSection />
      <ControlsSection />
      <PeopleSection />
      <GameSection />
      <LayersSection />
    </main>
  );
}
