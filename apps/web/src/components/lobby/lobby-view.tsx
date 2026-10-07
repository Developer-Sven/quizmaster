"use client";

import {
  formatGameEstimate,
  type LobbySettings,
  type PublicLobbyState,
  type SettingsChanges,
  type SettingsSuggestion,
  type SettingsUpdate,
} from "@quizmaster/shared";
import { type ReactNode, useId, useState } from "react";
import { ActionBarNote } from "@/components/app/action-bar";
import { AppFooter } from "@/components/app/app-footer";
import { AppHeader, HeaderTitle } from "@/components/app/app-header";
import { AppShell } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { de } from "@/i18n/de";
import { type CategoryCatalog, connectedCount, hostPlayer } from "@/lib/client/game-view";
import { ownPendingSuggestion, pendingSuggestions } from "@/lib/client/suggestions";
import { ChevronLeftIcon, PlayIcon, PlusIcon, Settings2Icon } from "@/lib/ui/icons";
import { usePresenterZoom } from "@/lib/ui/presenter";
import { InvitePanel } from "./invite-panel";
import { PlayerList } from "./player-list";
import { RenameSheet } from "./rename-sheet";
import { settingsExtras } from "./settings-extras";
import { SettingsSheet } from "./settings-sheet";
import { suggestionSummary } from "./settings-text";
import { ReviewSheet, SuggestSheet } from "./suggestion-sheets";

export interface LobbyViewProps {
  lobby: PublicLobbyState;
  /** Angezeigte Einstellungen inkl. noch nicht bestätigter Tipps des Hosts (ADR-042); Standard `lobby.settings` */
  settings?: LobbySettings;
  selfId: string | null;
  isHost: boolean;
  /** „ABC 234“ */
  displayCode: string;
  /** Einladungslink (docs/10), "" solange unbekannt */
  inviteUrl: string;
  /** Banner unter der Kopfzeile (Wartung, Update) */
  banner?: ReactNode;
  /** Karte „Letztes Spiel“ nach einem Spiel (ADR-038), unter der Spielerliste */
  lastGame?: ReactNode;
  starting?: boolean;
  leaving?: boolean;
  /** Dev-Bots erlaubt (DEV_BOTS_ENABLED) – nur für den Host sichtbar */
  devBots?: boolean;
  onStart: () => void;
  /** nach Bestätigung im Dialog */
  onLeave: () => void;
  /** nach Bestätigung im Dialog */
  onKick: (playerId: string) => void;
  onChangeSettings: (update: SettingsUpdate) => void;
  /** Einstellungen-Sheet geschlossen: offene Tipps sofort senden (ADR-042) */
  onSettingsClosed?: () => void;
  /** Eigenen Namen ändern (ADR-041): Fehlermeldung oder `null` bei Erfolg; ohne Handler kein Stift */
  onRename?: (name: string) => Promise<string | null>;
  /** Host übertragen (ADR-047) – nur der Host bekommt den Handler */
  onTransferHost?: (playerId: string) => void;
  /** Vorschlag senden (alle außer dem Host, ADR-053); `true` bei Erfolg */
  onSuggest?: (changes: SettingsChanges) => Promise<boolean>;
  /** Eigenen offenen Vorschlag zurückziehen (ADR-053) */
  onWithdrawSuggestion?: () => void;
  /** Host: Vorschlag in seiner Fassung übernehmen (ADR-053); `true` bei Erfolg */
  onAcceptSuggestion?: (id: string, changes: SettingsChanges) => Promise<boolean>;
  /** Host: Vorschlag ablehnen (ADR-053); `true` bei Erfolg */
  onDeclineSuggestion?: (id: string) => Promise<boolean>;
  /** Kategorien für Auswahl und Zusammenfassung (ADR-048) */
  categories?: CategoryCatalog;
  onCopyCode: () => void;
  onShare: () => void;
  /** „Regeln“ als Sheet (ADR-052) – nie ein Seitenwechsel aus der Lobby */
  onShowRules: () => void;
  onAddBot?: () => void;
  /** Vorschau: Einstellungen-Sheet anfangs offen */
  defaultSettingsOpen?: boolean;
  /** Vorschau: QR-Code anfangs offen */
  defaultQrOpen?: boolean;
}

const NO_CATEGORIES: CategoryCatalog = {};

