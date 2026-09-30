"use client";

import { de } from "../../i18n/de";
import { TriangleAlertIcon } from "../../lib/ui/icons";
import { Button } from "./button";

/** Wartung oder Update verfügbar (docs/09 §5, docs/10). */
export type BannerTone = "maintenance" | "update";

export interface BannerProps {
  tone: BannerTone;
  /** Standard: Wartung „Wartung – gleich geht es weiter.“, Update „Neue Version verfügbar“ */
  message?: string;
  /** Aktion rechts (Update: „Aktualisieren“) – als Text, damit das Banner bei 360 px einzeilig bleibt */
  onAction?: () => void;
  /** Beschriftung der Aktion (Standard „Aktualisieren“) */
  actionLabel?: string;
}

/**
 * Banner (docs/09 §5): oben unter der Kopfzeile, eine Zeile – längere Wartungstexte aus
 * `appConfig.maintenance.message` (bis 200 Zeichen) brechen um und das Banner wächst mit, statt Text
 * zu verstecken (WCAG 1.4.10/1.4.12). Wartung zeigt `triangle-alert`, „Neue Version verfügbar“
 * bietet „Aktualisieren“ an (docs/10: Tippen sendet SKIP_WAITING).
 */
export function Banner({ tone, message, onAction, actionLabel = de.pwa.update }: BannerProps) {
  const text = message ?? (tone === "update" ? de.pwa.updateAvailable : de.maintenance.fallback);
  return (
    <div role="status" className="flex min-h-14 items-center gap-3 border-b border-line bg-surface-1 px-gutter py-2">
      {tone === "maintenance" ? <TriangleAlertIcon size={20} className="shrink-0 text-text-2" /> : null}
      {/* Stil `caption` (Hinweise, docs/09 §3): passt mit Aktion bei 360 px in eine Zeile;
          überlange Wartungstexte brechen um, statt abgeschnitten zu werden (kein line-clamp) */}
      <p className="min-w-0 flex-1 text-caption text-text">{text}</p>
      {onAction ? (
        <Button variant="secondary" size="compact" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
