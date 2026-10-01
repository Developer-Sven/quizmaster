"use client";

import { createContext, type ReactNode, useContext } from "react";

/** Uhr der Overlays: Client-Zeit in ms. Standard `Date.now`; die Dev-Vorschau friert sie für Screenshots ein. */
export type ClientClock = () => number;

export interface ClockValue {
  now: ClientClock;
  /** Eingefroren: keine Übergangs-Timer (Vorschau zeigt einen festen Moment) */
  frozen: boolean;
}

const ClockContext = createContext<ClockValue>({ now: Date.now, frozen: false });

/** Friert die Uhr für einen Teilbaum ein (nur /dev/game). */
export function FrozenClockProvider({ at, children }: { at: number; children: ReactNode }) {
  return <ClockContext value={{ now: () => at, frozen: true }}>{children}</ClockContext>;
}

export function useClientClock(): ClockValue {
  return useContext(ClockContext);
}
