/**
 * Läuft im Browser vor der Hydration und vor allen Client-Komponenten (Next-Konvention
 * `instrumentation-client`). zod 4 prüft beim Aufbau des ersten Objekt-Schemas per `new Function("")`, ob es
 * Parser per eval erzeugen darf. Unter unserer strikten CSP (kein `'unsafe-eval'`, docs/06, ADR-008) scheitert
 * das zwar still, der Browser meldet aber jedes Mal einen CSP-Verstoß (`securitypolicyviolation`). Im
 * `jitless`-Modus lässt zod den Test weg und nutzt nur den normalen Parser.
 *
 * Gesetzt wird zods globale Konfiguration (`globalThis.__zod_globalConfig`, dasselbe Objekt, das `z.config()`
 * ändert) direkt – ohne zod hier zu importieren: Diese Datei landet im Start-Bundle jeder Seite, zod selbst
 * kommt erst mit den Seiten, die es brauchen (docs/07 JS-Budget). Muss vor dem ersten Schema-Aufbau laufen
 * (die Schemas aus `@quizmaster/shared` entstehen beim Import) – deshalb hier und synchron. Der Unit-Test prüft
 * gegen das echte zod, dass `z.config().jitless` danach gesetzt ist.
 */
const holder = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
holder.__zod_globalConfig ??= {};
holder.__zod_globalConfig.jitless = true;
