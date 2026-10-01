"use client";

import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useId } from "react";
import { de, errorPresentation } from "@/i18n/de";
import { formatCountdown } from "@/lib/client/phase-clock";
import { useCountdown } from "@/lib/client/use-server-clock";
import { LoaderCircleIcon, WifiOffIcon } from "@/lib/ui/icons";
import { MotionProvider } from "@/lib/ui/motion";
import { scrimMotion } from "@/lib/ui/motion-presets";
import { selectConnection, selectConnectionOverlayVisible, useGameStore } from "@/stores/game-store";

export interface ConnectionPanelProps {
  /** verbleibende Reconnect-Frist in ms; `null` = unbekannt (dann dreht der Lade-Indikator) */
  remainingMs: number | null;
  /** Grund einer Ablehnung, z. B. „Zu viele offene Verbindungen. Schließ andere Tabs.“ */
  message?: string | null;
}

/**
 * Inhalt des Verbindungs-Overlays (docs/09 §7.10): Ebene 70, Scrim + Panel mit `wifi-off` 32,
 * „Verbindung unterbrochen“ und dem Countdown der Frist (Stil `code`, tabular). Die assertive Ansage
 * übernimmt die dauerhafte Live-Region von {@link ConnectionOverlay} (sie existiert schon vor dem Verlust –
 * nur so sagen Screenreader zuverlässig an, ohne doppelte Ansage durch `role="alert"`).
 */
export function ConnectionPanel({ remainingMs, message }: ConnectionPanelProps) {
  const titleId = useId();
  return (
    <div
      data-testid="connection-overlay"
      className="fixed inset-0 z-connection flex items-center justify-center px-gutter"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-scrim" />
      <section
        aria-labelledby={titleId}
        className="relative flex w-full max-w-dialog flex-col items-center gap-3 rounded-xl border border-line bg-surface-1 p-6 text-center shadow-level-2"
      >
        <WifiOffIcon size={32} className="text-text-2" />
        <h2 id={titleId} className="text-h2 text-text">
          {de.connection.lost}
        </h2>
        {remainingMs === null ? (
          <LoaderCircleIcon size={24} className="animate-spin text-text-2 motion-reduce:animate-none" />
        ) : (
          <p
            role="timer"
            aria-label={de.a11y.timer}
            data-testid="connection-countdown"
            className="text-code text-text tabular-nums"
          >
            {formatCountdown(remainingMs)}
          </p>
        )}
        {message ? <p className="text-caption text-text-2">{message}</p> : null}
      </section>
    </div>
  );
}

/**
 * Verbindungs-Overlay (Haupt-Bundle, docs/07): erscheint sofort bei Verbindungsverlust in Lobby oder
 * Spiel, zählt die Reconnect-Frist herunter (Lobby 30 s, Spiel 90 s) und blendet bei Erfolg ohne
 * weiteren Hinweis aus. Der Verlust wird über eine dauerhafte `aria-live="assertive"`-Region angesagt
 * (docs/09 §7 „Screenreader“); die Rückkehr bleibt still (kein extra Hinweis, wie das Overlay).
 */
export function ConnectionOverlay() {
  const visible = useGameStore(selectConnectionOverlayVisible);
  const connection = useGameStore(selectConnection);
  const remaining = useCountdown(visible ? connection.graceUntil : null);
  const presentation = connection.lastError ? errorPresentation(connection.lastError) : null;
  const message = presentation?.kind === "message" ? presentation.text : null;
  return (
    <MotionProvider>
      <p className="sr-only" aria-live="assertive" aria-atomic="true" data-testid="connection-announcer">
        {visible ? de.announcements.connectionLost : ""}
      </p>
      <AnimatePresence>
        {visible ? (
          <m.div key="connection" {...scrimMotion}>
            <ConnectionPanel remainingMs={remaining} message={message} />
          </m.div>
        ) : null}
      </AnimatePresence>
    </MotionProvider>
  );
}
