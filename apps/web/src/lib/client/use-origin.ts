"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/** Origin der Seite (`https://<domain>`), auf dem Server und vor der Hydration "" – ohne Hydration-Warnung. */
export function useOrigin(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
}
