# quizmaster

Live-Quiz-Duelle für 2–8 Personen im Browser – als installierbare PWA, ohne Konto. Eine Person erstellt eine
Lobby, die anderen treten per Code oder Link bei. Gespielt wird nach Quizduell-Regeln: pro Runde wählt jede
Person einmal aus drei Kategorien, je Frage 20 Sekunden und vier Antworten, ein Punkt pro richtiger Antwort.
Der Server ist autoritativ – Antworten, Zeiten und Punkte werden nur dort ausgewertet.

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

Auf dem Produktionsserver bleibt das System-Node unangetastet: Node 24, pnpm, Caches und Browser liegen isoliert
in `.tooling/` (nicht im Repo) und werden pro Shell mit `source .tooling/activate.sh` aktiviert.

## Einrichten

```bash
corepack enable pnpm                 # Server: source .tooling/activate.sh
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
| `pnpm test:e2e` | Playwright gegen einen Test-Stack (Web + Realtime + Test-Datenbank) |
| `pnpm build` | Produktions-Build (Next standalone inkl. Service Worker, Realtime-Bundle) |

Automatische Tests laufen nie gegen Dev- oder Produktionsdaten: lokal in `quizmaster_test` mit eigenem
Collection-Präfix je Lauf, in der CI gegen `MongoMemoryReplSet` 8.0.32.

**CI** (GitHub Actions, `.github/workflows/ci.yml`): Lint (Biome, shellcheck für `infra/`), Typecheck, Tests,
Content-Validierung, Build, E2E, `pnpm audit --prod` (hohe/kritische Befunde brechen ab) und Trivy: ein
Secret-Scan über das Repo und ein Schwachstellen-Scan des Projekt-Lockfiles. pnpm ≥ 11 schreibt `pnpm-lock.yaml`
als zwei YAML-Dokumente (zuerst nur pnpm selbst, dann das Projekt) und Trivy liest nur das erste – die CI
extrahiert deshalb das Projekt-Dokument und scannt es separat. Actions sind per Commit-SHA gepinnt, Dependabot
schlägt Updates wöchentlich mit Wartezeit vor. Die CI deployt nicht. Nach dem ersten Push unter *Insights →
Dependency graph* prüfen, dass dort die Projektpakete (z. B. `next`, `socket.io`) erscheinen und nicht nur pnpm.

## Fragenkatalog

Der Katalog (über 22.000 Fragen in 19 Kategorien) ist nicht Teil dieses Repos: er liegt als eigenes, lokales
Git-Repo in `content/`. Für CI und E2E enthält das Repo synthetische Fixtures in `test/fixtures/content/`.

| Befehl | Zweck |
|---|---|
| `pnpm content:validate` | Schema und Regeln aller Fragen (`content/`, falls vorhanden, und die Fixtures) |
| `pnpm content:dedupe` / `content:stats` | Dubletten suchen, Abdeckung auswerten |
| `pnpm content:seed --env dev` | Katalog idempotent in die Datenbank übernehmen |
| `pnpm content:seed --env prod --confirm-prod` | dasselbe für Produktion (bricht bei auffällig vielen Rückzügen ab) |

Änderungen am Katalog werden per Change Stream sofort live – ein Neustart ist nicht nötig.

## Betrieb

### Konfiguration

```bash
pnpm setup:env prod --domain quiz.example.com --port 7400 --tls-cert <origin-cert.pem> --tls-key <origin-key.pem>
pnpm env:check prod --connect
```

Domain und Port stehen ausschließlich in `.env.prod`. Web lauscht auf `127.0.0.1:<Port>`, Realtime auf
`127.0.0.1:<Port + 1>` (oder `REALTIME_PORT`). `TRUSTED_IP_HEADER=cf-connecting-ip` ist nur gesetzt, weil die
Site ausschließlich über Cloudflare erreichbar ist (siehe Caddy).

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

`deploy:prod` prüft zuerst Werkzeuge, Arbeitsbaum, `.env.prod` (inkl. Datenbankverbindung), Ports und Platz.
Dann baut es aus `git archive` in `.deploy/build/<sha>` (Installation offline mit gefrorenem Lockfile), führt
das Audit-Gate aus (`pnpm audit --prod --audit-level high`; `--skip-audit` nur im Notfall) und legt das Release
unter `.deploy/releases/<sha>` ab. Aus `.env.prod` entsteht je App eine Env-Datei mit nur ihren Schlüsseln
(`.deploy/env/*.env`, 600). Danach wird `.deploy/current` atomar umgehängt und in der Reihenfolge
Web → Smoke-Test → Realtime → Smoke-Test → Watchdog gestartet. Der Smoke-Test prüft `/api/health`, die
Startseite (HTML mit CSP-Nonce, die ihre Skripte tragen) und ein darin referenziertes `/_next/static`-Asset,
`/healthz`, dass ein Socket.IO-Handshake ohne Ticket mit `UNAUTHORIZED` abgelehnt wird, dass `/metrics` ohne
Token gesperrt ist und dass die Prozesse nur auf Loopback lauschen. Schlägt etwas fehl, geht der Deploy
automatisch auf das vorherige Release zurück und endet mit Fehler. Bei Erfolg wird `dump.pm2` gesichert (die
letzten 20 Sicherungen unter `/root/backups/quizmaster/<zeit>/dump.pm2`), `pm2 save` ausgeführt, danach über
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
auf Debug-Ebene loggt (docs/06: keine IPs in Logs). Ausfälle meldet die Health-Kontrolle (Monitoring), nicht das
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
pnpm ops:backup          # mongodump → gzip → AES256 (gpg) nach /var/backups/quizmaster, dazu content/ und docs/
pnpm ops:check-backup    # neuestes Backup höchstens 26 h alt, Manifest vorhanden (Cron täglich 09:00)
pnpm ops:restore-test    # neuestes Backup (≤ 36 h) in die Test-Datenbank, Dokumente je Collection vergleichen
pnpm ops:restore         # Ernstfall: Plan für die Wiederherstellung der Produktionsdatenbank (ändert nichts)
pnpm ops:install-cron    # als root, siehe Monitoring
```

Die Zugangsdaten liest ein Helfer direkt aus der Env-Datei; sie erscheinen weder auf der Kommandozeile noch im
Log. Backups sind mit `BACKUP_PASSPHRASE` verschlüsselt (Passphrase zusätzlich im Passwortmanager sichern), werden
14 Tage aufbewahrt (die neuesten drei immer) und nach dem Schreiben probeweise entschlüsselt. Fehler lösen einen
Alarm aus; bleibt das nächtliche Backup ganz aus (Cron oder Skript startet nicht), meldet es `ops:check-backup`.
Cron-Läufe (`QM_UNATTENDED=1`) führen Backup, Restore-Test und Caddy-Refresh nur mit committeten
Betriebswerkzeugen aus – ein halbfertiger Stand von `infra/`, `scripts/ops/` oder `packages/shared/` im
Arbeitsbaum bricht den Lauf mit Alarm ab, statt ungeprüften Code als root auszuführen. Protokolle:
`journalctl -t quizmaster-backup -t quizmaster-check-backup -t quizmaster-restore-test -t quizmaster-caddy`.

**Wiederherstellung im Ernstfall** (`infra/ops/restore.sh`): ohne `--confirm-prod` zeigt es nur den Plan.

```bash
pnpm ops:restore                                         # Plan: neuestes Archiv, Alter, Dokumente, Ziel
pnpm ops:restore --archive /var/backups/quizmaster/quizmaster-<ts>.archive.gz.gpg --confirm-prod
pnpm ops:restore --confirm-prod --passphrase-file <datei> # Passphrase aus dem Passwortmanager (Datei 600)
```

Ablauf: Archiv vollständig prüfen (Passphrase, Integrität) → Sicherheitskopie des jetzigen Stands → Deploy-Sperre →
Apps stoppen → `mongorestore --drop --nsInclude "<db>.*"` (URI über `--config`) → Dokumentzahl gegen das Manifest
→ Apps mit frischer Env und Smoke-Test starten. Scheitert das Einspielen, werden die Apps trotzdem wieder
gestartet und es kommt ein Alarm; die Sicherheitskopie lässt sich mit `--archive` erneut einspielen.

**Offen (Go-live-Blocker):** Alle Backups liegen auf demselben Server und Datenträger wie die Datenbank-
Zugangsdaten, `content/` (einzige Quelle der Fragen, kein Remote) und `docs/`. Vor dem Go-live: Offsite-Kopie der
bereits verschlüsselten `.gpg`-Dateien (z. B. restic/rclone zu Objektspeicher oder einem zweiten Host, ≥ 30 Tage,
Fehler → Alarm), privates Git-Remote für `content/` und `docs/`, Snapshots beim Provider bzw. Cluster-Backups
aktivieren, Passphrase nachweislich außerhalb des Servers ablegen und einen Restore-Test gegen die Offsite-Kopie
fahren. Das braucht Zugangsdaten und eine Anbieter-Entscheidung des Betreibers.

### Monitoring und Alarme

```bash
pnpm ops:alert-test      # Testalarm an ALERT_WEBHOOK_URL (Discord oder Slack) – Go-live-Gate
pnpm ops:healthcheck     # Health-Kontrolle einmal ausführen (sonst Cron jede Minute)
pnpm ops:install-cron    # als root: Health jede Minute, Backup 03:30, Kontrolle 09:00, Restore-Test quartalsweise,
                         # Cloudflare-Liste montags – verweigert ohne ALERT_WEBHOOK_URL (bewusst: --allow-no-webhook)
```

- **Health-Kontrolle** (`infra/ops/healthcheck.sh`, Cron jede Minute): `/api/health` und `/healthz` über
  Loopback; 429 gilt als „lebt“. Alarm, wenn ein Dienst länger als 2 Minuten gestört ist (inkl. `ok: false`),
  Entwarnung bei Erholung; während eines Deploys und ohne Release ruhig. Läuft per Cron unabhängig von pm2 – sie
  meldet nicht antwortende Apps auch dann, wenn pm2 selbst ausgefallen ist (ein Watchdog unter pm2 könnte das
  nicht). Protokoll: `journalctl -t quizmaster-healthcheck`.
- **Watchdog** (`quizmaster-watchdog`, `dist/watchdog.mjs`): **noch nicht geliefert.** Der Deploy warnt bei jedem
  Release ohne Watchdog. Bis dahin gibt es keine Alarme aus `/metrics` (Event-Loop-p99, Fehlerrate,
  Limit-Spitzen, Change-Stream-Abbrüche, Mongo-Fehler, docs/12) und keine Erkennung von Neustart-Schleifen.
- **Extern:** Ein Ausfall des ganzen Servers oder des Cron-Dienstes fällt keiner lokalen Kontrolle auf – zusätzlich
  einen Uptime-Check von außen auf `https://<domain>/api/health` einrichten (docs/12: z. B. Uptime Kuma auf einem
  anderen Host).
- `/metrics` (Prometheus-Format) ist nur lokal mit `METRICS_TOKEN` erreichbar.

### Admin-Werkzeuge (Kill-Switches, Sperren)

Realtime übernimmt Änderungen per Change Stream sofort, ein Neustart ist nicht nötig. Verbindung aus `.env.prod`
(`--env dev` für die Entwicklung); Schreiben in die Produktionsdatenbank nur mit `--confirm-prod`.

```bash
pnpm admin:config show
pnpm admin:config set lobbyCreationEnabled=false --confirm-prod             # Lobby-Erstellung pausieren
pnpm admin:config set turnstileOnJoin=true maxActiveLobbies=500 --confirm-prod
pnpm admin:config set maintenance=on "maintenanceMessage=Kurze Wartung" --confirm-prod   # …=off beendet sie
pnpm admin:config set minClientProtocol=2 --confirm-prod                     # erst, wenn das neue Web live ist
pnpm admin:config block-term add <begriff …> --confirm-prod                  # Blockliste (Namen), remove entfernt
pnpm admin:ban add --ip 203.0.113.7 --reason "Bot-Welle" --hours 24 --confirm-prod   # IPv6: ganzes /64
pnpm admin:ban add --guest <guestId> --reason "Beleidigende Namen" --confirm-prod     # ohne --hours: dauerhaft
pnpm admin:ban check --ip 203.0.113.7
pnpm admin:ban remove --ip 203.0.113.7 --confirm-prod
```

IP-Sperren speichern wie Web und Realtime nur den HMAC-Schlüssel der Adresse (`IP_HASH_SECRET`), nie die IP.

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
| Antwort-Leak entdeckt | Hotfix + Release, `pnpm admin:config set minClientProtocol=<n> --confirm-prod`, Test ergänzen |
| Secret kompromittiert | rotieren (siehe oben), betroffene Apps neu starten, Vorfall dokumentieren |
| Alarm „Backup fehlgeschlagen“ / „Backup-Kontrolle“ | `journalctl -t quizmaster-backup -t quizmaster-check-backup`, Ursache beheben (z. B. nicht committete Betriebswerkzeuge), `pnpm ops:backup` erneut |
| Alarm „Cloudflare-IP-Liste … nicht abrufbar“ | `journalctl -t quizmaster-caddy`, `pnpm caddy:dry-run`; bei geänderter Liste `pnpm caddy:install` und Datei committen |

### Vor dem Go-live offen

- **Drill** mit eigenem pm2-Daemon (`PM2_HOME=…/.tooling/pm2-test`, nie `~/.pm2`) und `--test-env` (Test-Ports,
  `*_test`-Datenbank): Erst-Deploy, `--simulate-failure web|realtime|watchdog` (auch beim Erst-Deploy),
  `deploy:rollback`, `kill -9` auf Realtime, `pm2 kill` + `pm2 resurrect` im Test-Daemon; danach
  `ops:backup` → `ops:restore-test` (Entschlüsselung mit der Passphrase aus dem Passwortmanager) und
  `ops:alert-test` mit Empfang – Ergebnisse in `docs/13` protokollieren. Automatisiert getestet sind bisher
  Aktivierung/Rückweg mit simuliertem pm2 und die Betriebsskripte mit Stubs (`scripts/deploy`, `scripts/ops`).
- **Offsite-Backups** (siehe oben).
- **Externer Uptime-Check** und der **Watchdog** (siehe Monitoring).
- **Apps laufen als root:** pm2-Daemon und alle Apps des Servers laufen als root (Bestand). Eine Lücke in
  Next.js/Socket.IO wäre damit Root auf einem Host mit weiteren Apps (deren Env-Dateien, Origin-Schlüssel,
  Caddy/Cron). docs/12 sah einen Nicht-Root-Benutzer vor. Umstellung: Systembenutzer `quizmaster` (nologin),
  in `ecosystem.config.js` `uid`/`gid` je App, `.deploy` 711, `.deploy/env` 700 mit Besitzer `quizmaster`
  (Env-Dateien per `chown`), `.next/cache` des Web-Releases beschreibbar – danach Drill wiederholen. Bis dahin
  bewusst akzeptiertes Restrisiko; Entscheidung und Umsetzung durch den Betreiber.

## Sicherheit

Sicherheitslücken bitte nicht öffentlich melden, sondern über „Report a vulnerability“ (GitHub Security
Advisories) dieses Repositorys.

## Lizenz

MIT
