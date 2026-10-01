"use client";

import { formatGameEstimate, type LobbySettings, type PublicLobbyState, type SettingsUpdate } from "@quizmaster/shared";
import { type ReactNode, useState } from "react";
import { ActionBarNote } from "@/components/app/action-bar";
import { AppFooter } from "@/components/app/app-footer";
import { AppHeader, HeaderTitle } from "@/components/app/app-header";
import { AppShell } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { de } from "@/i18n/de";
import { connectedCount, hostPlayer } from "@/lib/client/game-view";
import { ChevronLeftIcon, PlayIcon, PlusIcon, Settings2Icon } from "@/lib/ui/icons";
import { InvitePanel } from "./invite-panel";
import { PlayerList } from "./player-list";
import { RenameSheet } from "./rename-sheet";
import { SettingsSheet } from "./settings-sheet";

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
  onCopyCode: () => void;
  onShare: () => void;
  onAddBot?: () => void;
  /** Vorschau: Einstellungen-Sheet anfangs offen */
  defaultSettingsOpen?: boolean;
  /** Vorschau: QR-Code anfangs offen */
  defaultQrOpen?: boolean;
}

/**
 * Lobby (Phase `lobby`, docs/09 §6): Kopfzeile mit Verlassen (Dialog) und Einstellungen (nur Host),
 * Code + Kopieren/Teilen + QR, Spielerliste, Zusammenfassung „3 Runden · 3 Fragen je Kat.“ /
 * „27 Fragen · ca. 9 Min.“, darunter der Link „Regeln“ (neuer Tab); Aktionsleiste: Host „Spiel starten“ (ab 2
 * Verbundenen), sonst „Warte auf Mia …“. Nach einem Spiel unter der Spielerliste die Karte „Letztes Spiel“
 * (ADR-038).
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
  onCopyCode,
  onShare,
  onAddBot,
  defaultSettingsOpen = false,
  defaultQrOpen = false,
}: LobbyViewProps) {
  const [settingsOpen, setSettingsOpen] = useState(defaultSettingsOpen);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const settings = shownSettings ?? lobby.settings;
  const { rounds, questionsPerCategory, maxPlayers } = settings;
  const players = lobby.players;
  const host = hostPlayer(players);
  const canStart = connectedCount(players) >= 2;

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
              isHost ? (
                <IconButton
                  icon={Settings2Icon}
                  label={de.lobby.settings}
                  onClick={() => setSettingsOpen(true)}
                  data-testid="lobby-settings"
                />
              ) : null
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
          />
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
            <p>{formatGameEstimate(rounds, Math.max(players.length, 1), questionsPerCategory, settings)}</p>
          </div>
          {/* Neuer Tab: Wer die Lobby-Seite verlässt, wird nach 30 s Trennung entfernt. */}
          <AppFooter newTab />
        </div>
      </AppShell>
      {isHost ? (
        <SettingsSheet
          open={settingsOpen}
          settings={settings}
          playerCount={players.length}
          onChange={onChangeSettings}
          onClose={() => {
            setSettingsOpen(false);
            onSettingsClosed?.();
          }}
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
