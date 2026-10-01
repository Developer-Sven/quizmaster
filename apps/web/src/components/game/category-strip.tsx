"use client";

import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CategoryIcon } from "@/components/ui/category-icon";
import { CategoryTile } from "@/components/ui/category-tile";
import { useClientClock } from "@/lib/client/clock-context";
import { toServerTime } from "@/lib/client/phase-clock";
import { type CategoryVisual, categoryColorStyle } from "@/lib/ui/category";
import { MotionProvider } from "@/lib/ui/motion";
import { transitions } from "@/lib/ui/motion-presets";
import { DURATION_MS, EASING, seconds } from "@/lib/ui/tokens";
import { selectOffset, useGameStore } from "@/stores/game-store";
import { type Box, CHOREOGRAPHY, type FlightPath, flightPath, motionPlan } from "./choreography";

/** Eine Kategorie kommt im Streifen an (Kategorie-Einblendung, docs/09 §7.3). */
export interface CategoryArrival {
  /** eindeutig je Einblendung (z. B. `phaseStartedAt` des Vorlaufs) */
  id: string;
  /** Serverzeit des Beginns der Einblendung */
  at: number;
  /** gewählte Kategorie – Quelle des Flugs ist ihre Kachel in der (gerade ausblendenden) Kategoriewahl */
  categoryId: string;
}

export interface CategoryStripProps {
  /** Kategorie des laufenden Zuges; `null` vor der Wahl (Höhe bleibt, keine Layout-Sprünge) */
  category: CategoryVisual | null;
  /** „1/3“ (Frage x/K) oder `null` */
  fraction: string | null;
  /** Ankunft der gewählten Kategorie (nur während der Kategorie-Einblendung) */
  arrival?: CategoryArrival | null;
}

const FLIGHT = CHOREOGRAPHY.categoryReveal;

/** Der Inhalt des Streifens blendet ein, während die fliegende Kachel landet (letzte 30 % des Flugs). */
const LANDING = 0.7;

/** Sicherheitsnetz: der Flug-Geist verschwindet auch, wenn die Animation nicht läuft (Tab im Hintergrund). */
const GHOST_FALLBACK_MS = FLIGHT.flightMs + DURATION_MS.slow;

interface Landing {
  id: string;
  flight: FlightPath | null;
}

interface Ghost {
  id: string;
  path: FlightPath;
  category: CategoryVisual;
}

