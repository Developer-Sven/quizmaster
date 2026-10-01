"use client";

import type { PublicPlayer } from "@quizmaster/shared";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { de } from "../../../i18n/de";
import { elapsedMs, introStage } from "../../../lib/client/phase-clock";
import { transitions } from "../../../lib/ui/motion-presets";
import { Avatar } from "../../ui/avatar";
import { CHOREOGRAPHY, enterMotion, PANEL_FROM } from "../choreography";
import { useOverlayClock } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";

export interface IntroOverlayProps {
  /** Teilnehmende in der ausgelosten Wahl-Reihenfolge */
  players: readonly PublicPlayer[];
  /** Serverzeit des Phasenbeginns (`phaseStartedAt`) – Anker der Choreografie */
  phaseStartedAt: number;
  /** Runde der Titelkarte (1) */
  round: number;
}

const INTRO = CHOREOGRAPHY.intro;

/**
 * Intro „Anpfiff“ (Phase `intro`, 4 s, docs/09 §7.1): 0–480 ms Scrim, dann fahren die Avatare 88 px
 * gestaffelt ein (60 ms, von unten 24 px, emphasized); 2 Personen links/rechts mit „VS“ (display, orange),
 * 3–8 im Raster plus Wahl-Reihenfolge. Bei 3.200 ms schiebt sich die Titelkarte „Runde 1“ hoch, bei 3.700 ms
 * blendet das Overlay aus. Alles relativ zu `phaseStartedAt` – nach einem Reconnect geht es an der richtigen
 * Stelle weiter (bereits gelaufene Bewegungen stehen sofort im Endzustand).
 *
 * Die Personen blenden für die Titelkarte nur aus und behalten ihren Platz (unsichtbar, für Screenreader
 * verborgen): Würden sie entfernt, schrumpfte die mittig ausgerichtete Rasterzelle und die Titelkarte spränge
 * um die halbe Höhendifferenz (bei 5–8 Personen 80 px – Layout-Sprung, CLS).
 */
export function IntroOverlay({ players, phaseStartedAt, round }: IntroOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const { now, enteredAt } = useOverlayClock(phaseStartedAt, [
    phaseStartedAt + INTRO.titleAtMs,
    phaseStartedAt + INTRO.exitAtMs,
  ]);
  const elapsed = elapsedMs(phaseStartedAt, now);
  const stage = introStage(elapsed);
  const people = stage === "people";
  const duel = players.length === 2;

  const avatar = (position: number) =>
    enterMotion(
      {
        at: INTRO.avatarsAtMs + position * INTRO.avatarStaggerMs,
        duration: INTRO.enterMs,
        from: { opacity: 0, y: INTRO.avatarRisePx },
      },
      enteredAt,
      reduce,
    );
  // „VS“ bzw. die Wahl-Reihenfolge folgen direkt nach dem letzten Avatar.
  const afterAvatars = enterMotion(
    { at: INTRO.avatarsAtMs + players.length * INTRO.avatarStaggerMs, duration: INTRO.enterMs, from: PANEL_FROM },
    enteredAt,
    reduce,
  );
  // Die Titelkarte wird erst zu ihrem Zeitpunkt eingehängt: Einstieg = jetzt (bzw. später beim Fortsetzen).
  const title = enterMotion(
    { at: INTRO.titleAtMs, duration: INTRO.enterMs, from: { opacity: 0, y: INTRO.titleRisePx } },
    elapsed,
    reduce,
  );

  return (
    <OverlayFrame testId="overlay-intro" scrim center leaving={stage === "done"}>
      {/* Personen und Titelkarte liegen übereinander (gleiche Rasterzelle) – kein Sprung beim Wechsel */}
      <div className="grid">
        <m.div
          aria-hidden={people ? undefined : true}
          initial={false}
          animate={{ opacity: people ? 1 : 0 }}
          transition={reduce ? transitions.fade : transitions.exit}
          className="col-start-1 row-start-1 flex flex-col items-center gap-8"
        >
          {duel ? (
            // Bei großer Schrift bricht die zweite Person in eine neue Zeile um, statt über den Rand zu ragen
            <div className="flex w-full flex-wrap items-center justify-center gap-4">
              {players.map((player, position) => (
                <m.div
                  key={player.id}
                  {...avatar(position)}
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
              <m.span {...afterAvatars} className="order-2 text-display text-primary">
                {de.game.versus}
              </m.span>
            </div>
          ) : (
            <>
              <ul className="flex flex-wrap justify-center gap-4">
                {players.map((player, position) => (
                  <m.li key={player.id} {...avatar(position)} className="flex">
                    <Avatar name={player.name} color={player.color} size={88} label={player.name} />
                  </m.li>
                ))}
              </ul>
              <m.ol {...afterAvatars} className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-label text-text-2">
                {players.map((player, position) => (
                  <li key={player.id} className="flex items-baseline gap-1">
                    <span className="text-text tabular-nums">{position + 1}</span>
                    <span>{player.name}</span>
                  </li>
                ))}
              </m.ol>
            </>
          )}
        </m.div>
        <AnimatePresence>
          {people ? null : (
            <m.div
              key="title"
              {...title}
              className="col-start-1 row-start-1 self-center justify-self-center rounded-xl border border-line bg-surface-1 px-8 py-6 shadow-level-2"
            >
              <h2 className="text-h1 text-text">{de.game.roundTitle(round)}</h2>
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </OverlayFrame>
  );
}
