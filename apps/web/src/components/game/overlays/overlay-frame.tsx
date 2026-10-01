"use client";

import { usePresence, usePresenceData, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type ReactNode, type RefObject, use, useEffect, useRef, useState } from "react";
import { de } from "../../../i18n/de";
import { cx } from "../../../lib/ui/cx";
import { panelMotion } from "../../../lib/ui/motion-presets";
import { DURATION_MS } from "../../../lib/ui/tokens";
import { OverlayLayoutContext } from "./overlay-layout";

export interface OverlayFrameProps {
  children: ReactNode;
  /** `data-testid` des Overlays (E2E), z. B. `overlay-question` */
  testId: string;
  /** Scrim hinter dem Inhalt (Intro, Spielende – docs/09 §7) */
  scrim?: boolean;
  /** Inhalt senkrecht zentrieren */
  center?: boolean;
  /**
   * Inhalt als Sheet am unteren Rand der Bühne (Zug-Ergebnis, docs/09 §7.7): ohne Seiten- und unteren Innenabstand
   * (das Sheet reicht bis an den Spielerstreifen und über die Spaltenbreite), ohne eigene Einblendung des Rahmens –
   * das Sheet fährt selbst hoch; was dabei unter der Bühne liegt, bleibt verdeckt.
   */
  sheet?: boolean;
  /**
   * Blendet schon innerhalb der Phase aus (docs/09 §7: Intro bei 3.700 ms, Kategorie-Einblendung bei 1.600 ms,
   * Auflösung bei 3.000 ms) – danach inert, `data-exiting` und beim Phasenwechsel sofort entfernt.
   */
  leaving?: boolean;
}

/**
 * Spätestens nach dieser Zeit gibt ein ausblendendes Overlay die Bühne frei (Ausblenden dauert 200 ms) –
 * auch wenn die Animation nicht läuft (Tab im Hintergrund, Overlay erst während des Ausblendens geladen).
 */
export const OVERLAY_EXIT_FALLBACK_MS = DURATION_MS.base + DURATION_MS.slow;

/**
 * Scrollt der Rahmen (Bühnen-Modus) gerade selbst, weil sein Inhalt höher ist als die Bühne (z. B. Flaggenfrage mit
 * Langtext bei 360 × 740)? Beobachtet Rahmen und Inhaltsspalte; außerhalb von `active` immer `false`.
 */
function useOwnScroll(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const frame = ref.current;
    if (!active || !frame) return;
    // ResizeObserver meldet jedes beobachtete Element gleich nach `observe` einmal und danach bei jeder Änderung.
    const observer = new ResizeObserver(() => setScrolls(frame.scrollHeight > frame.clientHeight + 1));
    observer.observe(frame);
    if (frame.firstElementChild) observer.observe(frame.firstElementChild);
    return () => observer.disconnect();
  }, [ref, active]);
  return active && scrolls;
}

/**
 * Rahmen jedes Bühnen-Overlays (docs/09 §7): füllt die Bühne, scrollt bei Bedarf selbst, blendet mit den
 * Bewegungs-Tokens ein (opacity 0 → 1, y 12 → 0, 320 ms emphasized) und aus (200 ms exit); bei reduzierter
 * Bewegung nur Überblendung. Muss in einem `MotionProvider` und `AnimatePresence` stehen (Stage).
 *
 * Übergang „cut“ (`AnimatePresence custom`, siehe `stageTransition`): Von der Frage in die Auflösung bleibt die
 * Karte stehen – das alte Overlay verschwindet vor dem nächsten Bild, das neue erscheint ohne Einblenden.
 *
 * Das Ausblenden steuert der Rahmen selbst (`usePresence` + `safeToRemove`) statt über `exit`: Die Overlays
 * kommen per `dynamic()` und werden beim ersten Mal erst nach dem Nachladen eingehängt. Mit `GAME_TIMING=fast`
 * (Phasen ab 150 ms) ist ein solches Overlay dann oft schon wieder „auf dem Weg nach draußen“, und motion
 * startete die `exit`-Animation dafür nie – das Overlay blieb stehen, und weil `AnimatePresence` ausblendende
 * Kinder nur gemeinsam entfernt, stapelten sich alle folgenden Overlays sichtbar übereinander. Hier wird jedes
 * Overlay nach dem Ausblenden (spätestens nach {@link OVERLAY_EXIT_FALLBACK_MS}) sicher entfernt. Ausblendende
 * Overlays sind inert (keine Klicks, kein Fokus, nicht vorgelesen) und tragen `data-exiting`.
 *
 * Niedrige Viewports (`OverlayLayoutContext` = `flow`, siehe game-screen.tsx): Das aktuelle Overlay steht im
 * Dokumentfluss und wächst mit seinem Inhalt (der ganze Spielscreen scrollt); ein ausblendendes liegt nur noch
 * absolut darüber, damit es keinen Platz mehr belegt.
 *
 * Tastatur (WCAG 2.1.1): Scrollt der Rahmen auf der Bühne selbst, ist er solange per Tab erreichbar (Bereich
 * „Spielfläche“) – sonst ließe er sich ohne bedienbare Elemente darin (Auflösung, eingeloggte Frage: gesperrte
 * Antworten liegen nicht im Tab-Pfad) nicht per Tastatur scrollen.
 */
