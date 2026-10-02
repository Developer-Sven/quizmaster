"use client";

import type { SettingsChanges } from "@quizmaster/shared";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StatusBanners } from "@/components/app/status-banners";
import { de } from "@/i18n/de";
import { loadCategoryCatalog } from "@/lib/client/categories";
import { errorText } from "@/lib/client/errors";
import { inviteLink } from "@/lib/client/paths";
import { writeStoredName } from "@/lib/client/storage";
import { useOrigin } from "@/lib/client/use-origin";
import {
  gameActions,
  selectCategories,
  selectIsHost,
  selectLastGame,
  selectLobby,
  selectSelfId,
  useGameStore,
} from "@/stores/game-store";
import { LastGameCard } from "./last-game-card";
import { LobbyView } from "./lobby-view";
import { useLobbyActions } from "./use-lobby-actions";
import { useSettingsSync } from "./use-settings-sync";

export interface LiveLobbyProps {
  code: string;
  displayCode: string;
  realtimeUrl: string;
  devBots: boolean;
}

/** Lobby (Phase `lobby`) mit Live-Zustand aus dem Store und Aktionen über den Realtime-Client. */
export function LiveLobby({ code, displayCode, realtimeUrl, devBots }: LiveLobbyProps) {
  const router = useRouter();
  const lobby = useGameStore(selectLobby);
  const selfId = useGameStore(selectSelfId);
  const isHost = useGameStore(selectIsHost);
  const origin = useOrigin();
  const actions = useLobbyActions(realtimeUrl);
  const [starting, setStarting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const lastGame = useGameStore(selectLastGame);
  const categories = useGameStore(selectCategories);
  // Nach einem Neuladen in der Lobby: die Karte „Letztes Spiel“ aus dem Tab-Speicher wiederherstellen (ADR-038).
  useEffect(() => {
    gameActions.restoreLastGame(code);
  }, [code]);
  // Alle spielbaren Kategorien für Auswahl und Zusammenfassung (ADR-048) – einmal je Seite, gecacht.
  useEffect(() => {
    let active = true;
    void loadCategoryCatalog().then((options) => {
      if (active && options.length > 0) gameActions.addCategories(options);
    });
    return () => {
      active = false;
    };
  }, []);
  const settingsSync = useSettingsSync(
    lobby?.settings ?? null,
    (update) => actions.client().emit("lobby:update-settings", update),
    (rejected) => {
      // Abgelehnt (z. B. „Personen maximal“ unter der Personenzahl): Server-Stand neu holen, Wert springt zurück.
      if (rejected === "INVALID_OPTION" || rejected === "VALIDATION_FAILED") actions.client().resync();
      else actions.fail(rejected);
    },
  );
  if (!lobby) return null;
  const inviteUrl = origin ? inviteLink(origin, code) : "";

  const start = async () => {
    if (starting) return;
    setStarting(true);
    // Gerade getippte Einstellungen zuerst zum Server – sonst kämen sie erst nach dem Start an (ADR-042).
    await settingsSync.flush();
    const result = await actions.client().emit("lobby:start", {});
    setStarting(false);
    if (!result.ok) actions.fail(result.code);
  };

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    await actions.client().leaveLobby();
    router.push("/");
  };

  const transferHost = async (playerId: string) => {
    const result = await actions.client().emit("lobby:transfer-host", { playerId });
    if (!result.ok) actions.fail(result.code);
  };

  const kick = async (playerId: string) => {
    const result = await actions.client().emit("lobby:kick", { playerId });
    if (!result.ok) actions.fail(result.code);
  };

  const rename = async (name: string): Promise<string | null> => {
    const result = await actions.client().emit("lobby:rename", { name });
    if (result.ok) {
      // Gemerkt wie auf der Startseite: der nächste Beitritt nutzt den neuen Namen.
      writeStoredName(name);
      return null;
    }
    return errorText(result.code);
  };

  // Vorschläge (ADR-053). INVALID_OPTION heißt hier: Stand hat sich geändert (Vorschläge aus, Vorschlag schon
  // entschieden oder zurückgezogen, „Personen maximal“ zu klein) – Hinweis und Server-Stand neu holen.
  const suggest = async (changes: SettingsChanges): Promise<boolean> => {
    const result = await actions.client().emit("lobby:suggest-settings", changes);
    if (result.ok) {
      gameActions.showToast("info", de.suggestions.sent);
      return true;
    }
    if (result.code === "INVALID_OPTION") {
      gameActions.showToast("error", de.suggestions.notPossible);
      actions.client().resync();
    } else actions.fail(result.code);
    return false;
  };

  const withdrawSuggestion = async () => {
    const result = await actions.client().emit("lobby:withdraw-suggestion", {});
    if (!result.ok) actions.fail(result.code);
  };

  const decideSuggestion = async (id: string, changes: SettingsChanges | null): Promise<boolean> => {
    // Offene Tipps des Hosts zuerst – der Vorschlag gilt über seinem neuesten Stand (ADR-042).
    await settingsSync.flush();
    const result =
      changes === null
        ? await actions.client().emit("lobby:decline-suggestion", { id })
        : await actions.client().emit("lobby:accept-suggestion", { id, changes });
    if (result.ok) {
      gameActions.showToast("info", changes === null ? de.suggestions.declined : de.suggestions.accepted);
      return true;
    }
    if (result.code === "INVALID_OPTION") {
      gameActions.showToast("error", de.suggestions.stale);
      actions.client().resync();
    } else actions.fail(result.code);
    return false;
  };

  const addBot = async () => {
    const result = await actions.client().emit("dev:add-bot", {});
    if (!result.ok) actions.fail(result.code);
  };

  return (
    <LobbyView
      lobby={lobby}
      selfId={selfId}
      isHost={isHost}
      displayCode={displayCode}
      inviteUrl={inviteUrl}
      banner={<StatusBanners />}
      lastGame={
        lastGame !== null && lastGame.code === lobby.code ? (
          <LastGameCard lastGame={lastGame} categories={categories} realtimeUrl={realtimeUrl} />
        ) : null
      }
      starting={starting}
      leaving={leaving}
      devBots={devBots}
      onStart={() => void start()}
      onLeave={() => void leave()}
      onKick={(playerId) => void kick(playerId)}
      settings={settingsSync.shown ?? lobby.settings}
      onChangeSettings={settingsSync.change}
      onSettingsClosed={() => void settingsSync.flush()}
      onRename={rename}
      onTransferHost={(playerId) => void transferHost(playerId)}
      onSuggest={suggest}
      onWithdrawSuggestion={() => void withdrawSuggestion()}
      onAcceptSuggestion={(id, changes) => decideSuggestion(id, changes)}
      onDeclineSuggestion={(id) => decideSuggestion(id, null)}
      categories={categories}
      onCopyCode={() => void actions.copyCode(code)}
      onShare={() => void actions.shareInvite(displayCode, inviteUrl || inviteLink(window.location.origin, code))}
      onShowRules={gameActions.openRules}
      onAddBot={() => void addBot()}
    />
  );
}
