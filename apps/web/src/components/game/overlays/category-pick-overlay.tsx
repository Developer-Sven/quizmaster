"use client";

import type { CategoryOption, PublicPlayer } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { CategoryTile } from "@/components/ui/category-tile";
import { TimerRing } from "@/components/ui/timer-ring";
import { de } from "@/i18n/de";
import { elapsedMs, PICK_HIGHLIGHT_STEP_MS, pickHighlightIndex, remainingMs } from "@/lib/client/phase-clock";
import { useServerNow, useTicker } from "@/lib/client/use-server-clock";
import { transitions } from "@/lib/ui/motion-presets";
import { categoryIndexForKey } from "@/lib/ui/shortcuts";
import { OFFSET_PX, STAGGER_MS, seconds } from "@/lib/ui/tokens";
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
  phaseStartedAt: number;
  phaseEndsAt: number | null;
  /** Identität des Timer-Laufs (neu nach Resync) */
  timerRunId: string;
  onPick: (categoryId: string) => void;
}

/**
 * Kategoriewahl (Phase `category_pick`, 15 s, docs/09 §7.2): wählende Person „Wähle eine Kategorie“,
 * alle anderen „Mia wählt eine Kategorie“ mit Avatar; drei Kacheln (gestaffelt 40 ms), `TimerRing`
 * rechts oben. Zuschauende sehen die Kacheln view-only mit einem ruhig wandernden Rahmen (1,2 s), der bei
 * der Wahl stoppt; nach der Wahl bleibt die gewählte Kachel `selected`, die anderen blenden aus (200 ms).
 * Tastatur: 1–3 (Fokus in der Kachelgruppe).
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
  const now = useServerNow([]);
  const [enteredAt] = useState(() => elapsedMs(phaseStartedAt, now));
  const picked = pickedId !== null;
  const interactive = canPick && !picked;
  const wandering = !canPick && !picked && !reduce;
  const tick = useTicker(PICK_HIGHLIGHT_STEP_MS, wandering);
  const highlight = wandering ? (pickHighlightIndex(enteredAt, options.length) + tick) % options.length : -1;
  const remaining = remainingMs(phaseEndsAt, now);
  const duration = phaseEndsAt === null ? 0 : phaseEndsAt - phaseStartedAt;
  const title = canPick ? de.game.pickSelf : de.game.pickOther(picker?.name ?? "");
  const groupRef = useRef<HTMLFieldSetElement>(null);

  // Wer wählt, bekommt den Fokus in die Kachelgruppe: Kürzel 1–3 wirken sofort, Screenreader sagen die Gruppe an.
  useEffect(() => {
    if (interactive) groupRef.current?.focus({ preventScroll: true });
  }, [interactive]);

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if (!interactive) return;
    const index = categoryIndexForKey(event);
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
        {!picked && remaining !== null && duration > 0 ? (
          <TimerRing runId={timerRunId} remainingMs={remaining} durationMs={duration} />
        ) : null}
      </div>
      <fieldset
        ref={groupRef}
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="min-w-0 flex flex-col gap-3 outline-none"
      >
        {options.map((option, position) => {
          const selected = option.id === pickedId;
          const faded = picked && !selected;
          return (
            <m.div
              key={option.id}
              data-testid="category-option"
              data-category-id={option.id}
              initial={{ opacity: 0, y: reduce ? 0 : OFFSET_PX.enter }}
              animate={{ opacity: faded ? 0 : 1, y: 0 }}
              transition={
                faded
                  ? transitions.fade
                  : { ...(reduce ? transitions.fade : transitions.enter), delay: seconds(position * STAGGER_MS.list) }
              }
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
