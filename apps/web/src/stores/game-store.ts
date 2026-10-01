/**
 * Client-Zustand für Lobby und Spiel (zustand v5, docs/03, docs/07 §Frontend). Der Server ist
 * autoritativ: `lobby` ist der letzte angenommene `lobby:state`-Snapshot, `self` der letzte `lobby:self`.
 * Dazu Verbindungsstatus mit Reconnect-Frist, Uhren-Offset und lokale UI-Zustände (Ton, Toasts,
 * optimistische Antwort/Wahl). Aktionen sind freie Funktionen (`gameActions`), damit sie ohne React
 * testbar sind; Komponenten lesen immer über Selektoren, nie den ganzen Store.
 */
import type {
  AnswerIndex,
  CategoryOption,
  ErrorCode,
  GameTimingMode,
  KickReason,
  NoticeCode,
  PrivatePlayerState,
  PublicLobbyState,
} from "@quizmaster/shared";
import { create } from "zustand";
import { de } from "../i18n/de";
import { type CategoryCatalog, lobbyNotices, mergeCategories, missingCategoryIds } from "../lib/client/game-view";
import { inferTimingMode, reconnectGraceMs } from "../lib/client/phase-clock";

/**
 * - `idle`: noch keine Verbindung angefordert
 * - `connecting`: erster Verbindungsaufbau
 * - `connected`: verbunden
 * - `reconnecting`: Verbindung verloren, Socket.IO verbindet neu (Backoff bis 5 s)
 * - `offline`: Browser meldet kein Netz
 */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Client-Zeit (ms) des Verbindungsverlusts; `null`, solange verbunden */
  lostAt: number | null;
  /** Client-Zeit (ms), bis zu der der Server den Platz hält (Reconnect-Frist); nur in einer Lobby */
  graceUntil: number | null;
  /** Letzte vorübergehende Ablehnung des Verbindungsaufbaus (z. B. TOO_MANY_CONNECTIONS) */
  lastError: ErrorCode | null;
  /** Endgültiger Fehler ohne automatischen Neuversuch (Sitzung, Sperre, Update) */
  fatal: ErrorCode | null;
}

/** Warum die Lobby für diese Person vorbei ist (Anzeige statt Lobby/Spiel). */
export type LobbyExit = { kind: "error"; code: ErrorCode } | { kind: "kicked"; reason: KickReason };

export type ToastKind = "hostChanged" | "playerResigned" | "serverRestart" | "info" | "error";

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface PendingAnswer {
  questionId: string;
  choice: AnswerIndex;
  /**
   * `true`: kein Ack (Zeitüberschreitung, Trennung) – ob der Server die Antwort hat, klärt erst der nächste
   * `lobby:self` (nach `lobby:resume`). Kennt er sie nicht, wird sie wieder freigegeben (sonst bliebe sie
   * fälschlich „eingeloggt“ und die Person könnte nicht erneut antworten). `false`: vom Server bestätigt.
   */
  unconfirmed?: boolean;
}

export interface PendingPick {
  /** `phaseStartedAt` der Kategoriewahl, zu der die Wahl gehört */
  phaseStartedAt: number;
  categoryId: string;
}

export interface GameStoreState {
  /** Code der Lobby, in der sich diese Person gerade befindet (normalisiert) */
  code: string | null;
  lobby: PublicLobbyState | null;
  self: PrivatePlayerState | null;
  /** zuletzt angenommene `rev` (Zustände mit kleinerer `rev` werden verworfen, docs/05) */
  lastRev: number | null;
  /** nach `lobby:resume`: den nächsten Zustand unabhängig von `rev` annehmen (z. B. nach Server-Neustart) */
  acceptNextState: boolean;
  /** zählt erfolgreiche Wiederaufnahmen – Timer starten danach mit der Restzeit neu */
  syncGeneration: number;
  /** Uhren-Offset: `serverNow − clientNow` in ms */
  offset: number;
  /** aus Phasendauern erkannter Timing-Modus (für die Reconnect-Frist) */
  timingMode: GameTimingMode;
  connection: ConnectionState;
  exit: LobbyExit | null;
  pendingAnswer: PendingAnswer | null;
  pendingPick: PendingPick | null;
  categories: CategoryCatalog;
  soundOn: boolean;
  toasts: readonly ToastEntry[];
  /** `notice: MAINTENANCE` – Banner bis zur nächsten neuen Verbindung */
  maintenance: boolean;
  /** `UPDATE_REQUIRED` – Banner „Neue Version verfügbar“ */
  updateRequired: boolean;
}