function boxOf(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Kachel der gewählten Kategorie in der Kategoriewahl (ausblendend, aber noch im DOM). */
function findPickedTile(categoryId: string): Element | null {
  for (const overlay of document.querySelectorAll('[data-testid="overlay-category-pick"]')) {
    for (const tile of overlay.querySelectorAll("[data-category-id]")) {
      if (tile.getAttribute("data-category-id") === categoryId) return tile;
    }
  }
  return null;
}

/**
 * Kategoriestreifen (docs/09 §7): 44 px unter dem HUD, 4-px-Farbstreifen links (einer der drei Orte für
 * Kategoriefarben), Icon + Name, rechts Frage x/K. Bei großer Schrift bricht der Name um und der Streifen
 * wächst (WCAG 1.4.4) – 44 px bleiben die Mindesthöhe.
 *
 * Kategorie-Einblendung (docs/09 §7.3): Die gewählte Kachel wandert per Shared-Layout-Animation (320 ms,
 * emphasized) in den Streifen – umgesetzt als FLIP nur mit transform/opacity (`LazyMotion` + `domAnimation`
 * hat keine Layout-Animationen): Ein Abbild der Kachel startet genau über der Kachel der Kategoriewahl,
 * verkleinert sich gleichmäßig auf die Streifenhöhe und landet links im Streifen, dessen Inhalt dabei
 * einblendet. Ohne Quelle (Einstieg nach einem Reconnect, Kategoriewahl nicht gesehen), bei spätem Einstieg
 * und bei reduzierter Bewegung blendet der Inhalt nur ein (≤ 200 ms).
 */
export function CategoryStrip({ category, fraction, arrival = null }: CategoryStripProps) {
  const reduce = useReducedMotion() ?? false;
  const offset = useGameStore(selectOffset);
  const { now: clock } = useClientClock();
  const rowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  // Bis zur Entscheidung (Flug oder Überblendung, vor dem ersten Zeichnen) bleibt der neue Inhalt unsichtbar.
  const deciding = arrival !== null && landing?.id !== arrival.id;

  useLayoutEffect(() => {
    if (!arrival || landing?.id === arrival.id) return;
    let flight: FlightPath | null = null;
    const late = toServerTime(clock(), offset) - arrival.at > FLIGHT.flightLateMs;
    const source = !late && motionPlan(reduce).flight ? findPickedTile(arrival.categoryId) : null;
    const row = rowRef.current;
    const content = contentRef.current;
    if (source && row && content && category) {
      const rowBox = row.getBoundingClientRect();
      const contentBox = content.getBoundingClientRect();
      const target: Box = { left: contentBox.left, top: rowBox.top, width: contentBox.width, height: rowBox.height };
      flight = flightPath(boxOf(source.getBoundingClientRect()), target, contentBox.left);
      setGhost({ id: arrival.id, path: flight, category });
    }
    setLanding({ id: arrival.id, flight });
  }, [arrival, landing, category, clock, offset, reduce]);

  useEffect(() => {
    if (!ghost) return;
    const timer = window.setTimeout(() => setGhost(null), GHOST_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [ghost]);

  const contentTransition = landing?.flight
    ? {
        duration: seconds(FLIGHT.flightMs * (1 - LANDING)),
        ease: EASING.standard,
        delay: seconds(FLIGHT.flightMs * LANDING),
      }
    : transitions.fade;

  return (
    <MotionProvider>
      <div data-testid="category-strip" className="border-b border-line bg-surface-1">
        <div ref={rowRef} className="relative mx-auto flex min-h-11 w-full max-w-column items-center px-gutter py-1">
          {category ? (
            <m.span
              key={category.name}
              ref={contentRef}
              initial={arrival ? { opacity: 0 } : false}
              animate={{ opacity: deciding ? 0 : 1 }}
              transition={contentTransition}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <span
                aria-hidden="true"
                style={categoryColorStyle(category.color)}
                className="absolute inset-y-0 left-0 w-1 bg-cat"
              />
              <CategoryIcon icon={category.icon} color={category.color} size={20} />
              <span className="min-w-0 flex-1 text-label text-balance text-text">{category.name}</span>
              {fraction ? <span className="shrink-0 text-label text-text-2 tabular-nums">{fraction}</span> : null}
            </m.span>
          ) : null}
        </div>
      </div>
      {ghost ? (
        <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-overlay">
          <div className="mx-auto w-full max-w-column px-gutter">
            <m.div
              key={ghost.id}
              className="origin-top-left"
              initial={{ x: ghost.path.from.x, y: ghost.path.from.y, scale: 1, opacity: 1 }}
              animate={{ x: ghost.path.to.x, y: ghost.path.to.y, scale: ghost.path.to.scale, opacity: 0 }}
              transition={{
                duration: seconds(FLIGHT.flightMs),
                ease: EASING.emphasized,
                // deckend bis zur Landung, dann Überblendung mit dem Inhalt des Streifens
                opacity: {
                  delay: seconds(FLIGHT.flightMs * LANDING),
                  duration: seconds(FLIGHT.flightMs * (1 - LANDING)),
                  ease: EASING.exit,
                },
              }}
              onAnimationComplete={() => setGhost(null)}
            >
              <CategoryTile category={ghost.category} selected viewOnly />
            </m.div>
          </div>
        </div>
      ) : null}
    </MotionProvider>
  );
}
