"use client";

import type { CategoryOption, PublicPlayer } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Avatar } from "@/components/ui/avatar";
import { CategoryTile } from "@/components/ui/category-tile";
import { TimerRing } from "@/components/ui/timer-ring";
import { de } from "@/i18n/de";
import { categoryShortcut, claimGroupFocus, readShortcutGuard } from "@/lib/client/keyboard";
import { transitions } from "@/lib/ui/motion-presets";
import { CHOREOGRAPHY, enterMotion, motionPlan, PANEL_FROM, pickHighlight, wanderBoundaries } from "../choreography";
import { useOverlayClock, useTimerRun } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";

export interface CategoryPickOverlayProps {
  /** die drei angebotenen Kategorien (für alle gleich) */
  options: readonly CategoryOption[];
  /** wählende Person */
  picker: PublicPlayer | undefined;
  /** darf diese Person jetzt wählen? (`lobby:self.canPick`, noch keine Wahl) */
  canPick: boolean;
  /** gewählte Kategorie (Server oder eigene, gerade gesendete Wahl) */
  pickedId: string | null;
  /** Serverzeit des Phasenbeginns – Anker der Choreografie */
  phaseStartedAt: number;
  phaseEndsAt: number | null;
  /** Identität des Timer-Laufs (neu nach Resync) */
  timerRunId: string;
  onPick: (categoryId: string) => void;
}

const PICK = CHOREOGRAPHY.pick;

/**
 * Kategoriewahl (Phase `category_pick`, 15 s, docs/09 §7.2): wählende Person „Wähle eine Kategorie“,
 * alle anderen „Mia wählt eine Kategorie“ mit Avatar; drei Kacheln (Einflug gestaffelt 40 ms), `TimerRing`
 * rechts oben. Zuschauende sehen die Kacheln view-only mit einem ruhig wandernden 2-px-Rahmen (1,2-s-Takt ab
 * Phasenbeginn – bei allen gleichzeitig), der bei der Wahl sofort stoppt; nach der Wahl bleibt die gewählte
 * Kachel `selected`, die anderen blenden aus (200 ms). Reduzierte Bewegung: kein wandernder Rahmen.
 * Tastatur: `1`–`3`, solange der Fokus in der Kachelgruppe liegt (WCAG 2.1.4, lib/client/keyboard.ts).
 */
export function CategoryPickOverlay({
  options,
  picker,
  canPick,
  pickedId,
  phaseStartedAt,
  phaseEndsAt,
  timerRunId,
  onPick,
}: CategoryPickOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const picked = pickedId !== null;
  const interactive = canPick && !picked;
  const wandering = !canPick && !picked && motionPlan(reduce).wander;
  const { now, enteredAt } = useOverlayClock(
    phaseStartedAt,
    wandering ? wanderBoundaries(phaseStartedAt, phaseEndsAt) : [],
  );
  const highlight = wandering ? pickHighlight(phaseStartedAt, now, options.length).index : -1;
  const timer = useTimerRun(phaseEndsAt, timerRunId);
  const duration = phaseEndsAt === null ? 0 : phaseEndsAt - phaseStartedAt;
  const title = canPick ? de.game.pickSelf : de.game.pickOther(picker?.name ?? "");
  const groupRef = useRef<HTMLFieldSetElement>(null);

  // Wer wählt, bekommt den Fokus in die Kachelgruppe (nur wenn er frei ist): Kürzel 1–3 wirken sofort,
  // Screenreader sagen die Gruppe an.
  useEffect(() => {
    const group = groupRef.current;
    if (interactive && group) claimGroupFocus(group, group.closest("[data-stage]"));
  }, [interactive]);

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if (!interactive) return;
    const index = categoryShortcut(event, readShortcutGuard(event.currentTarget), options.length);
    const option = index === null ? undefined : options[index];
    if (!option) return;
    event.preventDefault();
    onPick(option.id);
  };

  return (
    <OverlayFrame testId="overlay-category-pick">
      <div className="flex min-h-12 items-center gap-3 pb-4">
        {!canPick && picker ? <Avatar name={picker.name} color={picker.color} size={40} /> : null}
        <h2 className="min-w-0 flex-1 text-h2 text-text">{title}</h2>
        {!picked && timer.remainingMs !== null && duration > 0 ? (
          <TimerRing runId={timer.runId} remainingMs={timer.remainingMs} durationMs={duration} />
        ) : null}
      </div>
      <fieldset
        ref={groupRef}
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-col gap-3 rounded-lg"
      >
        {options.map((option, position) => {
          const selected = option.id === pickedId;
          const faded = picked && !selected;
          const entrance = enterMotion(
            { at: position * PICK.tileStaggerMs, duration: PICK.enterMs, from: PANEL_FROM },
            enteredAt,
            reduce,
          );
          return (
            <m.div
              key={option.id}
              data-testid="category-option"
              data-category-id={option.id}
              initial={entrance.initial}
              animate={{ ...entrance.animate, opacity: faded ? 0 : 1 }}
              transition={faded ? transitions.fade : entrance.transition}
              aria-hidden={faded || undefined}
            >
              <CategoryTile
                category={option}
                selected={selected}
                highlighted={position === highlight}
                viewOnly={!interactive}
                onSelect={() => onPick(option.id)}
                shortcut={String(position + 1)}
              />
            </m.div>
          );
        })}
      </fieldset>
    </OverlayFrame>
  );
}
