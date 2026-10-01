"use client";

import { formatGameEstimate, type PublicLobbyState, type SettingsUpdate } from "@quizmaster/shared";
import { type ReactNode, useState } from "react";
import { ActionBarNote } from "@/components/app/action-bar";
import { AppHeader, HeaderTitle } from "@/components/app/app-header";
import { AppShell } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { de } from "@/i18n/de";
import { connectedCount, hostPlayer } from "@/lib/client/game-view";
import { clientTexts } from "@/lib/client/texts";
import { ChevronLeftIcon, PlayIcon, PlusIcon, Settings2Icon } from "@/lib/ui/icons";
import { InvitePanel } from "./invite-panel";
import { PlayerList } from "./player-list";
import { SettingsSheet } from "./settings-sheet";

export interface LobbyViewProps {
  lobby: PublicLobbyState;
  selfId: string | null;
  isHost: boolean;
  /** „ABC 234“ */
  displayCode: string;
  /** Einladungslink (docs/10), "" solange unbekannt */
  inviteUrl: string;
  /** Banner unter der Kopfzeile (Wartung, Update) */
  banner?: ReactNode;
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
 * „27 Fragen · ca. 9 Min.“; Aktionsleiste: Host „Spiel starten“ (ab 2 Verbundenen), sonst „Warte auf Mia …“.
 */
export function LobbyView({
  lobby,
  selfId,
  isHost,
  displayCode,
  inviteUrl,
  banner,
  starting = false,
  leaving = false,
  devBots = false,
  onStart,
  onLeave,
  onKick,
  onChangeSettings,
  onCopyCode,
  onShare,
  onAddBot,
  defaultSettingsOpen = false,
  defaultQrOpen = false,
}: LobbyViewProps) {
  const [settingsOpen, setSettingsOpen] = useState(defaultSettingsOpen);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const { rounds, questionsPerCategory, maxPlayers } = lobby.settings;
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
          <PlayerList players={players} maxPlayers={maxPlayers} selfId={selfId} canKick={isHost} onKick={onKick} />
          {isHost && devBots && onAddBot ? (
            <div className="flex">
              <Button variant="ghost" size="compact" icon={PlusIcon} onClick={onAddBot} data-testid="lobby-add-bot">
                {clientTexts.lobby.addBot}
              </Button>
            </div>
          ) : null}
          <div data-testid="lobby-summary" className="flex flex-col gap-1 text-body text-text-2">
            <p>{de.lobby.settingsSummary(rounds, questionsPerCategory)}</p>
            <p>{formatGameEstimate(rounds, Math.max(players.length, 1), questionsPerCategory)}</p>
          </div>
        </div>
      </AppShell>
      {isHost ? (
        <SettingsSheet
          open={settingsOpen}
          settings={lobby.settings}
          playerCount={players.length}
          onChange={onChangeSettings}
          onClose={() => setSettingsOpen(false)}
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
