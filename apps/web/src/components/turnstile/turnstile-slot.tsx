"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { de } from "../../i18n/de";
import { createTurnstileSolver, type TurnstileSolver, type TurnstileStatus } from "../../lib/client/turnstile";
import { cx } from "../../lib/ui/cx";
import { RefreshCwIcon } from "../../lib/ui/icons";
import { FormError } from "../app/form-error";
import { Button } from "../ui/button";

/** Öffentliche Turnstile-Konfiguration aus der Laufzeit-Konfiguration (ADR-023, `getPublicRuntimeConfig`). */
export interface TurnstileClientConfig {
  /** true = neue Sessions brauchen ein Token (`TURNSTILE_ENABLED`) → die Prüfung startet vor `POST /api/session`. */
  enabled: boolean;
  /** Site Key; `null` = Turnstile nicht konfiguriert (dann gibt es kein Widget). */
  siteKey: string | null;
}

/**
 * Turnstile-Prüfung dieser Ansicht (eine je Seite, beim Aushängen aufgeräumt). `null`, wenn kein Site Key
 * konfiguriert ist – der Realtime-Client meldet `TURNSTILE_REQUIRED` dann als Fehler.
 */
export function useTurnstile(config: TurnstileClientConfig): TurnstileSolver | null {
  const [solver] = useState(() => (config.siteKey ? createTurnstileSolver({ siteKey: config.siteKey }) : null));
  useEffect(() => {
    solver?.resume();
    return () => solver?.suspend();
  }, [solver]);
  return solver;
}

const noSubscription = () => () => undefined;
const idle = (): TurnstileStatus => "idle";

export interface TurnstileSlotProps {
  solver: TurnstileSolver | null;
  /**
   * `inline`: im Formular (Start, Beitreten) – ohne Prüfung ohne Höhe.
   * `panel`: Ebene-2-Panel unten über allem (Lobby-Seite, auch über dem Verbindungs-Overlay), nur sichtbar, wenn
   * Cloudflare eine Bestätigung verlangt oder die Prüfung fehlschlug.
   */
  variant?: "inline" | "panel";
  /** Nur `panel`: „Erneut versuchen“ nach einem Fehler (z. B. Verbindung neu aufbauen). */
  onRetry?: () => void;
  /**
   * Der Server hat das Token der letzten Prüfung abgelehnt (Verbindungsaufbau endete mit `TURNSTILE_REQUIRED`).
   * Hatte Cloudflare die Prüfung bestanden, steht sie wieder auf `idle` und zeigte sonst keinen Fehler.
   */
  rejected?: boolean;
}

/**
 * Platz für das Turnstile-Widget (docs/06 §Bot-Schutz, docs/09 §11 „TURNSTILE_REQUIRED: kein Text – Turnstile läuft,
 * danach automatischer zweiter Versuch“): Läuft die Prüfung unsichtbar, zeigt die Seite nur den Ladezustand ihres
 * Buttons. Verlangt Cloudflare eine Bestätigung, erscheint das Widget mit kurzer Überschrift; ein Fehler steht wie
 * jeder Formularfehler darunter (`caption`, rot, `triangle-alert`). Der Container bleibt immer eingehängt –
 * Cloudflare blendet sein iframe selbst ein und aus.
 */
export function TurnstileSlot({ solver, variant = "inline", onRetry, rejected = false }: TurnstileSlotProps) {
  const status = useSyncExternalStore(solver?.subscribe ?? noSubscription, solver?.getStatus ?? idle, idle);
  // Eigene Callback-Ref (statt `solver.attach` direkt): der Compiler hielte sonst `solver` für eine Ref.
  const attach = useCallback((element: HTMLDivElement | null) => solver?.attach(element), [solver]);
  const frame = useRef<HTMLDivElement>(null);
  const interactive = status === "interactive";
  // Verlangt Cloudflare eine Bestätigung, das Widget in den sichtbaren Bereich holen (es steht unter dem Formular).
  useEffect(() => {
    if (interactive) frame.current?.scrollIntoView({ block: "center" });
  }, [interactive]);
  if (solver === null) return null;
  // Eigener Fehler der Prüfung oder vom Server abgelehnt (dann ruht sie; läuft schon die nächste, gilt das nicht).
  const failed = status === "error" || (rejected && status === "idle");
  // Ein stabiles Element für Überschrift + Widget: ohne Bestätigung außerhalb des Flusses (keine Höhe, kein
  // Abstand im Formular), mit Bestätigung im Fluss. Das iframe bleibt dabei eingehängt.
  const widget = (
    <div ref={frame} className={interactive ? "flex flex-col gap-2" : "absolute"}>
      <p aria-live="polite" className={interactive ? "text-label text-text-2" : "sr-only"}>
        {interactive ? de.turnstile.label : ""}
      </p>
      <div ref={attach} data-testid="turnstile-widget" />
    </div>
  );
  const error = <FormError message={failed ? de.turnstile.failed : null} testId="turnstile-error" />;
  if (variant === "inline") {
    return (
      <div data-testid="turnstile" data-state={status} className="contents">
        {widget}
        {error}
      </div>
    );
  }
  const visible = interactive || failed;
  return (
    <div
      data-testid="turnstile"
      data-state={status}
      // Muss über dem modalen Verbindungs-Overlay bedienbar bleiben (Ausnahme vom `inert`-Hintergrund, s. Bericht W4).
      data-modal-exempt=""
      className={cx("fixed inset-x-0 bottom-0 z-connection px-gutter pb-safe", !visible && "pointer-events-none")}
    >
      <div
        className={cx(
          "mx-auto flex max-w-column flex-col",
          visible && "gap-3 rounded-xl border border-line bg-surface-1 p-5 shadow-level-2",
        )}
      >
        {widget}
        {error}
        {failed && onRetry ? (
          <Button variant="secondary" icon={RefreshCwIcon} onClick={onRetry} block>
            {de.turnstile.retry}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