const INITIAL_CONNECTION: ConnectionState = {
  status: "idle",
  lostAt: null,
  graceUntil: null,
  lastError: null,
  fatal: null,
};

const EMPTY_CATALOG: CategoryCatalog = {};

function initialState(): GameStoreState {
  return {
    code: null,
    lobby: null,
    self: null,
    lastRev: null,
    acceptNextState: false,
    syncGeneration: 0,
    offset: 0,
    timingMode: "normal",
    connection: INITIAL_CONNECTION,
    exit: null,
    pendingAnswer: null,
    pendingPick: null,
    categories: EMPTY_CATALOG,
    soundOn: true,
    toasts: [],
    maintenance: false,
    updateRequired: false,
  };
}

export const useGameStore = create<GameStoreState>()(() => initialState());

const MAX_TOASTS = 5;
let toastSequence = 0;

function lobbyReset(): Partial<GameStoreState> {
  return {
    code: null,
    lobby: null,
    self: null,
    lastRev: null,
    acceptNextState: false,
    exit: null,
    pendingAnswer: null,
    pendingPick: null,
    categories: EMPTY_CATALOG,
    toasts: [],
  };
}

/**
 * Hängt einen Toast an. Gleicher Text wie der letzte in der Schlange → nicht doppelt (die Toast-Komponente
 * startet ihre 3 s nur bei einem neuen Text).
 */
function withToast(toasts: readonly ToastEntry[], kind: ToastKind, text: string): readonly ToastEntry[] {
  if (toasts.at(-1)?.text === text) return toasts;
  toastSequence += 1;
  return [...toasts, { id: toastSequence, kind, text }].slice(-MAX_TOASTS);
}

/** Frist ab `now` für die aktuelle Phase (in der Lobby 30 s, im Spiel 90 s) – ohne Lobby keine. */
function graceFrom(state: GameStoreState, now: number): number | null {
  if (!state.lobby || state.exit) return null;
  return now + reconnectGraceMs(state.lobby.phase, state.timingMode);
}

