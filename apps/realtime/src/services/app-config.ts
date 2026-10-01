/**
 * appConfig im Speicher (docs/04, docs/06 §Kill-Switches): beim Start einmal geladen, danach synchron
 * lesbar (`get()`), live aktualisierbar über `apply()` – der Hook für den Change-Stream-Watcher. Werte wie
 * `maxActiveLobbies`, `lobbyCreationEnabled`, `maintenance`, `minClientProtocol`, `turnstileOnJoin` und
 * `blockedTerms` stehen damit ohne DB-Roundtrip im Hot Path zur Verfügung.
 */
import type { AppConfigRepo } from "@quizmaster/db";
import { type AppConfigDoc, appConfigDocSchema } from "@quizmaster/shared/documents";

export type AppConfigListener = (next: Readonly<AppConfigDoc>, previous: Readonly<AppConfigDoc>) => void;

export interface AppConfigService {
  /** Aktuelle Konfiguration (unveränderlich; bei Änderungen kommt ein neues Objekt). */
  get(): Readonly<AppConfigDoc>;
  /** Lädt aus der Datenbank und übernimmt (Start, Vollabgleich nach Watcher-Reset). */
  load(): Promise<Readonly<AppConfigDoc>>;
  /** Übernimmt ein Dokument (z. B. `fullDocument` aus dem Change Stream); validiert mit zod, wirft bei Fehlern. */
  apply(doc: unknown): Readonly<AppConfigDoc>;
  /** Benachrichtigung nach jeder Übernahme; liefert die Abmeldung. */
  onChange(listener: AppConfigListener): () => void;
}

export interface AppConfigServiceOptions {
  repo: AppConfigRepo;
  /** Startwert bis zum ersten `load()`. */
  initial: AppConfigDoc;
  /** Fehler eines Listeners (Listener dürfen die Übernahme nicht verhindern). */
  onListenerError: (error: unknown) => void;
}

function freeze(doc: AppConfigDoc): Readonly<AppConfigDoc> {
  return Object.freeze({
    ...doc,
    maintenance: Object.freeze({ ...doc.maintenance }),
    catalog: Object.freeze({ ...doc.catalog, difficultyMix: Object.freeze({ ...doc.catalog.difficultyMix }) }),
    blockedTerms: Object.freeze([...doc.blockedTerms]) as string[],
  });
}

export function createAppConfigService(options: AppConfigServiceOptions): AppConfigService {
  let current = freeze(appConfigDocSchema.parse(options.initial));
  const listeners = new Set<AppConfigListener>();

  const apply = (doc: unknown): Readonly<AppConfigDoc> => {
    const next = freeze(appConfigDocSchema.parse(doc));
    const previous = current;
    current = next;
    for (const listener of listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        options.onListenerError(error);
      }
    }
    return next;
  };

  return {
    get: () => current,
    async load() {
      return apply(await options.repo.get());
    },
    apply,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