/**
 * Lobby (Phase `lobby`, docs/09 §6): Kopfzeile mit Verlassen (Dialog) und Einstellungen (nur Host),
 * Code + Kopieren/Teilen + QR, Spielerliste, Zusammenfassung „3 Runden · 3 Fragen je Kat.“ /
 * „27 Fragen · ca. 9 Min.“, darunter „Regeln“ (als Sheet, ADR-052); Aktionsleiste: Host „Spiel starten“ (ab 2
 * Verbundenen), sonst „Warte auf Mia …“. Nach einem Spiel unter der Spielerliste die Karte „Letztes Spiel“
 * (ADR-038). Vorschläge (ADR-053): Der Host sieht offene Vorschläge unter der Spielerliste und prüft sie im Sheet;
 * alle anderen stellen im Einstellungen-Sheet einen Vorschlag zusammen und sehen ihren offenen Vorschlag.
 */
export function LobbyView({
  lobby,
  settings: shownSettings,
  selfId,
  isHost,
  displayCode,
  inviteUrl,
  banner,
  lastGame = null,
  starting = false,
  leaving = false,
  devBots = false,
  onStart,
  onLeave,
  onKick,
  onChangeSettings,
  onSettingsClosed,
  onRename,
  onTransferHost,
  onSuggest,
  onWithdrawSuggestion,
  onAcceptSuggestion,
  onDeclineSuggestion,
  categories = NO_CATEGORIES,
  onCopyCode,
  onShare,
  onShowRules,
  onAddBot,
  defaultSettingsOpen = false,
  defaultQrOpen = false,
}: LobbyViewProps) {
  const [settingsOpen, setSettingsOpen] = useState(defaultSettingsOpen);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  // Vorschläge (ADR-053): jedes Öffnen beginnt einen frischen Entwurf (Schlüssel); der geprüfte Vorschlag bleibt
  // gespeichert, damit das Sheet auch nach der Entscheidung sauber zufährt.
  const [suggestKey, setSuggestKey] = useState(0);
  const [review, setReview] = useState<{ suggestion: SettingsSuggestion; key: number } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const suggestionsHeadingId = useId();
  const settings = shownSettings ?? lobby.settings;
  const { rounds, questionsPerCategory, maxPlayers } = settings;
  const players = lobby.players;
  const host = hostPlayer(players);
  // Anzeige-Modus (ADR-046): Der Host spielt nicht mit – gezählt werden nur die Mitspielenden.
  const presenterId = settings.hostPlays ? null : (host?.id ?? null);
  const playing = players.filter((player) => player.id !== presenterId);
  const canStart = connectedCount(playing) >= 2;
  const extras = settingsExtras(settings, categories, presenterId === null ? null : (host?.name ?? ""));
  // Der anzeigende Host zeigt schon die Lobby groß (Code und QR-Code für alle im Raum).
  usePresenterZoom(isHost && presenterId !== null);
  const pending = isHost ? pendingSuggestions(lobby) : [];
  const ownSuggestion = isHost ? null : ownPendingSuggestion(lobby, selfId);
  const suggest = !isHost && lobby.settings.allowSuggestions ? onSuggest : undefined;
  const nameOf = (playerId: string) => players.find((player) => player.id === playerId)?.name ?? "";
  const openSettings = () => {
    if (suggest) setSuggestKey((key) => key + 1);
    setSettingsOpen(true);
  };
  const openReview = (suggestion: SettingsSuggestion) => {
    setReview((current) => ({ suggestion, key: (current?.key ?? 0) + 1 }));
    setReviewOpen(true);
  };
  const reviewPending = review !== null && pending.some((entry) => entry.id === review.suggestion.id);

  return (
    <>
      <AppShell
        testId="lobby-screen"
        header={
          <AppHeader
            left={
              <IconButton
                icon={ChevronLeftIcon}
                label={de.actions.leaveLobby}
                onClick={() => setLeaveOpen(true)}
                data-testid="lobby-leave"
              />
            }
            title={<HeaderTitle>{de.lobby.title}</HeaderTitle>}
            right={
              // Alle sehen die Einstellungen – nur der Host ändert sie (ADR-050).
              <IconButton
                icon={Settings2Icon}
                label={isHost ? de.lobby.settings : de.lobby.viewSettings}
                onClick={openSettings}
                data-testid="lobby-settings"
              />
            }
          />
        }
        banner={banner}
        actions={
          isHost ? (
            <Button
              variant="primary"
              icon={PlayIcon}
              block
              disabled={!canStart}
              loading={starting}
              onClick={onStart}
              data-testid="lobby-start"
            >
              {de.actions.startGame}
            </Button>
          ) : (
            <ActionBarNote testId="lobby-waiting">{host ? de.lobby.waitingFor(host.name) : null}</ActionBarNote>
          )
        }
      >
        <div className="flex flex-col gap-8">
          <InvitePanel
            displayCode={displayCode}
            inviteUrl={inviteUrl}
            onCopyCode={onCopyCode}
            onShare={onShare}
            defaultQrOpen={defaultQrOpen}
          />
          <PlayerList
            players={players}
            maxPlayers={maxPlayers}
            selfId={selfId}
            canKick={isHost}
            onKick={onKick}
            onRename={onRename ? () => setRenameOpen(true) : undefined}
            onTransferHost={isHost ? onTransferHost : undefined}
            presenterId={presenterId}
          />
          {pending.length > 0 && onAcceptSuggestion ? (
            <section
              aria-labelledby={suggestionsHeadingId}
              data-testid="lobby-suggestions"
              className="flex flex-col gap-1"
            >
              <h2 id={suggestionsHeadingId} className="text-label text-text-2">
                {de.suggestions.title}
              </h2>
              <ul className="flex flex-col">
                {pending.map((entry) => (
                  <li key={entry.id}>
                    <ListRow icon={Settings2Icon} onClick={() => openReview(entry)} data-testid="lobby-suggestion">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{de.suggestions.from(nameOf(entry.playerId))}</span>
                        <span className="truncate text-caption text-text-2">
                          {suggestionSummary(entry.changes, settings, categories)}
                        </span>
                      </span>
                    </ListRow>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {ownSuggestion !== null && onWithdrawSuggestion ? (
            <div data-testid="lobby-own-suggestion" className="flex items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-body text-text-2">{de.suggestions.waiting(host?.name ?? "")}</p>
              {/* Der Text bricht um, nie die Beschriftung des Buttons (360 px: „Zurückzieh-en“, docs/09 §4) */}
              <div className="shrink-0">
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={onWithdrawSuggestion}
                  data-testid="lobby-withdraw-suggestion"
                >
                  {de.suggestions.withdraw}
                </Button>
              </div>
            </div>
          ) : null}
          {lastGame}
          {isHost && devBots && onAddBot ? (
            <div className="flex">
              <Button variant="ghost" size="compact" icon={PlusIcon} onClick={onAddBot} data-testid="lobby-add-bot">
                {de.lobby.addBot}
              </Button>
            </div>
          ) : null}
          <div data-testid="lobby-summary" className="flex flex-col gap-1 text-body text-text-2">
            <p>{de.lobby.settingsSummary(rounds, questionsPerCategory)}</p>
            <p>{formatGameEstimate(rounds, Math.max(playing.length, 1), questionsPerCategory, settings)}</p>
            {extras.length > 0 ? <p data-testid="lobby-summary-extras">{extras.join(" · ")}</p> : null}
          </div>
          {/* Sheet statt Seite: Wer die Lobby-Seite verlässt, wird nach 30 s Trennung entfernt (ADR-052). */}
          <AppFooter onShowRules={onShowRules} />
        </div>
      </AppShell>
      {suggest ? (
        <SuggestSheet
          key={suggestKey}
          open={settingsOpen}
          settings={lobby.settings}
          pending={ownSuggestion}
          playerCount={players.length}
          categories={categories}
          hostName={host?.name ?? ""}
          onSend={suggest}
          onClose={() => setSettingsOpen(false)}
        />
      ) : (
        <SettingsSheet
          open={settingsOpen}
          settings={settings}
          playerCount={players.length}
          categories={categories}
          readOnly={!isHost}
          asGuest={!isHost}
          hostName={host?.name ?? ""}
          suggestionsToggle={isHost}
          onChange={onChangeSettings}
          onClose={() => {
            setSettingsOpen(false);
            if (isHost) onSettingsClosed?.();
          }}
        />
      )}
      {isHost && review !== null && onAcceptSuggestion && onDeclineSuggestion ? (
        <ReviewSheet
          key={review.key}
          open={reviewOpen && reviewPending}
          suggestion={review.suggestion}
          fromName={nameOf(review.suggestion.playerId)}
          settings={settings}
          playerCount={players.length}
          categories={categories}
          onAccept={onAcceptSuggestion}
          onDecline={onDeclineSuggestion}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}
      {onRename ? (
        <RenameSheet
          open={renameOpen}
          name={players.find((player) => player.id === selfId)?.name ?? ""}
          onSubmit={onRename}
          onClose={() => setRenameOpen(false)}
        />
      ) : null}
      <Dialog
        open={leaveOpen}
        title={de.dialogs.leaveLobby.title}
        confirmLabel={de.dialogs.leaveLobby.confirm}
        cancelLabel={de.dialogs.leaveLobby.cancel}
        confirming={leaving}
        onConfirm={onLeave}
        onCancel={() => setLeaveOpen(false)}
      />
    </>
  );
}
