/**
 * Einstellungen des Hosts gebündelt senden (ADR-042): Jeder Stepper-Tipp erscheint sofort (Entwurf), gesendet
 * wird erst nach einer kurzen Pause – bei Dauertippen spätestens jede Sekunde – und immer nur der neueste Stand.
 * So bleibt der Host weit unter dem Server-Limit (40 je 10 s), und „Zu viele Versuche“ kommt beim Einstellen nicht
 * mehr vor. Der Entwurf gilt, bis ein `lobby:state` ihn bestätigt (der Server sendet das Ack VOR dem Zustand –
 * sonst spränge der Wert kurz zurück).
 */
import type { LobbySettings, SettingsUpdate } from "@quizmaster/shared";
import type { ClientErrorCode } from "./errors";
import type { EmitResult } from "./realtime-client";

export const SETTINGS_SYNC_TIMING = {
  /** Pause nach dem letzten Tipp, bevor gesendet wird */
  idleMs: 350,
  /** Spätestens so lange nach dem ersten ungesendeten Tipp wird gesendet (Dauertippen) */
  maxWaitMs: 1_000,
  /** Wartezeit nach RATE_LIMITED ohne `retryAfterMs` */
  retryFallbackMs: 1_000,
} as const;

export interface SettingsSyncDeps {
  send(update: SettingsUpdate): Promise<EmitResult<null>>;
  /** Entwurf geändert (optimistische Anzeige: Server-Stand + Entwurf) */
  onDraft(draft: Partial<LobbySettings>): void;
  /** Endgültig abgelehnt (nicht RATE_LIMITED): Server-Stand neu holen bzw. Fehler zeigen */
  onRejected(code: ClientErrorCode): void;
}

type SettingsKey = keyof LobbySettings;
type SettingsValue = LobbySettings[SettingsKey];
type SettingsEntries = Partial<Record<SettingsKey, SettingsValue>>;

/** Gleicher Wert – auch für Kategorie-Listen (ADR-048). */
function sameValue(a: SettingsValue | undefined, b: SettingsValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  return false;
}

/** Entwurf als Einstellungs-Teilobjekt (die Schlüssel stammen immer aus `LobbySettings`). */
function asSettings(entries: SettingsEntries): Partial<LobbySettings> {
  return entries as Partial<LobbySettings>;
}

/** Einträge des Entwurfs, die vom Server-Stand abweichen. */
function unconfirmed(draft: Partial<LobbySettings>, server: LobbySettings): Partial<LobbySettings> {
  const result: SettingsEntries = {};
  for (const [key, value] of Object.entries(draft) as [SettingsKey, SettingsValue | undefined][]) {
    if (value !== undefined && !sameValue(value, server[key])) result[key] = value;
  }
  return asSettings(result);
}

function isEmpty(values: Partial<LobbySettings>): boolean {
  return Object.keys(values).length === 0;
}

function sameEntries(a: Partial<LobbySettings>, b: Partial<LobbySettings>): boolean {
  const keys = Object.keys(a) as SettingsKey[];
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]));
}

export class SettingsSync {
  #server: LobbySettings;
  #deps: SettingsSyncDeps;
  #draft: Partial<LobbySettings> = {};
  #timer: ReturnType<typeof setTimeout> | undefined;
  #firstUnsentAt: number | null = null;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  /** Laufendes Senden (Ack steht aus) */
  #sending: Promise<void> | null = null;
  /** Bestätigt gesendete Werte: der nächste `lobby:state` ist dafür maßgeblich */
  #awaiting: Partial<LobbySettings> | null = null;
  #disposed = false;

  constructor(server: LobbySettings, deps: SettingsSyncDeps) {
    this.#server = server;
    this.#deps = deps;
  }

  /** Neue Abhängigkeiten (z. B. nach einem Neurendern mit anderen Callbacks). */
  setDeps(deps: SettingsSyncDeps): void {
    this.#deps = deps;
  }

