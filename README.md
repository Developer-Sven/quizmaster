# quizmaster

Live-Quiz-Duelle für 2–8 Personen im Browser – als installierbare PWA, ohne Konto. Eine Person erstellt eine
Lobby, die anderen treten per Code oder Link bei. Gespielt wird nach Quizduell-Regeln: pro Runde wählt jede
Person einmal aus drei Kategorien, je Frage vier Antworten und standardmäßig 20 Sekunden, ein Punkt pro richtiger
Antwort. Runden, Fragen je Kategorie, Zeit pro Frage, Kategorien, Schwierigkeit und Tempo stellt der Host in der
Lobby ein. Der Server ist autoritativ – Antworten, Zeiten und Punkte werden nur dort ausgewertet.

Spezifikation, Architekturentscheidungen (ADRs) und der Fragenkatalog werden getrennt gepflegt und sind nicht
öffentlich. Verweise im Code wie `docs/06` oder `ADR-042` beziehen sich darauf; dieses README fasst zusammen, was für
Entwicklung und Betrieb nötig ist.

## Architektur

- **apps/web** – Next.js 16 (App Router, `output: standalone`): Seiten, PWA, Gast-Session, Socket-Tickets, CSP.
- **apps/realtime** – Node 24 + Socket.IO 4.8: Lobbys im Speicher, Spiel-Engine, Timer, Rate-Limits, Metriken.
- **packages/** – `shared` (zod-Verträge), `game-engine` (reine State-Machine), `db` (MongoDB-Zugriff, Indizes).
- **MongoDB ≥ 8 als Replica Set** – Change Streams (Live-Updates, Kill-Switches) und Transaktionen, nur über `MONGODB_URI`.
- **Produktion** – Cloudflare (Proxy) → Caddy (Origin-Zertifikat) → pm2: Web auf `127.0.0.1:<Port>`, Realtime auf `<Port>+1`.

## Voraussetzungen

- Node.js 24 (`.nvmrc`) und pnpm 12 über Corepack (Version und Hash stehen in `package.json` → `packageManager`)
- MongoDB ≥ 8.0 als Replica Set mit TLS (je Umgebung eigene Datenbank und eigener Benutzer mit `readWrite`)
- Für den Betrieb: Linux-Server mit pm2, Caddy ≥ 2.7, Cloudflare als Proxy, MongoDB Database Tools
  (`mongodump`/`mongorestore`), GnuPG

Auf einem geteilten Server muss das System-Node nicht ersetzt werden: Node 24, pnpm, Caches und Browser können
isoliert in `.tooling/` liegen (nicht im Repo) und werden pro Shell aktiviert. Die Betriebsskripte nehmen Node 24
aus `QM_NODE`, sonst aus der Laufzeit des Deploys (`.deploy/runtime`), sonst aus `.tooling/`.

## Einrichten

```bash
corepack enable pnpm                 # bzw. die isolierte Toolchain der Shell aktivieren
pnpm install --frozen-lockfile
pnpm setup:env dev                   # legt .env.dev mit frischen Secrets an (Rechte 600, überschreibt nie)
# MONGODB_URI des Dev-Clusters in .env.dev eintragen
pnpm env:check dev --connect         # prüft Schema, TLS, Replica Set, Version und Datenbankrechte
```

Es gibt genau eine Env-Datei je Umgebung (`.env.dev`, `.env.prod`; Vorlagen `*.example` im Repo). Alle
abgeleiteten Werte (Ports, Origins) und die Schlüssel je App entstehen an einer Stelle (`@quizmaster/shared/env`).
Env-Dateien werden nie committet und von den Werkzeugen nie ausgegeben.

## Entwicklung

| Befehl | Zweck |
|---|---|
| `pnpm dev` | Web und Realtime mit `.env.dev` (Standard: Web :3000, Realtime :4000) |
| `pnpm check` | Biome, Typecheck, alle Tests und Content-Validierung |
| `pnpm test` | Unit-, Property- und Integrationstests (Vitest) |
| `pnpm test:e2e` | Playwright gegen zwei Test-Stacks (siehe „Test-Stack & E2E“) |
| `pnpm stack:test` | Test-Stack (Test-Datenbank, Fixtures, Web + Realtime) für E2E und manuelle Prüfungen |
| `pnpm build` | Produktions-Build (Next standalone inkl. Service Worker, Realtime-Bundle) |

Automatische Tests laufen nie gegen Dev- oder Produktionsdaten: lokal in `quizmaster_test` mit eigenem
Collection-Präfix je Lauf, in der CI gegen `MongoMemoryReplSet` 8.0.32 (Verbindung: `TEST_MONGODB_URI`, siehe
„Test-Stack & E2E“).

**CI** (GitHub Actions, `.github/workflows/ci.yml`): Lint (Biome, shellcheck für `infra/`), Typecheck, Tests,
Content-Validierung, Build, E2E, `pnpm audit --prod` (hohe/kritische Befunde brechen ab) und Trivy: ein
Secret-Scan über das Repo und ein Schwachstellen-Scan des Projekt-Lockfiles. pnpm ≥ 11 schreibt `pnpm-lock.yaml`
als zwei YAML-Dokumente (zuerst nur pnpm selbst, dann das Projekt) und Trivy liest nur das erste – die CI
extrahiert deshalb das Projekt-Dokument und scannt es separat. Actions sind per Commit-SHA gepinnt, Dependabot
schlägt Updates wöchentlich mit Wartezeit vor. Die CI deployt nicht. Unter *Insights → Dependency graph* sollten
die Projektpakete (z. B. `next`, `socket.io`) erscheinen und nicht nur pnpm – sonst liest GitHub das Lockfile nicht.
Täglich (05:17 UTC) laufen nur Audit und Trivy gegen `main` (per *Run workflow* läuft die ganze CI für den gewählten
Branch): Neue Advisories zu unveränderten
Abhängigkeiten fallen so auch ohne Push auf (ein roter Lauf benachrichtigt) – Dependabot unterstützt laut GitHub-Doku
pnpm nur bis Version 10 und meldet für das pnpm-12-Lockfile womöglich nichts. GitHub pausiert Zeitpläne nach 60 Tagen
ohne Aktivität im Repo.

## Test-Stack & E2E

`pnpm test:e2e` (= `pnpm --filter e2e test`) startet Playwright (`e2e/playwright.config.ts`, nur Chromium; Ablage der
Browser wie üblich über `PLAYWRIGHT_BROWSERS_PATH`) mit Mobil-Viewports gegen zwei Test-Stacks. Beide startet Playwright
selbst als `webServer` und beendet sie am Ende mit `SIGTERM`; sie räumen ihre Test-Collections dabei selbst ab.

| Stack | Skript | Ports (Standard) | Timing | Szenarien (Projekte) |
|---|---|---|---|---|
| Test-Stack | `pnpm stack:test` (`scripts/dev/stack-test.ts`) | Web 3200, Realtime 4200 | `GAME_TIMING=fast` | 1–8, 10, 11 (`pixel-7`, `iphone-15`) |
| Normal-Stack | `node e2e/stack/normal-stack.ts` | Web 3201, Realtime 4201 | `GAME_TIMING=normal` | 9 (`a11y-360`, `a11y-430`), 12 (`sync`) |

```bash
pnpm test:e2e                     # alle Projekte; sync läuft zuletzt und allein (nach allen anderen Projekten)
pnpm --filter e2e test:a11y       # Szenario 9: axe, Design-Checks und Screenshots je Phase (360 × 740 und 430 × 932)
pnpm --filter e2e test:sync       # Szenario 12: Synchronität zweier Geräte, ohne die anderen Projekte (--no-deps)
E2E_REUSE_STACK=1 pnpm test:e2e   # bereits laufende Stacks auf denselben Ports nutzen statt neu zu starten
```

**`pnpm stack:test [--web-port <port>] [--realtime-port <port>] [--no-build] [--log-dir <pfad>] [--log-level
fatal|error|warn|info|debug]`** – vollständiger Stack für E2E und manuelle Prüfungen:

1. Test-Datenbank anlegen (`@quizmaster/db/testing`): `TEST_MONGODB_URI`, sonst lokal `quizmaster_test` auf dem
   Dev-Cluster (`MONGODB_URI` + `TEST_MONGODB_DB` aus `.env.dev`), jeweils mit eigenem Collection-Präfix je Lauf; ohne
   beides (CI) ein `MongoMemoryReplSet`.
2. Fixtures aus `test/fixtures/content/` seeden (gleicher Weg wie `pnpm content:seed`, inkl. Validierung).
3. Realtime (tsdown → `apps/realtime/dist`) und Web (`next build` nach `apps/web/.next-e2e`, eigenes
   `NEXT_DIST_DIR`) nacheinander bauen – mit `--no-build` die vorhandenen Builds nutzen.
4. Erst Realtime, dann Web (`next start`) nur auf `127.0.0.1` starten, jeweils bis `/healthz` bzw. `/api/health`
   antwortet: `GAME_TIMING=fast`, `DEV_BOTS_ENABLED=true`, `RATE_LIMIT_MODE=relaxed`, `TURNSTILE_ENABLED=false`,
   zufällige Secrets je Lauf.
5. Bereit-Zeile `STACK_READY web=… realtime=…`; der Stack läuft bis Strg+C, `SIGTERM` oder `SIGHUP`. Stirbt ein
   Server, endet er mit Exit 1.
6. Beim Ende: Server stoppen (`SIGTERM`, nach 15 s `SIGKILL`), Test-Collections droppen (Reste abgebrochener Läufe
   entfernt der Janitor nach 6 h).

Standards: Ports 3200/4200, Log-Level `info`, Logs in `<tmp>/quizmaster-stack-test/<web-port>/` (`realtime.log`,
`web.log`, `realtime-build.log`, `web-build.log`). Ausgaben und Log-Auszüge enthalten keine Zugangsdaten.

**Normal-Stack** (`node e2e/stack/normal-stack.ts [--web-port 3201] [--realtime-port 4201] [--log-dir <pfad>]
[--log-level warn]`): nutzt die Builds des Test-Stacks (also erst `pnpm stack:test` bauen lassen – Playwright startet
ihn erst, wenn der erste Stack bereit ist), eine eigene Test-Datenbank mit Präfix und seedet jede Fixture-Frage als
Langtext-Variante (140 Zeichen Frage, 40 Zeichen je Antwort), damit Layout-Prüfungen den ungünstigsten Fall sehen.
Phasen laufen in Originallänge (`GAME_TIMING=normal`). Standard-Logs: `e2e/test-results/stack-logs-normal/`, Log-Level
`warn`.

Umgebungsvariablen für Tests, Test-Stacks und E2E:

| Variable | Standard | Wirkung |
|---|---|---|
| `TEST_MONGODB_URI` | leer | Verbindung zur Test-Datenbank für `pnpm test`, die Test-Stacks (also auch E2E) und `pnpm loadtest`; nur aus der Prozessumgebung (Shell, CI), nie aus `.env.dev`. Leer: `MONGODB_URI` + `TEST_MONGODB_DB` aus `.env.dev`, ohne `.env.dev` (CI) ein `MongoMemoryReplSet` |
| `TEST_MONGODB_DB` | `quizmaster_test` | Name der Test-Datenbank (mit `TEST_MONGODB_URI` aus der Shell, sonst aus `.env.dev`); muss auf `_test` enden, sonst bricht der Lauf ab. Jeder Lauf nutzt ein eigenes Collection-Präfix |
| `RATE_LIMIT_MODE` | `normal` | `relaxed` multipliziert alle Rate-Limits und die Verbindungsgrenzen je Gast und IP mit 100; die Test-Stacks und der Lasttest setzen es selbst. Web und Realtime lehnen `relaxed` außerhalb einer `*_test`-Datenbank ab |
| `E2E_WEB_PORT`, `E2E_REALTIME_PORT` | 3200, 4200 | Ports des Test-Stacks |
| `E2E_NORMAL_WEB_PORT`, `E2E_NORMAL_REALTIME_PORT` | jeweils +1 (3201, 4201) | Ports des Normal-Stacks |
| `E2E_WORKERS` | 2 | parallele Worker (1–2) |
| `E2E_REUSE_STACK=1` | aus | laufende Stacks mit denselben Ports nutzen |
| `E2E_NO_BUILD=1` | aus | Test-Stack mit `--no-build` (vorhandene Builds) |
| `E2E_OUTPUT_DIR` | `e2e/test-results` | Ordner für Artefakte (relativ zu `e2e/`) |
| `E2E_SCREENSHOT_DIR` | `docs/screenshots/w3`, falls ein lokales `docs/` existiert (nicht im Repo), sonst `<Artefakte>/screenshots` | Phasen-Screenshots aus Szenario 9 |

**Artefakte:** `e2e/playwright-report/` (HTML-Bericht, öffnet nicht automatisch) und `e2e/test-results/` – Traces und
Screenshots fehlgeschlagener Tests (`trace: retain-on-failure`, `screenshot: only-on-failure`) sowie die Stack-Logs in
`stack-logs/` und `stack-logs-normal/`. Die Screenshots aus Szenario 9 heißen `<name>-<breite>x<höhe>.png`. Beides ist
nicht im Repo (`e2e/.gitignore`); die CI lädt die Ordner bei Fehlern hoch (7 Tage). Jeder Test wird einmal
wiederholt (Szenario 12: zweimal), Zeitlimit 150 s je Test.

## Fragenkatalog

Der Katalog (über 22.000 Fragen in 19 Kategorien) ist nicht Teil dieses Repos und wird getrennt gepflegt; die
Content-Befehle erwarten ihn unter `content/`. Für CI und E2E enthält das Repo synthetische Fixtures in
`test/fixtures/content/`.

| Befehl | Zweck |
|---|---|
| `pnpm content:validate` | Schema und Regeln aller Fragen (`content/`, falls vorhanden, und die Fixtures) |
| `pnpm content:dedupe` / `content:stats` | Dubletten suchen, Abdeckung auswerten |
| `pnpm content:seed --env dev` | Katalog idempotent in die Datenbank übernehmen |
| `pnpm content:seed --env prod --confirm-prod` | dasselbe für Produktion (bricht bei auffällig vielen Rückzügen ab) |

Änderungen am Katalog werden per Change Stream sofort live – ein Neustart ist nicht nötig. Fragen, die mehrere
unabhängige Spielende melden oder schlecht bewerten, nimmt die Schutzautomatik selbst aus dem Pool (siehe
„Schutzautomatik und Prüf-Queue“).

## Betrieb

### Konfiguration

```bash
pnpm setup:env prod --domain quiz.example.com --port 7400 --tls-cert <origin-cert.pem> --tls-key <origin-key.pem>
pnpm env:check prod --connect
```

Domain und Port stehen ausschließlich in `.env.prod`. Web lauscht auf `127.0.0.1:<Port>`, Realtime auf
`127.0.0.1:<Port + 1>` (oder `REALTIME_PORT`). `TRUSTED_IP_HEADER=cf-connecting-ip` ist nur gesetzt, weil die
Site ausschließlich über Cloudflare erreichbar ist (siehe Caddy).

### Systembenutzer

Web, Realtime und Watchdog laufen nicht als root, sondern als Systembenutzer `quizmaster`. Eine Lücke in Next.js
oder Socket.IO bleibt damit auf dessen Rechte beschränkt: er kann die Env-Dateien der Apps lesen und `.next/cache`
beschreiben, aber weder Releases, Laufzeit oder Deploy-Zustand ändern noch Dateien lesen, die nur root lesen darf
(z. B. Env-Dateien anderer Apps mit 600, Origin-Schlüssel, Backups).

```bash
pnpm ops:create-user --dry-run   # Vorschau, ändert nichts (geht auch ohne root)
pnpm ops:create-user             # als root: Gruppe und Benutzer quizmaster anlegen (idempotent)
pnpm deploy:restart              # bzw. das nächste pnpm deploy:prod – erst dann laufen die Apps als quizmaster
pnpm deploy:status               # Benutzer je App und Rechte der Env-Dateien
```

`infra/ops/create-user.sh` sichert zuerst `/etc/passwd`, `/etc/group`, `/etc/shadow` und `/etc/gshadow` in ein nur
für root lesbares Sicherungsverzeichnis und legt dann – nur, falls sie fehlen – die Systemgruppe und den
Systembenutzer `quizmaster` an: ohne Home (`/nonexistent`), Shell `nologin`, gesperrtes Passwort. Vorhandene
Einträge prüft es nur; uid/gid 0, eine Login-Shell, eine andere primäre Gruppe, eine zweite Kennung mit derselben uid
oder weitere Konten in der Gruppe brechen ab, ohne etwas zu ändern.

**Wirkung:** `ecosystem.config.js` löst den Benutzer über `/etc/passwd` und `/etc/group` auf (gemeinsam mit dem
Deploy, `scripts/deploy/service-user.cjs`) und gibt pm2 dessen uid/gid; der pm2-Daemon (root) startet die Apps damit
und ohne Zusatzgruppen. Vor jeder Aktivierung (`deploy:prod`, `deploy:rollback`, `deploy:restart`) setzt und prüft
der Deploy die Rechte – passt etwas nicht, bricht er mit `SERVICE_ACCESS` ab, bevor etwas umgeschaltet wird:

| Pfad | Rechte |
|---|---|
| `.deploy` | 0711 root – erreichbar, aber nicht auflistbar |
| `.deploy/env`, `.deploy/env/*.env` | 0750 bzw. 0640 root:quizmaster – lesbar, nicht änderbar |
| `.deploy/releases` | 0750 root:quizmaster – nur für die Gruppe: der Next.js-Build enthält Schlüssel (Preview-Modus, Server Actions) |
| `.deploy/releases/<sha>`, `.deploy/runtime` | 0755/0644 root – lesbar; dass `quizmaster` nichts davon ändern kann, prüft der Deploy Datei für Datei |
| `.deploy/releases/<sha>/web/apps/web/.next/cache` | 0700 quizmaster – die einzige beschreibbare Stelle (Next.js-Cache) |

Dateien, auf die `MONGODB_URI` verweist (`tlsCAFile`, `tlsCertificateKeyFile`, `tlsCRLFile`), müssen für
`quizmaster` lesbar sein, und was der pm2-CLI als root lädt (`ecosystem.config.js`, `scripts/deploy/service-user.cjs`),
darf `quizmaster` nicht ändern können – beides prüft der Deploy ebenfalls. Der Smoke-Test prüft je App über
`/proc/<pid>/status`, dass sie mit uid/gid `quizmaster` läuft (nie root); `pnpm deploy:status` zeigt den Benutzer je
App. `pm2 status` nennt in der Spalte `user` nur den Aufrufer (root) und ist dafür nicht maßgeblich. Nach einem
Neustart des Servers stellt `pm2 resurrect` die Apps mit derselben uid/gid wieder her (`dump.pm2`).

**Ohne Dienstbenutzer** laufen die Apps als root (Env-Dateien 0600, `.deploy/env` und `.deploy/releases` 0700 root);
Preflight und `pnpm deploy:status` warnen dann. Uneindeutige Einträge (uid/gid 0, Gruppe mit weiteren Konten,
unlesbare `/etc/passwd`) brechen ab, statt still auf root zurückzufallen.

**Rückweg** (zurück zu root), als root: zuerst `/etc/passwd`, `/etc/group`, `/etc/shadow` und `/etc/gshadow` in ein
nur für root lesbares Verzeichnis sichern (wie es `pnpm ops:create-user` tut), dann:

```bash
userdel quizmaster && groupdel quizmaster     # kein Home zu löschen
pnpm deploy:restart                           # startet alle Apps wieder als root
```

`ecosystem.config.js` gibt pm2 dann uid/gid 0 – das setzt die in pm2 gespeicherte uid zurück –, der Deploy stellt die
Env-Dateien wieder auf 0600 root, `.deploy/env` und `.deploy/releases` auf 0700 root und ersetzt `.next/cache` des
laufenden Releases durch ein root-Verzeichnis (andere Releases beim nächsten Aktivieren). Wieder hin:
`pnpm ops:create-user` und `pnpm deploy:restart`.

### Deploy und Rollback

```bash
tmux new -s deploy               # Deploy immer in tmux/screen starten (siehe unten)
pnpm deploy:prod                 # baut HEAD (Arbeitsbaum muss sauber sein) und aktiviert ihn
pnpm deploy:prod --sha <rev>     # bestimmten Commit deployen
pnpm deploy:prod --dry-run       # nur Preflight + Audit + Sicherungsplan, ändert nichts
pnpm deploy:rollback             # zurück auf das vorherige Release (erneut: noch eins zurück)
pnpm deploy:status               # aktives/vorheriges Release, pm2-Zustand, letzte Aktionen
pnpm deploy:restart --apps web,realtime   # Env aus .env.prod neu erzeugen und Apps neu starten
```

`deploy:prod` prüft zuerst Werkzeuge, Arbeitsbaum, `.env.prod` (inkl. Datenbankverbindung), Ports, Platz und den
Dienstbenutzer (siehe Systembenutzer). Dann baut es aus `git archive` in `.deploy/build/<sha>` (Installation
offline mit gefrorenem Lockfile), führt das Audit-Gate aus (`pnpm audit --prod --audit-level high`; `--skip-audit`
nur im Notfall) und legt das Release unter `.deploy/releases/<sha>` ab (einheitlich 755/644, Besitzer root). Aus
`.env.prod` entsteht je App eine Env-Datei mit nur ihren Schlüsseln (`.deploy/env/*.env`, 0640 root:quizmaster,
ohne Dienstbenutzer 0600). Unmittelbar vor der Aktivierung setzt und prüft der Deploy die Rechte für den
Dienstbenutzer. Danach wird `.deploy/current` atomar umgehängt und in der Reihenfolge
Web → Smoke-Test → Realtime → Smoke-Test → Watchdog gestartet. Der Smoke-Test prüft, dass jede App mit der
erwarteten uid/gid läuft (mit Dienstbenutzer nie als root), `/api/health`, die Startseite (HTML mit CSP-Nonce, die
ihre Skripte tragen) und ein darin referenziertes `/_next/static`-Asset, `/healthz`, dass ein Socket.IO-Handshake
ohne Ticket mit `UNAUTHORIZED` abgelehnt wird, dass `/metrics` ohne Token gesperrt ist und dass die Prozesse nur
auf Loopback lauschen. Schlägt etwas fehl, geht der Deploy
automatisch auf das vorherige Release zurück und endet mit Fehler. Bei Erfolg wird `dump.pm2` gesichert (die
letzten 20 Sicherungen in einem nur für root lesbaren Verzeichnis), `pm2 save` ausgeführt, danach über
den Host-Caddy `https://<domain>/api/health` kontrolliert (nur Warnung) und es bleiben die letzten drei Releases.
Nicht abgedeckt sind ein vollständiger Lobby-Durchlauf (Session, Ticket, `lobby:create`) und die Bereitschaft von
Mongo/Change Streams – das gehört in den Watchdog (siehe Monitoring).

**Gemeinsamer pm2-Daemon:** `pm2 save` würde den Zustand *aller* Apps des Servers als Boot-Zustand speichern
(auch eine gerade manuell gestoppte fremde App). Der Deploy übernimmt deshalb nach dem Save für alle fremden Apps
wieder exakt die vorher gespeicherten Einträge; nur `quizmaster-*` ändert sich. Abweichungen fremder Apps vom
gespeicherten Stand werden mit Name und Status gemeldet, aber nie verändert.

**Abbruch und SSH-Verbindung:** Strg+C, `SIGTERM` und ein Verbindungsabbruch (`SIGHUP`) brechen nur *vor* der
Aktivierung ab. Eine begonnene Aktivierung läuft immer zu Ende – inklusive Rückweg, `state.json` und `pm2 save`;
ein zweites Strg+C wird dann nur gemeldet (Notfall: `kill -9 <pid>`). Weil die Ausgabe bei einem
Verbindungsabbruch verloren ist, den Deploy in `tmux`/`screen` starten. `pnpm deploy:status` (und jeder neue
Deploy/Rollback) warnt, wenn `current` nicht zum zuletzt erfolgreich aktivierten Release passt – dann wurde eine
Aktivierung hart beendet: `pnpm deploy:prod --sha <sha>` erneut oder `pnpm deploy:rollback`.

**Datenbank und Rollback:** Ein Rollback tauscht nur Code. Realtime ruft beim Start `ensureIndexes()` auf (Indizes,
`$jsonSchema`-Validator per `collMod`, `appConfig`). Deshalb sichert `deploy:prod`/`deploy:rollback` die
Datenbank unmittelbar vor der Aktivierung (`infra/ops/backup.sh --no-files`), wenn sich zwischen laufendem und
Ziel-Release `packages/db/src/{indexes,validators,collections}.ts`, `packages/shared/src/documents/` oder
`scripts/migrations/` ändern, beim ersten Release und wenn der Vergleich nicht möglich ist. Scheitert die
Sicherung, wird nichts umgeschaltet (`--skip-backup` nur im Notfall). Für Schema-Änderungen gilt Expand/Contract:
jedes Release muss mit den Daten und Indizes seines Vorgängers laufen (neue Felder optional, Indizes erst
ergänzen, Altes erst im übernächsten Release entfernen) – sonst scheitert auch der Rückweg. Ein Rollback über eine
Validator-Änderung hinweg setzt den Validator auf den alten Stand zurück; ein umbenannter Index lässt den Start des
alten Releases scheitern (`ensureIndexes`: Index-Konflikt) – dann die Sicherung einspielen (`pnpm ops:restore`).

### Drill: Deploy im Testmodus

Deploy, Rollback und Rückwege lassen sich proben, ohne die laufenden Apps zu berühren: mit einem eigenen pm2-Daemon
(`PM2_HOME` auf ein eigenes Verzeichnis, nie `~/.pm2` – sonst bricht der Testmodus ab) und `--test-env <datei>` (eigene
Quell-Env mit Test-Ports und `*_test`-Datenbank, eigenes Layout `.deploy/test`). `--test-env` gilt für alle
`deploy:*`-Befehle.

```bash
node scripts/deploy/drill-env.ts create <datei>    # Test-DB mit eigenem Präfix, Ports 7490/7491, frische Secrets, 600
PM2_HOME=<test-daemon> pnpm deploy:prod --test-env <datei> [--test-user nobody] [--simulate-failure realtime]
PM2_HOME=<test-daemon> pnpm deploy:rollback --test-env <datei>
node scripts/deploy/drill-env.ts cleanup <datei>   # nach dem Beenden der Test-Apps: Präfix droppen, Datei löschen
```

Lohnende Proben: Erst-Deploy (als Dienstbenutzer und als root), Deploy eines zweiten Releases, `deploy:rollback`,
automatischer Rückweg nach `--simulate-failure web|realtime|watchdog` (auch beim Erst-Deploy), `kill -9` auf Realtime,
`pm2 kill` + `pm2 resurrect` – nur mit gesetztem `PM2_HOME` des Test-Daemons, nie im gemeinsamen Daemon (uid/gid
bleiben erhalten) –, Rückweg zu root, jeweils mit Smoke-Test inkl. Prozess-uid; dazu `ops:backup` →
`ops:restore-test` und `ops:alert-test` mit Empfang. Mit `--test-user nobody` laufen die Test-Apps unter einem
vorhandenen unprivilegierten Benutzer, ohne `quizmaster` anzulegen.

### Smoke-Test gegen eine laufende Instanz

Abnahme einer laufenden Instanz von außen mit echtem Chromium (der automatisierbare Teil der manuellen Abnahme): ein
vollständiger Durchlauf über Session, Ticket, Lobby und Spiel, den der Smoke-Test des Deploys nicht abdeckt. Eigene
Playwright-Konfiguration `e2e/playwright.smoke.config.ts` ohne `webServer` und mit eigenem `testDir` (`e2e/smoke/`) –
nie Teil von `pnpm test:e2e` oder der CI.

```bash
SMOKE_BASE_URL=https://quizmaster.dev-sven.de pnpm test:smoke                            # über Cloudflare (Kurzform)
SMOKE_BASE_URL=https://quizmaster.dev-sven.de pnpm --filter e2e test:smoke                 # über Cloudflare
SMOKE_BASE_URL=https://quizmaster.dev-sven.de SMOKE_RESOLVE_TO=127.0.0.1 \
  SMOKE_OUTPUT=reports/smoke-prod pnpm --filter e2e test:smoke                            # direkt am Origin (Caddy)
SMOKE_BASE_URL=http://127.0.0.1:3200 pnpm --filter e2e test:smoke                          # gegen pnpm stack:test
SMOKE_PLAY=0 SMOKE_BASE_URL=https://quizmaster.dev-sven.de pnpm --filter e2e test:smoke    # ohne Spiel
SMOKE_BASE_URL=https://quizmaster.dev-sven.de pnpm --filter e2e test:smoke \
  --grep "Startseite|Installierbarkeit"                                                   # legt nichts an
```

| Variable | Pflicht | Wirkung |
|---|---|---|
| `SMOKE_BASE_URL` | ja | Origin der Instanz (`http(s)://host[:port]`, ohne Pfad). Fehlt sie oder ist ein Wert ungültig, bricht der Lauf mit Meldung ab, bevor ein Browser startet (Playwright endet mit Code 2) |
| `SMOKE_RESOLVE_TO` | nein | IP, auf die Chromium den Host auflöst (`--host-resolver-rules`, gilt auch für WebSockets) – Test am Cloudflare-Proxy vorbei. Nur dann werden Zertifikatsfehler ignoriert (`ignoreHTTPSErrors` und `--ignore-certificate-errors`; ohne das Flag scheitert die Service-Worker-Registrierung am Origin-Zertifikat). Caddy lässt außer Cloudflare nur Loopback zu, auf dem Server also `127.0.0.1` |
| `SMOKE_OUTPUT` | nein | Ordner für Bericht und Artefakte, Standard `e2e/smoke-results`; relative Pfade gelten ab dem Aufrufverzeichnis (z. B. `reports/smoke-prod`). Nur ein neuer, leerer oder schon vom Smoke-Test markierter Ordner – Playwright leert darin `artifacts/` und `html/`. Eine `.gitignore` mit `*` im Ordner hält ihn aus Git heraus |
| `SMOKE_PLAY` | nein | `0` = ohne Spiel (Kaltstart, Beitritt, Lobby und Verlassen laufen trotzdem) |

Prüfungen (ein Worker, keine Wiederholung – jede Wiederholung legte weitere Gäste und Lobbys an):

1. **Kaltstart** (Pixel 7, frischer Kontext ohne Cache und ohne Service Worker, Slow 4G per CDP: 150 ms Latenz je
   Anfrage, 1,6 Mbit/s down, 750 kbit/s up, CPU 4×): „Öffnen → Lobby erstellt und sichtbar“ unter 10 s
   (Erfolgskriterium des Produkts) und LCP der Startseite unter 1,8 s (Performance-Ziel, hier als Einzelmessung im
   Labor). Gemessen im Browser ab Navigationsbeginn bis zum ersten Frame mit Lobby-Code, ohne die Tippzeit eines
   Menschen; Zwischenzeiten TTFB, FCP, „bedienbar“ (Namensfeld hydriert) und Klick → Lobby.
2. **Spiel zu zweit:** ein zweiter Kontext (iPhone 15, Chromium) tritt per `/j/<code>` bei, der Host stellt
   1 Runde × 1 Frage je Kategorie ein und startet. Wer dran ist, wählt die erste Kategorie; beide antworten immer mit
   der ersten Antwort (der echte Katalog ist unbekannt), bis bei beiden das Spielende steht. Danach geht es
   automatisch zurück in die Lobby (Karte „Letztes Spiel“), und beide verlassen sie.
3. **Browser:** über den ganzen Lauf 0 CSP-Verstöße (Event `securitypolicyviolation` und Konsole „Refused to …“),
   0 Konsolenfehler, 0 Seitenfehler.
4. **axe** (WCAG 2.2 AA + Best Practices, dazu die Layout-Regeln des Designsystems: kein horizontales Scrollen,
   höchstens eine Hauptaktion, keine Emojis, keine Klassen mit beliebigen Werten `[…]` oder Hex-Farben) auf Start,
   Beitreten, Lobby (Host und Gast), Spielende (Host und Gast), Lobby nach dem Spiel und der Startseite danach – ohne
   Befunde jeder Schwere.
5. **Installierbarkeit** auf `/`: `Page.getInstallabilityErrors` leer, Manifest ohne Meldungen von Chromium,
   Manifest und Icons erreichbar, Service Worker `activated` und steuert die Seite.
6. **Sicherheits-Header** der Startseite: CSP mit Nonce und `'strict-dynamic'`, ohne `'unsafe-inline'`/
   `'unsafe-eval'`, `default-src`, `object-src`, `base-uri`, `frame-ancestors`, bei https `upgrade-insecure-requests`;
   die Nonce steht an den Skripten der Seite und ist je Anfrage neu (gleiche Nonce zweimal = ein Cache liefert das
   HTML aus); HSTS (bei https), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control`
   mit `no-store` und `no-transform`, `X-Frame-Options`, COOP, CORP, kein `X-Powered-By`.

**Bericht:** `smoke-report.txt` (Kurzfassung, erscheint auch in der Konsole) und `smoke-report.json` (Zeiten,
Befunde je Prüfung, Konsolenprotokoll, Lobby-Codes) im Ausgabeordner; dazu `html/` (HTML-Bericht mit Traces und
Screenshots bei Fehlern, für den Standardordner: `pnpm --filter e2e exec playwright show-report smoke-results/html`)
und `artifacts/` (Screenshots je axe-Screen). Exit-Code 0 nur, wenn alle Prüfungen bestanden sind. Der Kaltstart läuft
als erster Test – nach einem Deploy trifft er also die noch kalte Instanz.

**Spuren in der Zielinstanz:** je Lauf zwei neue Gast-Sessions (zählen gegen das Limit von 30 neuen Sessions je IP in
10 min), eine Lobby und – mit Spiel – ein beendetes Spiel samt Statistik der gezeigten Fragen. Der Bericht nennt die
Lobby-Codes mit dem passenden Befehl der Admin-CLI; zuerst die Wirkung ansehen, dann bereinigen:

```bash
pnpm admin:game purge --code <CODE> --env prod --dry-run
pnpm admin:game purge --code <CODE> --env prod --confirm-prod
```

Gegen den lokalen Test-Stack entfällt das – seine Collections verschwinden beim Beenden.

**Turnstile:** Mit `TURNSTILE_ENABLED=true` verlangt jede neue Gast-Session eine Turnstile-Prüfung, die ein
automatisierter Browser in der Regel nicht besteht. Der Smoke-Test erkennt das (`TURNSTILE_REQUIRED` von
`POST /api/session` bzw. geladenes Widget) und bricht den Durchlauf mit dieser Begründung ab; Header, axe der
Startseite und Installierbarkeit laufen unabhängig davon. Den vollständigen Durchlauf deshalb vor dem Einschalten von
Turnstile fahren oder den Schalter kurz umlegen (siehe Schalter umlegen) und danach sofort zurückstellen.

### pm2

| Befehl | Zweck |
|---|---|
| `pm2 status` | Zustand von `quizmaster-web`, `quizmaster-realtime`, `quizmaster-watchdog` |
| `pm2 logs quizmaster-realtime --lines 200` | Logs (JSON von pino); Rotation über `pm2-logrotate` |
| `pm2 restart quizmaster-web` | Neustart mit unveränderter Env |
| `pnpm deploy:restart --apps …` | Neustart mit neu erzeugter Env (z. B. nach Secret-Rotation) |

Secrets stehen weder in `ecosystem.config.js` noch in `dump.pm2`: Node liest sie beim Start aus der Env-Datei.
Nie `pm2 restart … --update-env` verwenden – pm2 übernähme dann die Umgebung der aufrufenden Shell, und dort
gesetzte Variablen (z. B. `HOSTNAME`, `PORT`) hätten Vorrang vor der Env-Datei.

### Caddy und Cloudflare

```bash
pnpm caddy:dry-run     # Site aus .env.prod erzeugen, Zertifikat und Gesamtkonfiguration prüfen, Diff zeigen
pnpm caddy:install     # als root: Sicherung → Site-Datei → eine import-Zeile → caddy validate → systemctl reload caddy
```

Die Site (`infra/caddy/quizmaster.caddy.template`) nutzt das Cloudflare-Origin-Zertifikat, lässt nur
Cloudflare-Adressen und Loopback zu (alle anderen Verbindungen werden geschlossen), leitet `/socket.io/*` und
`/healthz` an Realtime (offene WebSockets überstehen einen Reload fünf Minuten), beantwortet `/metrics` mit 404
und komprimiert nichts. Neustartlücken (Deploy, `max_memory_restart`, Absturz) überbrückt Caddy bis 8 s
(`lb_try_duration`) – Anfragen warten, statt sofort mit 502 zu scheitern. Logs: keine Access-Logs; Fehler-
antworten (z. B. 502, wenn ein Upstream länger fehlt) laufen über `handle_errors`, damit Caddys Standard-
Fehlerlog – das den ganzen Request inkl. `Cf-Connecting-Ip` (echte Client-IP) ins Journal schreiben würde – nur
auf Debug-Ebene loggt (Grundsatz: keine IPs in Logs). Ausfälle meldet die Health-Kontrolle (Monitoring), nicht das
Caddy-Log. Die Cloudflare-Liste steht in `infra/caddy/cloudflare-ips.txt` und wird wöchentlich per Cron
aktualisiert (neu geladen wird nur bei Änderungen; die Datei dann committen). Ist sie zweimal in Folge nicht
abrufbar oder unplausibel, kommt ein Alarm – die gespeicherte Liste bleibt aktiv, neue Cloudflare-Bereiche würden
aber ausgesperrt.

Einstellungen in Cloudflare für die Domain:

- DNS-Eintrag **proxied** (orange Wolke); SSL/TLS-Modus **Full (strict)** mit einem Cloudflare-Origin-Zertifikat
  auf dem Server; „Always Use HTTPS“ an, Mindestversion TLS 1.2
- **WebSockets** an (Network)
- **Rocket Loader aus**, **Email Obfuscation aus**, **Web Analytics/RUM aus** – sie schleusen Skripte ein, die an
  der strikten CSP (Nonce, `strict-dynamic`) scheitern
- **Bot Fight Mode aus** – er blockiert WebSocket- und API-Aufrufe; Bot-Schutz übernehmen Turnstile, die
  Rate-Limits und bei Bedarf Cloudflare-Rate-Limiting-Regeln
- HTML nicht cachen (Seiten enthalten Nonces); `/api/*` und `/socket.io/*` werden nicht gecacht
- Möglicher Ausbau: Authenticated Origin Pulls (mTLS zwischen Cloudflare und Server) – wirkt erst, wenn die
  Caddy-Site zusätzlich das Cloudflare-Client-Zertifikat verlangt (`client_auth`)

### Schalter umlegen

Nicht geheime Schalter ändert `--set`, ohne die Env-Datei zu öffnen oder Werte anderer Schlüssel auszugeben:

```bash
pnpm setup:env prod --set TURNSTILE_ENABLED=true   # Turnstile beim Anlegen der Gast-Session verlangen
pnpm deploy:restart --apps web                     # Env neu aufteilen, nur web neu starten
```

| Schalter | Werte | Neu starten |
|---|---|---|
| `TURNSTILE_ENABLED` | `true` \| `false` | `web` (Site- und Secret-Key müssen eingetragen sein) |
| `SEARCH_INDEXING` | `true` \| `false` | `web` (`false` = `robots.txt` sperrt alles, Seiten mit `noindex`) |
| `LOG_LEVEL` | `fatal` … `trace`, `silent` | betroffene Apps |

### Secrets rotieren

```bash
pnpm setup:env prod --rotate <SCHLÜSSEL>     # erzeugt genau diesen Wert neu, gibt ihn nicht aus
pnpm deploy:restart --apps <apps>            # neue Env-Dateien erzeugen und die betroffenen Apps neu starten
```

| Secret | Neu starten | Hinweis |
|---|---|---|
| `SESSION_SECRET` | `web` | alle Gast-Sessions werden neu angelegt |
| `REALTIME_TICKET_SECRET` | `web,realtime` | beide gleichzeitig in einem Aufruf; offene Verbindungen verbinden sich neu |
| `IP_HASH_SECRET` | `web,realtime` | Rate-Limit-Zähler beginnen neu; bestehende IP-Sperren greifen nicht mehr (neu setzen) |
| `METRICS_TOKEN` | `realtime,watchdog` | externes Monitoring anpassen |
| `TURNSTILE_SECRET_KEY` | `web` | im Cloudflare-Dashboard erzeugen und in `.env.prod` eintragen |
| Passwort in `MONGODB_URI` | `web,realtime` | zuerst im Cluster ändern; Backups lesen die URI automatisch |
| `BACKUP_PASSPHRASE` | – | alte Passphrase aufheben, bis die alten Backups abgelaufen sind (14 Tage) |

### Backups, Restore-Test und Wiederherstellung

```bash
pnpm ops:backup          # mongodump → gzip → AES256 (gpg) ins Backup-Verzeichnis (--out-dir), dazu content/ und docs/
pnpm ops:check-backup    # neuestes Backup höchstens 26 h alt, Manifest vorhanden (Cron täglich 09:00)
pnpm ops:restore-test    # neuestes Backup (≤ 36 h) in die Test-Datenbank, Dokumente je Collection vergleichen
pnpm ops:restore         # Ernstfall: Plan für die Wiederherstellung der Produktionsdatenbank (ändert nichts)
pnpm ops:install-cron    # als root, siehe Monitoring
```

Die Zugangsdaten liest ein Helfer direkt aus der Env-Datei; sie erscheinen weder auf der Kommandozeile noch im
Log. Backups sind mit `BACKUP_PASSPHRASE` verschlüsselt (Passphrase zusätzlich getrennt vom Server aufbewahren –
ohne sie ist jedes Backup wertlos), werden 14 Tage aufbewahrt (die neuesten drei immer) und nach dem Schreiben
probeweise entschlüsselt. Fehler lösen einen Alarm aus; bleibt das nächtliche Backup ganz aus (Cron oder Skript
startet nicht), meldet es `ops:check-backup`.
Cron-Läufe (`QM_UNATTENDED=1`) führen Backup, Restore-Test und Caddy-Refresh nur mit committeten
Betriebswerkzeugen aus – ein halbfertiger Stand von `infra/`, `scripts/ops/` oder `packages/shared/` im
Arbeitsbaum bricht den Lauf mit Alarm ab, statt ungeprüften Code als root auszuführen. Protokolle:
`journalctl -t quizmaster-backup -t quizmaster-check-backup -t quizmaster-restore-test -t quizmaster-caddy`.

**Wiederherstellung im Ernstfall** (`infra/ops/restore.sh`): ohne `--confirm-prod` zeigt es nur den Plan.

```bash
pnpm ops:restore                                         # Plan: neuestes Archiv, Alter, Dokumente, Ziel
pnpm ops:restore --archive <backup-verzeichnis>/quizmaster-<ts>.archive.gz.gpg --confirm-prod
pnpm ops:restore --confirm-prod --passphrase-file <datei> # Passphrase aus einer Datei (600) statt BACKUP_PASSPHRASE
```

Ablauf: Archiv vollständig prüfen (Passphrase, Integrität) → Sicherheitskopie des jetzigen Stands → Deploy-Sperre →
Apps stoppen → `mongorestore --drop --nsInclude "<db>.*"` (URI über `--config`) → Dokumentzahl gegen das Manifest
→ Apps mit frischer Env und Smoke-Test starten. Scheitert das Einspielen, werden die Apps trotzdem wieder
gestartet und es kommt ein Alarm; die Sicherheitskopie lässt sich mit `--archive` erneut einspielen.

**Außerhalb des Servers:** `ops:backup` schreibt auf den Server selbst und schützt damit nicht vor dessen Verlust.
Empfohlen sind zusätzlich eine Kopie der bereits verschlüsselten `.gpg`-Dateien außerhalb des Servers (z. B.
restic/rclone zu Objektspeicher oder einem zweiten Host, ≥ 30 Tage aufbewahrt, Fehler → Alarm), Snapshots bzw.
Backups beim Datenbank-Anbieter, die Passphrase getrennt vom Server und ein Restore-Test auch gegen diese Kopie.

### Monitoring und Alarme

```bash
pnpm ops:alert-test      # Testalarm an ALERT_WEBHOOK_URL (Discord oder Slack) – vor der Inbetriebnahme prüfen
pnpm ops:healthcheck     # Health-Kontrolle einmal ausführen (sonst Cron jede Minute)
pnpm ops:install-cron    # als root: Health jede Minute, Backup 03:30, Kontrolle 09:00, Restore-Test quartalsweise,
                         # Cloudflare-Liste montags – verweigert ohne ALERT_WEBHOOK_URL (bewusst: --allow-no-webhook)
```

- **Health-Kontrolle** (`infra/ops/healthcheck.sh`, Cron jede Minute): `/api/health` und `/healthz` über
  Loopback; 429 gilt als „lebt“. Alarm, wenn ein Dienst länger als 2 Minuten gestört ist (inkl. `ok: false`),
  Entwarnung bei Erholung; während eines Deploys und ohne Release ruhig. Läuft per Cron unabhängig von pm2 – sie
  meldet nicht antwortende Apps auch dann, wenn pm2 selbst ausgefallen ist (ein Watchdog unter pm2 könnte das
  nicht). Protokoll: `journalctl -t quizmaster-healthcheck`.
- **Watchdog** (`quizmaster-watchdog`, `dist/watchdog.mjs`, pm2): prüft alle 30 s `/api/health`, `/healthz` und
  `/metrics` (Bearer `METRICS_TOKEN`) über Loopback und alarmiert nach den Regeln unten. Höchstens ein Alarm je
  Regel in 15 min, Erinnerung stündlich, solange die Störung anhält, Entwarnung bei Erholung. Jeder Alarm nennt
  Befund und ersten Handgriff. Nutzlast wie `ops:alert-test` (`{content, text}`, `@everyone` entschärft); ohne
  `ALERT_WEBHOOK_URL` nur im Log (`pm2 logs quizmaster-watchdog`, Feld `rule`). Die Cron-Health-Kontrolle bleibt
  als von pm2 unabhängige Prüfung.
- **Wiederaufnahme nach Neustart:** Realtime übernimmt beim Start alle aktiven Lobby-Snapshots – laufende Fragen bzw.
  Kategoriewahlen beginnen neu (5 s Aufschub zum Wiederverbinden), Punkte bleiben; nicht wiederherstellbare Snapshots
  werden geschlossen. Metrik `qm_lobbies_resumed_total{outcome}`.
- **Extern:** Ein Ausfall des ganzen Servers oder des Cron-Dienstes fällt keiner lokalen Kontrolle auf – dafür
  zusätzlich einen Uptime-Check von außen auf `https://<domain>/api/health` einrichten (z. B. Uptime Kuma auf einem
  anderen Host).
- `/metrics` (Prometheus-Format) ist nur lokal mit `METRICS_TOKEN` erreichbar.

| Watchdog-Regel | Alarm, wenn … |
|---|---|
| `web_health`, `realtime_health` | `/api/health` bzw. `/healthz` länger als 2 min gestört ist (`ok: false`, 5xx, keine Antwort; 429 gilt als „lebt“) |
| `event_loop` | der Event-Loop-p99 von Realtime 5 min lang über 200 ms liegt |
| `error_rate` | mehr als 1 % der Client-Events in 5 min mit `INTERNAL` enden (ab 200 Events) |
| `limit_spike` | in 5 min ≥ 200 Rate-Limit-Treffer anfallen (Angriff?) |
| `change_stream` | Change Streams in 15 min ≥ 3-mal neu starten – und das länger als 16 min anhält |
| `mongo` | in 5 min ≥ 3 Verbindungsfehler (`heartbeat`, `pool_cleared`) oder ≥ 10 sonstige Mongo-Fehler auftreten – und das länger als 6 min anhält |
| `restart_loop` | Realtime in 15 min ≥ 3-mal neu startet |
| `auto_retire` | die Schutzautomatik in 15 min ≥ 5 Fragen zurückzieht oder einen fälligen Rückzug wegen ihres Tagesbudgets zurückhält |
| `origin_retention` | die 30-Tage-Löschung der IP-Schlüssel an Meldungen und Bewertungen seit über 3 h nicht erfolgreich lief (ohne Erfolg: seit dem Start von Realtime) – Logs und die Teilindizes `createdAt_origin`/`updatedAt_origin` prüfen |
| `metrics` | `/metrics` 5 min lang nicht lesbar ist, obwohl `/healthz` antwortet (z. B. falscher `METRICS_TOKEN`) |

`change_stream` und `mongo` melden nur eine Störung, die länger als ihr Zählfenster anhält: Der Fehlerschub eines
kurzen Netzaussetzers (5–60 s) bleibt nur ein Fenster lang im Zähler und ist kein Alarm; eine anhaltende Störung meldet
weiter.

### Performance und Last

```bash
pnpm perf:budgets [--dist apps/web/.next] [--url http://127.0.0.1:3000]   # initiales JS je Route (CI-Gate)
pnpm perf:lighthouse [--runs 3]                                            # lokaler Prod-Build + Test-Stack
pnpm perf:lighthouse --url https://<domain> --resolve <domain>=127.0.0.1 --insecure   # Produktion über den Origin
pnpm loadtest --lobbies 375 --players 8 --duration 4m --ramp 90s --catalog content     # 3.000 Sockets, Bericht --report
```

Budgets für das initiale JS (gzip): Startseite ≤ 165 KB, Lobby ≤ 180 KB (Werte in `scripts/perf/lib/bundle.ts`).
Ergebnisse landen in `reports/` (lokal, gitignored); der Lasttest läuft nur gegen die Test-Datenbank.

### Admin-Werkzeuge (Kill-Switches, Sperren)

Realtime übernimmt Änderungen per Change Stream sofort, ein Neustart ist nicht nötig. Verbindung aus `.env.prod`
(`--env dev` für die Entwicklung); Schreiben in die Produktionsdatenbank nur mit `--confirm-prod`. Die Prüf-Queue
(`admin:reports`) verhält sich anders, siehe „Schutzautomatik und Prüf-Queue“.

```bash
pnpm admin:config show
pnpm admin:config set lobbyCreationEnabled=false --confirm-prod             # Lobby-Erstellung pausieren
pnpm admin:config set turnstileOnJoin=true maxActiveLobbies=500 --confirm-prod
pnpm admin:config set maintenance=on "maintenanceMessage=Kurze Wartung" --confirm-prod   # …=off beendet sie
pnpm admin:config set minClientProtocol=<n> --confirm-prod                   # <n> = neue PROTOCOL_VERSION, erst wenn live
pnpm admin:config block-term add <begriff …> --confirm-prod                  # Blockliste (Namen), remove entfernt
pnpm admin:ban add --ip 203.0.113.7 --reason "Bot-Welle" --hours 24 --confirm-prod   # IPv6: ganzes /64
pnpm admin:ban add --guest <guestId> --reason "Beleidigende Namen" --confirm-prod     # ohne --hours: dauerhaft
pnpm admin:ban check --ip 203.0.113.7
pnpm admin:ban remove --ip 203.0.113.7 --confirm-prod
pnpm admin:ban add --lobby <CODE> --name "<Name>" --reason "…" --confirm-prod     # Gast über Lobby + Namen finden
pnpm admin:ban add --report <meldungs-id> --reason "…" --confirm-prod             # Gast hinter einer Meldung
pnpm admin:ban list                                                               # aktive Sperren (guestIds gekürzt)
pnpm admin:config maintenance on "Kurze Wartung, gleich zurück" --confirm-prod   # Banner überall; off beendet ihn
pnpm admin:config block-term list
pnpm admin:game purge --code <CODE> --dry-run                                     # Test-/Abnahmespiel: Wirkung zeigen
pnpm admin:game purge --code <CODE> --confirm-prod                                # … entfernen, Statistik zurückrechnen
```

`admin:game purge` löscht beendete Spiele mit diesem Lobby-Code samt Lobby-Snapshot, rechnet die Fragen-Statistik
(nur Menschen, nie unter 0) sowie Bewertungen/Meldungen und Gast-Statistiken der Beteiligten zurück – Gäste nur, wenn
sie an keinem anderen Spiel beteiligt waren; laufende Lobbys bleiben unberührt (nach dem Schließen erneut ausführen).

IP-Sperren speichern wie Web und Realtime nur den HMAC-Schlüssel der Adresse (`IP_HASH_SECRET`), nie die IP.

### Schutzautomatik und Prüf-Queue

Spielende können Fragen bewerten (Daumen hoch/runter) und melden (Falsch, Mehrdeutig, Veraltet, Tippfehler,
Unpassend). Nach jeder Meldung und Bewertung prüft Realtime, ob die Frage sofort aus dem Pool muss (Status `retired`,
vermerkt als automatisch zurückgezogen):

- Meldungen „Falsch“, „Veraltet“ oder „Mehrdeutig“ aus mindestens 3 unabhängigen Quellen in 7 Tagen oder
- mindestens 20 Bewertungen mit weniger als 30 % Daumen hoch, wobei die Daumen-runter aus mindestens 3 unabhängigen
  Quellen stammen.

**Unabhängige Quellen:** Gast-Sessions kosten nichts. Gäste, die über dieselbe IP (nur als HMAC-Schlüssel, IPv6 als
/64) oder dieselbe Lobby verbunden sind – auch über Zwischenschritte –, zählen deshalb zusammen als eine Quelle. Eine
Person mit mehreren Sessions oder eine Gruppe in einer Lobby zieht so keine Frage allein zurück; ihre Meldungen stehen
trotzdem in der Prüf-Queue. Gezählt wird ab der letzten Inhalts- oder Statusänderung der Frage, Rückmeldungen zu einer
schon geprüften Fassung zählen nicht erneut.

**Tagesbudget:** höchstens 5 automatische Rückzüge je Kategorie und 20 insgesamt in 24 h. Darüber bleibt eine fällige
Frage im Pool, der Vorgang wird gezählt (`qm_questions_auto_retire_suppressed_total`) und der Watchdog alarmiert
(`auto_retire`). Kategorien, die durch Rückzüge unter die Mindestmenge spielbarer Fragen fallen, werden nicht mehr
angeboten.

Die **Prüf-Queue** zeigt offene Meldungen je Frage (Gründe, Anzahl, Zeitraum, unabhängige Quellen), automatisch
zurückgezogene Fragen, schlecht bewertete Fragen (unter 50 % ab 10 Bewertungen) und Fragen mit einer Trefferquote
unter 10 % (ab 30 Anzeigen) – ohne guestIds und Lobby-Codes. Anders als die übrigen Admin-Werkzeuge verbindet
`admin:reports` standardmäßig mit `.env.dev`; mit `--env prod` braucht jeder Aufruf `--confirm-prod`, auch zum Lesen
und mit `--dry-run`.

```bash
pnpm admin:reports --env prod --confirm-prod                       # Prüf-Queue lesen (--json mit Meldungs-IDs)
pnpm admin:reports --resolve <id> --env prod --confirm-prod         # Meldungen erledigt (Frage im Katalog korrigiert)
pnpm admin:reports --dismiss <id> --env prod --confirm-prod         # Meldungen verworfen (Frage ist korrekt)
pnpm admin:reports --restore <frage-id> --env prod --confirm-prod   # zurückgezogene Frage nach Prüfung zurück in den Pool
pnpm admin:reports --restore-auto --since <iso> --dry-run --env prod --confirm-prod   # Massen-Wiederherstellung: Vorschau
pnpm admin:reports --restore-auto --since <iso> --env prod --confirm-prod             # … ausführen (--reason reports|rating)
pnpm admin:reports --recount <kategorie> --env prod --confirm-prod  # Live-Zähler einer Kategorie neu berechnen (nach einem Abbruch)
```

`<id>` ist eine Fragen-ID (alle offenen Meldungen der Frage) oder eine Meldungs-ID. `--restore` und `--restore-auto`
übernehmen den Status aus dem Katalog (`content/`, sonst `--content-dir`) – nur für Fragen, die dort unverändert und
spielbar sind – und berechnen danach die Live-Zähler der Kategorien neu. Offene Meldungen bleiben in der Queue,
zählen nach der Wiederherstellung aber nicht mehr für die Schutzautomatik.

### Runbooks

| Lage | Vorgehen |
|---|---|
| Deploy fehlerhaft | `pnpm deploy:rollback`, danach Ursache in `pm2 logs` suchen |
| Deploy-Sitzung abgebrochen | `pnpm deploy:status` – bei „unvollständige Aktivierung“: `pnpm deploy:prod --sha <sha>` erneut oder `pnpm deploy:rollback` |
| Alarm „gestört seit … min“ | `pm2 status`, `pm2 logs <app> --lines 100`, `pnpm deploy:status`; Status `errored` → `pnpm deploy:restart --apps <app>`, sonst `pnpm deploy:rollback` |
| Realtime hängt, hohe CPU | Metriken prüfen → `pnpm admin:config set maxActiveLobbies=<n> lobbyCreationEnabled=false --confirm-prod` → `pm2 restart quizmaster-realtime` (Clients verbinden neu) → Ursache im Profil suchen |
| MongoDB nicht erreichbar | laufende Spiele laufen im Speicher weiter, neue Sessions/Lobbys schlagen fehl → Wartungsbanner, sobald die DB wieder schreibbar ist (`pnpm admin:config set maintenance=on …`), Cluster-Status prüfen |
| Datenverlust/Fehlbedienung in der DB | `pnpm ops:restore` (Plan) → `pnpm ops:restore --archive <datei> --confirm-prod` |
| Bot-Welle erstellt Lobbys | `pnpm admin:config set lobbyCreationEnabled=false --confirm-prod` oder `turnstileOnJoin=true`; einzelne Quellen `pnpm admin:ban add --ip …`; Cloudflare-Rate-Limit-Regel verschärfen |
| DDoS | Cloudflare „Under Attack Mode“, `pnpm admin:config set maxActiveLobbies=<n> --confirm-prod`, Caddy-Allowlist prüfen (`pnpm caddy:dry-run`) |
| Beleidigende Namen | `pnpm admin:config block-term add <begriff> --confirm-prod` (wirkt beim nächsten Beitritt), betroffene Gäste `pnpm admin:ban add --guest <guestId> …` |
| Falsche Frage verbreitet sich | Frage im Katalog auf `retired` setzen oder korrigieren → Seed → Change Stream nimmt sie sofort aus dem Pool |
| Schutzautomatik/Prüf-Queue: Alarm „Schutzautomatik zieht ungewöhnlich viele Fragen zurück“ oder offene Meldungen | `pnpm admin:reports --env prod --confirm-prod` (Gründe, Quellen, Zeitraum). Missbrauch → Gäste hinter den Meldungen sperren (`pnpm admin:ban add --report <meldungs-id> …`, IDs aus `--json`), ggf. `pnpm admin:config set turnstileOnJoin=true --confirm-prod`; zu Unrecht zurückgezogene Fragen erst ansehen (`pnpm admin:reports --restore-auto --since <iso> --dry-run --env prod --confirm-prod`), dann ohne `--dry-run` zurückholen. Einzelne Frage: berechtigte Meldungen → Frage im Katalog korrigieren → Seed → `--resolve <id>`; unberechtigte → `--dismiss <id>` und eine zurückgezogene Frage per `--restore <frage-id>` zurück in den Pool (jeweils `--env prod --confirm-prod`) |
| Antwort-Leak entdeckt | Hotfix + Release, `pnpm admin:config set minClientProtocol=<n> --confirm-prod`, Test ergänzen |
| Secret kompromittiert | rotieren (siehe oben), betroffene Apps neu starten, Vorfall dokumentieren |
| Alarm „Backup fehlgeschlagen“ / „Backup-Kontrolle“ | `journalctl -t quizmaster-backup -t quizmaster-check-backup`, Ursache beheben (z. B. nicht committete Betriebswerkzeuge), `pnpm ops:backup` erneut |
| Alarm „Cloudflare-IP-Liste … nicht abrufbar“ | `journalctl -t quizmaster-caddy`, `pnpm caddy:dry-run`; bei geänderter Liste `pnpm caddy:install` und Datei committen |
| Deploy bricht mit `SERVICE_USER` oder `SERVICE_ACCESS` ab | nichts wurde umgeschaltet; die Meldung nennt Eintrag bzw. Pfad mit Rechten → `pnpm ops:create-user --dry-run` bzw. Rechte korrigieren, erneut deployen (siehe Systembenutzer) |
| Smoke-Test meldet `APP_IDENTITY` | App lief nicht mit uid/gid `quizmaster` → der Deploy ist schon zurückgegangen; `pnpm deploy:status` (Benutzer je App) und `getent passwd quizmaster` prüfen |

## Sicherheitslücken melden

Bitte Sicherheitslücken nicht öffentlich melden – also nicht als Issue, Pull Request oder Diskussion –, sondern
vertraulich über GitHubs *Private vulnerability reporting*: im Repository unter **Security → Report a
vulnerability**. Die Meldung sehen nur die meldende Person und die Maintainer; Rückfragen, Behebung und eine spätere
Veröffentlichung als Security Advisory laufen über denselben Vorgang.

Hilfreich sind die betroffene Komponente bzw. der Commit, Schritte zum Nachstellen (am besten gegen einen lokalen
Test-Stack, `pnpm stack:test`), erwartetes und tatsächliches Verhalten sowie die Auswirkung. Bitte nichts gegen die
öffentliche Instanz ausprobieren, das andere Spielende stört, Last erzeugt oder Daten Dritter berührt.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
