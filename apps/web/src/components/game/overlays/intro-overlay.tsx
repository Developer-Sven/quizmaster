"use client";

import type { PublicPlayer } from "@quizmaster/shared";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { de } from "@/i18n/de";
import { elapsedMs, INTRO_TIMELINE, introStage } from "@/lib/client/phase-clock";
import { useServerNow } from "@/lib/client/use-server-clock";
import { transitions } from "@/lib/ui/motion-presets";
import { DURATION_MS, EASING, STAGGER_MS, seconds } from "@/lib/ui/tokens";
import { OverlayFrame } from "./overlay-frame";

export interface IntroOverlayProps {
  /** Teilnehmende in der ausgelosten Wahl-Reihenfolge */
  players: readonly PublicPlayer[];
  /** Serverzeit des Phasenbeginns (`phaseStartedAt`) */
  phaseStartedAt: number;
  /** Runde der Titelkarte (1) */
  round: number;
}

/** Avatare fahren 24 px von unten ein (docs/09 §7.1). */
const RISE_PX = 24;

/**
 * Intro „Anpfiff“ (Phase `intro`, 4 s, docs/09 §7.1): Scrim, Avatare 88 px gestaffelt (60 ms);
 * 2 Personen links/rechts mit „VS“, 3–8 im Raster plus Wahl-Reihenfolge; ab 3.200 ms Titelkarte
 * „Runde 1“, ab 3.700 ms Ausblenden. Zeitpunkte relativ zu `phaseStartedAt` (Serverzeit) – nach einem
 * Reconnect setzt das Overlay an der richtigen Stelle fort.
 */
export function IntroOverlay({ players, phaseStartedAt, round }: IntroOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const now = useServerNow([phaseStartedAt + INTRO_TIMELINE.titleAtMs, phaseStartedAt + INTRO_TIMELINE.exitAtMs]);
  const stage = introStage(elapsedMs(phaseStartedAt, now));
  // Zeitpunkt des Einblendens relativ zum Phasenbeginn: bereits vergangene Staffelungen entfallen.
  const [enteredAt] = useState(() => elapsedMs(phaseStartedAt, now));
  const duel = players.length === 2;

  const rise = (position: number) => {
    const delayMs = INTRO_TIMELINE.scrimMs + position * STAGGER_MS.people - enteredAt;
    const done = delayMs + DURATION_MS.slow <= 0;
    return {
      initial: done ? false : { opacity: 0, y: reduce ? 0 : RISE_PX },
      animate: { opacity: 1, y: 0 },
      transition: {
        duration: seconds(reduce ? DURATION_MS.base : DURATION_MS.slow),
        ease: EASING.emphasized,
        delay: seconds(Math.max(0, delayMs)),
      },
    } as const;
  };

  return (
    <OverlayFrame testId="overlay-intro" scrim center>
      <AnimatePresence mode="wait" initial={false}>
        {stage === "people" ? (
          <m.div
            key="people"
            exit={{ opacity: 0, transition: transitions.exit }}
            className="flex flex-col items-center gap-8"
          >
            {duel ? (
              <div className="flex w-full items-center justify-center gap-4">
                {players.map((player, position) => (
                  <m.div
                    key={player.id}
                    {...rise(position)}
                    className={
                      position === 0
                        ? "order-1 flex min-w-0 flex-col items-center gap-2"
                        : "order-3 flex min-w-0 flex-col items-center gap-2"
                    }
                  >
                    <Avatar name={player.name} color={player.color} size={88} />
                    <span className="max-w-28 truncate text-label text-text">{player.name}</span>
                  </m.div>
                ))}
                <span className="order-2 text-display text-primary">{de.game.versus}</span>
              </div>
            ) : (
              <>
                <ul className="flex flex-wrap justify-center gap-4">
                  {players.map((player, position) => (
                    <m.li key={player.id} {...rise(position)} className="flex">
                      <Avatar name={player.name} color={player.color} size={88} label={player.name} />
                    </m.li>
                  ))}
                </ul>
                <ol className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-label text-text-2">
                  {players.map((player, position) => (
                    <li key={player.id} className="flex items-baseline gap-1">
                      <span className="text-text tabular-nums">{position + 1}</span>
                      <span>{player.name}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </m.div>
        ) : stage === "title" ? (
          <m.div
            key="title"
            initial={{ opacity: 0, y: reduce ? 0 : RISE_PX }}
            animate={{ opacity: 1, y: 0, transition: reduce ? transitions.fade : transitions.enter }}
            exit={{ opacity: 0, transition: transitions.exit }}
            className="self-center rounded-xl border border-line bg-surface-1 px-8 py-6 shadow-level-2"
          >
            <h2 className="text-h1 text-text">{de.game.roundTitle(round)}</h2>
          </m.div>
        ) : null}
      </AnimatePresence>
    </OverlayFrame>
  );
}
