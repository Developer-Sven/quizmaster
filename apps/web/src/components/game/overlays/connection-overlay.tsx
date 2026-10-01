"use client";

import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { de, errorPresentation } from "../../../i18n/de";
import { formatCountdown } from "../../../lib/client/phase-clock";
import { useCountdown } from "../../../lib/client/use-server-clock";
import { LoaderCircleIcon, WifiOffIcon } from "../../../lib/ui/icons";
import { MotionProvider } from "../../../lib/ui/motion";
import { scrimMotion } from "../../../lib/ui/motion-presets";
import { selectConnection, selectConnectionOverlayVisible, useGameStore } from "../../../stores/game-store";

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

/** So lange steht „Verbindung wiederhergestellt“ in der höflichen Live-Region (nur Screenreader). */
export const RESTORED_ANNOUNCEMENT_MS = 3_000;

/**
 * Verbindungs-Overlay (Haupt-Bundle, docs/07): erscheint sofort bei Verbindungsverlust in Lobby oder
 * Spiel, zählt die Reconnect-Frist herunter (Lobby 30 s, Spiel 90 s) und blendet bei Erfolg ohne
 * weiteren sichtbaren Hinweis aus (kein Toast, docs/09 §7.10). Der Verlust wird über eine dauerhafte
 * `aria-live="assertive"`-Region angesagt (docs/09 §7 „Screenreader“), die Rückkehr kurz und höflich nur für
 * Screenreader (WCAG 4.1.3) – sonst bliebe offen, ob es weitergeht.
 *
 * Modal (WCAG 2.4.7, 2.4.11): Solange es steht, ist alles außer ihm inert – Tastatur, Klicks und Screenreader
 * erreichen nichts dahinter, und kein Fokus bleibt verdeckt dahinter stehen. Danach kehrt der Fokus zurück.
 */
export function ConnectionOverlay() {
  const visible = useGameStore(selectConnectionOverlayVisible);
  const connection = useGameStore(selectConnection);
  const remaining = useCountdown(visible ? connection.graceUntil : null);
  const presentation = connection.lastError ? errorPresentation(connection.lastError) : null;
  const message = presentation?.kind === "message" ? presentation.text : null;
  const layerRef = useRef<HTMLDivElement>(null);
  const [wasVisible, setWasVisible] = useState(visible);
  const [restored, setRestored] = useState(false);
  // Rückkehr erkannt: Overlay weg und wieder verbunden (nicht etwa wegen Fehler oder Verlassen der Lobby).
  if (wasVisible !== visible) {
    setWasVisible(visible);
    setRestored(!visible && connection.status === "connected");
  }

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => setRestored(false), RESTORED_ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [restored]);

  useModalBackground(visible, layerRef);

  return (
    <MotionProvider>
      <div ref={layerRef} data-testid="connection-layer">
        <p className="sr-only" aria-live="assertive" aria-atomic="true" data-testid="connection-announcer">
          {visible ? de.announcements.connectionLost : ""}
        </p>
        <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="connection-restored">
          {restored ? de.announcements.connectionRestored : ""}
        </p>
        <AnimatePresence>
          {visible ? (
            <m.div key="connection" {...scrimMotion}>
              <ConnectionPanel remainingMs={remaining} message={message} />
            </m.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionProvider>
  );
}

/**
 * Während `active`: alles außerhalb von `layerRef` inert (die Geschwister auf jeder Ebene bis `<body>`) und den
 * Fokus von dort lösen; danach beides zurück (nur selbst gesetztes `inert` wird entfernt) und den Fokus an das
 * zuvor fokussierte Element geben, sofern es noch da und bedienbar ist.
 */
function useModalBackground(active: boolean, layerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const layer = layerRef.current;
    if (!active || !layer) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const changed: Element[] = [];
    for (let node: Element = layer; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.hasAttribute("inert") || sibling instanceof HTMLScriptElement) continue;
        sibling.setAttribute("inert", "");
        changed.push(sibling);
      }
    }
    if (previous && !layer.contains(previous)) previous.blur();
    return () => {
      for (const element of changed) element.removeAttribute("inert");
      if (previous?.isConnected && previous.closest("[inert]") === null && document.activeElement !== previous) {
        const free = document.activeElement === null || document.activeElement === document.body;
        if (free) previous.focus({ preventScroll: true });
      }
    };
  }, [active, layerRef]);
}