export function OverlayFrame({
  children,
  testId,
  scrim = false,
  center = false,
  sheet = false,
  leaving = false,
}: OverlayFrameProps) {
  const reduce = useReducedMotion() ?? false;
  const flow = use(OverlayLayoutContext) === "flow";
  const [present, safeToRemove] = usePresence();
  // Übergang der Bühne (beim Einhängen der aktuelle, beim Entfernen der zum nachfolgenden Overlay)
  const transition: unknown = usePresenceData();
  const cut = transition === "cut";
  const motionProps = panelMotion(reduce);
  const hidden = !present || leaving;
  // Schon ausgeblendet oder „cut“: ohne Ausblenden entfernen. Unsichtbar (`invisible`) schon im selben
  // Commit, damit nie zwei Karten übereinander zu sehen sind; die Freigabe folgt im Effekt – erst nach dem
  // Layout-Effekt von AnimatePresence, der das ausblendende Kind registriert (vorher wäre sie wirkungslos).
  const removeNow = !present && (cut || leaving);
  // Im Fluss nur, solange es das aktuelle Overlay ist (auch beim Ausblenden innerhalb der Phase).
  const inFlow = flow && present;
  // Immer die aktuelle Freigabe-Funktion (sie wechselt mit jedem Render von AnimatePresence).
  const removeRef = useRef(safeToRemove);
  useEffect(() => {
    removeRef.current = safeToRemove;
  });
  const sectionRef = useRef<HTMLElement>(null);
  const scrolls = useOwnScroll(sectionRef, !flow && !hidden);

  useEffect(() => {
    if (removeNow) safeToRemove?.();
  }, [removeNow, safeToRemove]);

  useEffect(() => {
    if (present) return;
    const timer = window.setTimeout(() => removeRef.current?.(), OVERLAY_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [present]);

  return (
    <m.section
      ref={sectionRef}
      // Nur solange der Rahmen selbst scrollt: Tab-Stopp, damit er per Tastatur scrollbar ist (WCAG 2.1.1)
      tabIndex={scrolls ? 0 : undefined}
      aria-label={scrolls ? de.game.stage : undefined}
      initial={cut || sheet ? false : motionProps.initial}
      animate={hidden ? motionProps.exit : motionProps.animate}
      onAnimationComplete={() => {
        if (!present) removeRef.current?.();
      }}
      inert={hidden}
      data-testid={testId}
      data-exiting={hidden ? "true" : undefined}
      className={cx(
        inFlow
          ? cx("relative flex grow flex-col", sheet && "overflow-hidden")
          : cx("absolute inset-0", flow ? "overflow-hidden" : "overflow-y-auto overscroll-contain"),
        scrim && "bg-scrim",
        removeNow && "invisible",
      )}
    >
      <div
        className={cx(
          "mx-auto flex w-full max-w-column flex-col",
          sheet ? "justify-end pt-4" : "px-gutter py-4",
          inFlow ? "grow" : "min-h-full",
          center && "justify-center",
        )}
      >
        {children}
      </div>
    </m.section>
  );
}
