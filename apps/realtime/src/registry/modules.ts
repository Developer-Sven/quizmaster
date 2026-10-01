/**
 * Module der Produktions-App in Registrierungsreihenfolge. Jedes Modul registriert seine Client-Events
 * (`registerEvent`) und Hooks; weitere Bausteine (Lobby/Spiel, Change-Stream-Watcher) werden hier
 * eingetragen. `start()` prüft, dass danach jedes Event aus `CLIENT_EVENTS` einen Handler hat
 * (Invariante 6; Produktion bricht sonst ab).
 */
import { lobbyGameModule } from "../lobby/module.ts";
import { timeSyncModule } from "./time-sync.ts";
import type { RealtimeModule } from "./types.ts";

// lobbyGameModule (W2#3): alle Lobby-/Spiel-Events, Fragen-Service mit Change Streams, Snapshots im Shutdown.
export const REALTIME_MODULES: readonly RealtimeModule[] = [timeSyncModule, lobbyGameModule];
