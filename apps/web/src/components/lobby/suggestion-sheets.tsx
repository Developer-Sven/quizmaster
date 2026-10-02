"use client";

import {
  applySettingsUpdate,
  type LobbySettings,
  type SettingsChanges,
  type SettingsSuggestion,
  type SettingsUpdate,
  settingsChangesBetween,
} from "@quizmaster/shared";
import { useState } from "react";
import { de } from "../../i18n/de";
import type { CategoryCatalog } from "../../lib/client/game-view";
import { Button } from "../ui/button";
import { SettingsSheet } from "./settings-sheet";

/**
 * Entwurf über dem aktuellen Stand (ADR-053): Änderungen liegen über `current` – ändert der Host derweil etwas,
 * bleibt der Entwurf darüber. `changes` sind nur die Felder, die dann noch abweichen (`null`: keine).
 */
function useSettingsDraft(current: LobbySettings, initial: SettingsChanges | null) {
  const [draft, setDraft] = useState<SettingsUpdate>(() => initial ?? {});
  const shown = applySettingsUpdate(current, draft);
  return {
    shown,
    changes: settingsChangesBetween(current, shown),
    change: (update: SettingsUpdate) => setDraft((previous) => ({ ...previous, ...update })),
  };
}

export interface SuggestSheetProps {
  open: boolean;
  /** Aktueller Stand (Server) */
  settings: LobbySettings;
  /** Eigener offener Vorschlag – der Entwurf beginnt damit, Senden ersetzt ihn */
  pending: SettingsSuggestion | null;
  playerCount: number;
  categories: CategoryCatalog;
  hostName: string;
  /** Sendet den Vorschlag; `true` bei Erfolg (dann schließt das Sheet) */
  onSend: (changes: SettingsChanges) => Promise<boolean>;
  onClose: () => void;
}

/**
 * Einstellungen aller außer dem Host, solange Vorschläge erlaubt sind (ADR-053): alles einstellbar, aber als
 * Entwurf – geänderte Werte orange mit „Aktuell: …“, unten primary „Vorschlag senden“ (erst bei einer Änderung)
 * und secondary „Schließen“. Bei jedem Öffnen frisch (Schlüssel in der Lobby).
 */
export function SuggestSheet({
  open,
  settings,
  pending,
  playerCount,
  categories,
  hostName,
  onSend,
  onClose,
}: SuggestSheetProps) {
  const draft = useSettingsDraft(settings, pending?.changes ?? null);
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (draft.changes === null || sending) return;
    setSending(true);
    const sent = await onSend(draft.changes);
    setSending(false);
    if (sent) onClose();
  };
  return (
    <SettingsSheet
      open={open}
      settings={draft.shown}
      playerCount={playerCount}
      categories={categories}
      asGuest
      hostName={hostName}
      baseline={settings}
      intro={pending ? de.suggestions.pendingIntro(hostName) : de.suggestions.intro(hostName)}
      actions={
        <div className="flex flex-col gap-3">
          <Button
            variant="primary"
            block
            disabled={draft.changes === null}
            loading={sending}
            onClick={() => void send()}
            data-testid="settings-suggest"
          >
            {pending ? de.suggestions.replace : de.suggestions.send}
          </Button>
          <Button variant="secondary" block onClick={onClose} data-testid="settings-done">
            {de.actions.close}
          </Button>
        </div>
      }
      onChange={draft.change}
      onClose={onClose}
    />
  );
}

export interface ReviewSheetProps {
  open: boolean;
  /** Der offene Vorschlag, den der Host prüft */
  suggestion: SettingsSuggestion;
  /** Name der vorschlagenden Person */
  fromName: string;
  /** Aktueller Stand aus Sicht des Hosts */
  settings: LobbySettings;
  playerCount: number;
  categories: CategoryCatalog;
  /** Übernimmt den Vorschlag in der Fassung des Hosts; `true` bei Erfolg */
  onAccept: (id: string, changes: SettingsChanges) => Promise<boolean>;
  /** Lehnt ab; `true` bei Erfolg */
  onDecline: (id: string) => Promise<boolean>;
  onClose: () => void;
}

/**
 * Vorschlag prüfen (Host, ADR-053): Titel „Vorschlag von Ben“, alle Einstellungen mit dem Vorschlag – was er ändert,
 * ist orange mit „Aktuell: …“; der Host kann noch anpassen. Unten primary „Übernehmen“ (nur, solange sich etwas
 * ändert) und secondary „Ablehnen“; Schließen lässt den Vorschlag offen.
 */
export function ReviewSheet({
  open,
  suggestion,
  fromName,
  settings,
  playerCount,
  categories,
  onAccept,
  onDecline,
  onClose,
}: ReviewSheetProps) {
  const draft = useSettingsDraft(settings, suggestion.changes);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const decide = async (accept: boolean) => {
    if (busy !== null) return;
    const changes = draft.changes;
    if (accept && changes === null) return;
    setBusy(accept ? "accept" : "decline");
    const done = accept && changes !== null ? await onAccept(suggestion.id, changes) : await onDecline(suggestion.id);
    setBusy(null);
    if (done) onClose();
  };
  return (
    <SettingsSheet
      open={open}
      settings={draft.shown}
      playerCount={playerCount}
      categories={categories}
      baseline={settings}
      title={de.suggestions.reviewTitle(fromName)}
      intro={de.suggestions.reviewIntro(fromName)}
      actions={
        <div className="flex flex-col gap-3">
          <Button
            variant="primary"
            block
            disabled={draft.changes === null || busy === "decline"}
            loading={busy === "accept"}
            onClick={() => void decide(true)}
            data-testid="suggestion-accept"
          >
            {de.suggestions.accept}
          </Button>
          <Button
            variant="secondary"
            block
            disabled={busy === "accept"}
            loading={busy === "decline"}
            onClick={() => void decide(false)}
            data-testid="suggestion-decline"
          >
            {de.suggestions.decline}
          </Button>
        </div>
      }
      onChange={draft.change}
      onClose={onClose}
    />
  );
}