  /** Ein Tipp: sofort anzeigen, Senden planen. */
  change(update: SettingsUpdate): void {
    if (this.#disposed) return;
    const next: SettingsEntries = { ...this.#draft };
    for (const [key, value] of Object.entries(update) as [SettingsKey, SettingsValue | undefined][]) {
      if (value !== undefined) next[key] = value;
    }
    this.#setDraft(asSettings(next));
    const now = Date.now();
    this.#firstUnsentAt ??= now;
    this.#schedule(Math.min(now + SETTINGS_SYNC_TIMING.idleMs, this.#firstUnsentAt + SETTINGS_SYNC_TIMING.maxWaitMs));
  }

  /**
   * Neuer Server-Stand (`lobby:state`): bestätigte Werte fallen aus dem Entwurf; für bestätigt gesendete Werte
   * gilt der Server-Stand auch dann, wenn er abweicht (der Zustand folgt dem Ack).
   */
  serverChanged(server: LobbySettings): void {
    this.#server = server;
    if (this.#sending !== null) return;
    const awaiting = this.#awaiting;
    this.#awaiting = null;
    const kept: SettingsEntries = {};
    for (const [key, value] of Object.entries(this.#draft) as [SettingsKey, SettingsValue | undefined][]) {
      if (value === undefined || sameValue(value, server[key])) continue;
      if (awaiting !== null && sameValue(awaiting[key], value)) continue;
      kept[key] = value;
    }
    if (!sameEntries(asSettings(kept), this.#draft)) this.#setDraft(asSettings(kept));
  }

  /**
   * Offene Tipps sofort senden und warten, bis der Server sie hat – beim Schließen des Sheets und vor „Spiel
   * starten“ (sonst käme eine Änderung der letzten 350 ms erst nach dem Start an und ginge verloren).
   */
  async flush(): Promise<void> {
    for (let round = 0; round < 3 && !this.#disposed; round++) {
      if (this.#sending !== null) await this.#sending;
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      if (isEmpty(this.#pending())) return;
      await this.#send();
    }
  }

  /** Wieder aktiv (z. B. erneutes Einhängen; React StrictMode hängt Effekte doppelt ein). */
  start(): void {
    this.#disposed = false;
  }

  /** Nichts mehr senden (Aushängen); geplantes Senden entfällt. */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #setDraft(draft: Partial<LobbySettings>): void {
    this.#draft = draft;
    this.#deps.onDraft(draft);
  }

  /** Noch zu sendende Werte: weichen vom Server-Stand ab und sind nicht schon bestätigt gesendet. */
  #pending(): Partial<LobbySettings> {
    const result: SettingsEntries = {};
    for (const [key, value] of Object.entries(unconfirmed(this.#draft, this.#server)) as [
      SettingsKey,
      SettingsValue,
    ][]) {
      if (!sameValue(this.#awaiting?.[key], value)) result[key] = value;
    }
    return asSettings(result);
  }

  /** Senden zum Zeitpunkt `at` planen – nie früher als 350 ms nach dem letzten Senden. */
  #schedule(at: number): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const due = Math.max(at, this.#lastSentAt + SETTINGS_SYNC_TIMING.idleMs);
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        void this.#send();
      },
      Math.max(0, due - Date.now()),
    );
  }

  /** Sendet die offenen Werte (läuft schon ein Senden: dessen Promise – danach plant es selbst nach). */
  #send(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#sending !== null) return this.#sending;
    const update = this.#pending();
    this.#firstUnsentAt = null;
    if (isEmpty(update)) {
      const kept = unconfirmed(this.#draft, this.#server);
      if (!sameEntries(kept, this.#draft)) this.#setDraft(kept);
      return Promise.resolve();
    }
    const sending = this.#exchange(update).finally(() => {
      if (this.#sending === sending) this.#sending = null;
    });
    this.#sending = sending;
    return sending;
  }

  async #exchange(update: Partial<LobbySettings>): Promise<void> {
    this.#lastSentAt = Date.now();
    const result = await this.#deps.send(update);
    if (this.#disposed) return;
    if (!result.ok) {
      if (result.code === "RATE_LIMITED") {
        this.#firstUnsentAt = Date.now();
        this.#schedule(Date.now() + (result.retryAfterMs ?? SETTINGS_SYNC_TIMING.retryFallbackMs));
        return;
      }
      // Abgelehnt: gesendete, seither unveränderte Werte verwerfen – der Server-Stand gilt.
      const kept: SettingsEntries = {};
      for (const [key, value] of Object.entries(this.#draft) as [SettingsKey, SettingsValue | undefined][]) {
        if (value !== undefined && !sameValue(update[key], value)) kept[key] = value;
      }
      this.#setDraft(asSettings(kept));
      this.#deps.onRejected(result.code);
    } else {
      this.#awaiting = { ...this.#awaiting, ...update };
    }
    // Während des Sendens weitergetippt? Dann den neuesten Stand hinterherschicken.
    if (!isEmpty(this.#pending())) {
      this.#firstUnsentAt = Date.now();
      this.#schedule(Date.now() + SETTINGS_SYNC_TIMING.idleMs);
    }
  }
}