export const gameActions = {
  /** Betritt die Lobby `code` (Lobby-Seite, nach create/join). Wechselt der Code, beginnt alles neu. */
  enterLobby(code: string, categories?: CategoryCatalog): void {
    const state = useGameStore.getState();
    if (state.code === code && !state.exit) return;
    useGameStore.setState({ ...lobbyReset(), code, categories: categories ?? EMPTY_CATALOG });
  },

  /** Verlässt den Lobby-Kontext (nach `lobby:leave` oder beim Zurück zur Startseite). */
  resetLobby(): void {
    useGameStore.setState(lobbyReset());
  },

  /**
   * Übernimmt einen `lobby:state`-Snapshot. Verworfen werden Zustände einer fremden Lobby und solche mit
   * kleinerer `rev` als der zuletzt gesehenen (docs/05) – außer direkt nach einer Wiederaufnahme.
   * Liefert, ob der Zustand übernommen wurde.
   */
  applyPublicState(next: PublicLobbyState): boolean {
    const state = useGameStore.getState();
    if (state.exit) return false;
    if (state.code !== null && next.code !== state.code) return false;
    if (!state.acceptNextState && state.lastRev !== null && next.rev < state.lastRev) return false;

    let toasts = state.toasts;
    for (const notice of lobbyNotices(state.lobby, next, state.self?.playerId ?? null)) {
      toasts =
        notice.kind === "hostChanged"
          ? withToast(toasts, "hostChanged", de.notices.hostChanged(notice.name))
          : withToast(toasts, "playerResigned", de.notices.playerResigned(notice.name));
    }
    const question = next.question;
    const pendingAnswer =
      state.pendingAnswer && question?.id === state.pendingAnswer.questionId ? state.pendingAnswer : null;
    const pendingPick =
      state.pendingPick && next.phase === "category_pick" && next.phaseStartedAt === state.pendingPick.phaseStartedAt
        ? state.pendingPick
        : null;

    useGameStore.setState({
      code: next.code,
      lobby: next,
      lastRev: next.rev,
      acceptNextState: false,
      toasts,
      pendingAnswer,
      pendingPick,
      categories: next.turn ? mergeCategories(state.categories, next.turn.options) : state.categories,
      timingMode: inferTimingMode(next) ?? state.timingMode,
    });
    return true;
  },

  /**
   * Übernimmt `lobby:self` (nur für die aktuelle Lobby) und gleicht eine unbestätigte Antwort ab: Der Server
   * ist autoritativ – kennt er sie nicht, kam sie nie an. Läuft die Frage noch, gibt es einen Hinweis zum
   * erneuten Tippen; sonst zeigt die Auflösung „keine Antwort“.
   */
  applyPrivateState(self: PrivatePlayerState): void {
    const state = useGameStore.getState();
    if (state.exit) return;
    const pending = state.pendingAnswer;
    if (pending?.unconfirmed !== true) {
      useGameStore.setState({ self });
      return;
    }
    if (self.myAnswer?.questionId === pending.questionId) {
      useGameStore.setState({ self, pendingAnswer: { ...pending, unconfirmed: false } });
      return;
    }
    const stillOpen = state.lobby?.phase === "question" && state.lobby.question?.id === pending.questionId;
    useGameStore.setState({
      self,
      pendingAnswer: null,
      toasts: stillOpen ? withToast(state.toasts, "error", de.game.answerNotReceived) : state.toasts,
    });
  },

  /** Server-Hinweis (`notice`). HOST_CHANGED/PLAYER_LEFT ergeben sich aus dem Zustandsvergleich. */
  applyNotice(code: NoticeCode): void {
    if (code === "SERVER_RESTART") {
      useGameStore.setState((state) => ({
        toasts: withToast(state.toasts, "serverRestart", de.notices.serverRestart),
      }));
    } else if (code === "MAINTENANCE") {
      useGameStore.setState({ maintenance: true });
    }
  },

  /** Die Lobby ist für diese Person vorbei (entfernt, aufgegeben, geschlossen). */
  exitLobby(exit: LobbyExit): void {
    useGameStore.setState({ exit, lobby: null, self: null, pendingAnswer: null, pendingPick: null, toasts: [] });
  },

  /** Vor `lobby:resume`: der nächste Zustand gilt unabhängig von `rev`. */
  beginResync(): void {
    useGameStore.setState({ acceptNextState: true });
  },

  /** `lobby:resume` war erfolgreich: Timer mit der Restzeit neu starten. */
  resumed(): void {
    useGameStore.setState((state) => ({ syncGeneration: state.syncGeneration + 1 }));
  },

  /** Uhren-Offset in ganzen Millisekunden (der Median zweier Messungen kann auf ,5 enden). */
  setOffset(offset: number): void {
    if (Number.isFinite(offset)) useGameStore.setState({ offset: Math.round(offset) });
  },

  // --- Verbindung ------------------------------------------------------------------------------

  connecting(): void {
    useGameStore.setState((state) =>
      state.connection.status === "idle" ? { connection: { ...state.connection, status: "connecting" } } : {},
    );
  },

  /** Verbunden: Overlay aus, Fehler vergessen; eine neue Verbindung beendet auch den Wartungshinweis. */
  connected(): void {
    useGameStore.setState((state) => ({
      connection: { status: "connected", lostAt: null, graceUntil: null, lastError: null, fatal: null },
      maintenance: state.connection.status === "connected" ? state.maintenance : false,
    }));
  },

  /** Verbindung verloren (Socket.IO verbindet neu): Frist ab jetzt, falls sie nicht schon läuft. */
  connectionLost(now: number): void {
    useGameStore.setState((state) => {
      if (state.connection.fatal) return {};
      const lostAt = state.connection.lostAt ?? now;
      return {
        connection: {
          ...state.connection,
          status: state.connection.status === "offline" ? "offline" : "reconnecting",
          lostAt,
          graceUntil: state.connection.graceUntil ?? graceFrom(state, lostAt),
        },
      };
    });
  },

  /** Browser meldet „offline“ – sofort anzeigen, ohne auf den Ping-Timeout zu warten. */
  wentOffline(now: number): void {
    useGameStore.setState((state) => {
      if (state.connection.fatal || state.connection.status === "idle") return {};
      const lostAt = state.connection.lostAt ?? now;
      return {
        connection: {
          ...state.connection,
          status: "offline",
          lostAt,
          graceUntil: state.connection.graceUntil ?? graceFrom(state, lostAt),
        },
      };
    });
  },

  /** Browser meldet „online“: bis zur neuen Verbindung gilt „verbindet neu“. */
  wentOnline(): void {
    useGameStore.setState((state) =>
      state.connection.status === "offline" ? { connection: { ...state.connection, status: "reconnecting" } } : {},
    );
  },

  /** Vorübergehende Ablehnung beim Verbindungsaufbau (Neuversuch folgt). */
  connectionRejected(code: ErrorCode): void {
    useGameStore.setState((state) => ({ connection: { ...state.connection, lastError: code } }));
  },

  /** Endgültiger Fehler – kein automatischer Neuversuch. */
  connectionFatal(code: ErrorCode): void {
    useGameStore.setState((state) => ({
      connection: { ...state.connection, fatal: code },
      updateRequired: state.updateRequired || code === "UPDATE_REQUIRED",
    }));
  },

  // --- Spiel ------------------------------------------------------------------------------------

  setPendingAnswer(pending: PendingAnswer | null): void {
    useGameStore.setState({ pendingAnswer: pending });
  },

  /** `game:answer` ohne Ack (`NETWORK`): Antwort bis zum nächsten `lobby:self` als unbestätigt markieren. */
  answerUnconfirmed(questionId: string): void {
    useGameStore.setState((state) =>
      state.pendingAnswer?.questionId === questionId
        ? { pendingAnswer: { ...state.pendingAnswer, unconfirmed: true } }
        : {},
    );
  },

  setPendingPick(pending: PendingPick | null): void {
    useGameStore.setState({ pendingPick: pending });
  },

  /** Kategorie-Darstellungen ergänzen (Ersatz aus `GET /api/categories`). */
  addCategories(options: readonly CategoryOption[]): void {
    useGameStore.setState((state) => ({ categories: mergeCategories(state.categories, options) }));
  },

  // --- UI -----------------------------------------------------------------------------------------

  setSoundOn(soundOn: boolean): void {
    useGameStore.setState({ soundOn });
  },

  showToast(kind: ToastKind, text: string): void {
    useGameStore.setState((state) => ({ toasts: withToast(state.toasts, kind, text) }));
  },

  dismissToast(id: number): void {
    useGameStore.setState((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  /** Nur für Tests und die Dev-Vorschau: alles zurück auf Anfang. */
  resetAll(): void {
    useGameStore.setState(initialState(), true);
  },
};

// --- Selektoren (docs/07: Selektoren statt ganzer Store-Abos) -------------------------------------

export const selectLobby = (state: GameStoreState) => state.lobby;
export const selectSelf = (state: GameStoreState) => state.self;
export const selectPhase = (state: GameStoreState) => state.lobby?.phase ?? null;
export const selectCode = (state: GameStoreState) => state.code;
export const selectOffset = (state: GameStoreState) => state.offset;
export const selectSyncGeneration = (state: GameStoreState) => state.syncGeneration;
export const selectConnection = (state: GameStoreState) => state.connection;
export const selectExit = (state: GameStoreState) => state.exit;
export const selectCategories = (state: GameStoreState) => state.categories;
export const selectSoundOn = (state: GameStoreState) => state.soundOn;
export const selectPendingAnswer = (state: GameStoreState) => state.pendingAnswer;
export const selectPendingPick = (state: GameStoreState) => state.pendingPick;
export const selectCurrentToast = (state: GameStoreState) => state.toasts[0] ?? null;
export const selectMaintenance = (state: GameStoreState) => state.maintenance;
export const selectUpdateRequired = (state: GameStoreState) => state.updateRequired;
export const selectSelfId = (state: GameStoreState) => state.self?.playerId ?? null;
export const selectIsHost = (state: GameStoreState) => state.self?.isHost ?? false;
/** Fehlen Kategorie-Darstellungen für Tafel/Zug/Frage? (boolesch, damit nur ein Wechsel neu rendert) */
export const selectCategoriesMissing = (state: GameStoreState) =>
  missingCategoryIds(state.lobby, state.categories).length > 0;

/**
 * Soll das Verbindungs-Overlay erscheinen? Nur auf der Lobby-/Spielseite (Lobby-Kontext), nicht bei
 * endgültigen Fehlern – auch schon vor dem ersten Zustand, wenn der erste Verbindungsaufbau scheitert
 * (dann ohne Frist, mit Lade-Indikator).
 */
export function selectConnectionOverlayVisible(state: GameStoreState): boolean {
  const { status, fatal } = state.connection;
  if (fatal || state.exit || (state.code === null && !state.lobby)) return false;
  return status === "reconnecting" || status === "offline";
}
