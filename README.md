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

**CI** (GitHub Actions, `.github/workflows/ci.yml`): Lint, Typecheck, Tests, Content-Validierung, Build, E2E,
`pnpm audit --prod` (hohe/kritische Befunde brechen ab) und ein Trivy-Scan. Actions sind per Commit-SHA gepinnt,
Dependabot schlägt Updates wöchentlich mit Wartezeit vor. Die CI deployt nicht.

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
pnpm deploy:prod                 # baut HEAD (Arbeitsbaum muss sauber sein) und aktiviert ihn
pnpm deploy:prod --sha <rev>     # bestimmten Commit deployen
pnpm deploy:prod --dry-run       # nur Preflight + Audit, ändert nichts
pnpm deploy:rollback             # zurück auf das vorherige Release (erneut: noch eins zurück)
pnpm deploy:status               # aktives/vorheriges Release, pm2-Zustand, letzte Aktionen
pnpm deploy:restart --apps web,realtime   # Env aus .env.prod neu erzeugen und Apps neu starten
```

`deploy:prod` prüft zuerst Werkzeuge, Arbeitsbaum, `.env.prod` (inkl. Datenbankverbindung), Ports und Platz.
Dann baut es aus `git archive` in `.deploy/build/<sha>` (Installation offline mit gefrorenem Lockfile), führt
das Audit-Gate aus (`pnpm audit --prod --audit-level high`; `--skip-audit` nur im Notfall) und legt das Release
unter `.deploy/releases/<sha>` ab. Aus `.env.prod` entsteht je App eine Env-Datei mit nur ihren Schlüsseln
(`.deploy/env/*.env`, 600). Danach wird `.deploy/current` atomar umgehängt und in der Reihenfolge
Web → Smoke-Test → Realtime → Smoke-Test → Watchdog gestartet. Der Smoke-Test prüft `/api/health`, `/healthz`,
dass ein Socket.IO-Handshake ohne Ticket mit `UNAUTHORIZED` abgelehnt wird, dass `/metrics` ohne Token
gesperrt ist und dass die Prozesse nur auf Loopback lauschen. Schlägt etwas fehl, geht der Deploy automatisch
auf das vorherige Release zurück und endet mit Fehler. Bei Erfolg wird `dump.pm2` gesichert, `pm2 save`
ausgeführt und es bleiben die letzten drei Releases.

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
`/healthz` an Realtime (offene WebSockets überstehen einen Reload fünf Minuten), beantwortet `/metrics` mit 404,
schreibt keine Access-Logs und komprimiert nichts. Die Cloudflare-Liste steht in `infra/caddy/cloudflare-ips.txt`
und wird wöchentlich per Cron aktualisiert (neu geladen wird nur bei Änderungen; die Datei dann committen).

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
| `IP_HASH_SECRET` | `web,realtime` | Rate-Limit-Zähler beginnen neu |
| `METRICS_TOKEN` | `realtime,watchdog` | externes Monitoring anpassen |
| `TURNSTILE_SECRET_KEY` | `web` | im Cloudflare-Dashboard erzeugen und in `.env.prod` eintragen |
| Passwort in `MONGODB_URI` | `web,realtime` | zuerst im Cluster ändern; Backups lesen die URI automatisch |
| `BACKUP_PASSPHRASE` | – | alte Passphrase aufheben, bis die alten Backups abgelaufen sind (14 Tage) |

### Backups und Restore-Test

```bash
pnpm ops:backup          # mongodump → gzip → AES256 (gpg) nach /var/backups/quizmaster, dazu content/ und docs/
pnpm ops:restore-test    # neuestes Backup in die Test-Datenbank, Dokumente je Collection vergleichen, wieder löschen
pnpm ops:alert-test      # Testalarm an ALERT_WEBHOOK_URL (Discord oder Slack)
pnpm ops:install-cron    # als root: Backup täglich 03:30, Restore-Test quartalsweise, Cloudflare-Liste wöchentlich
```

Die Zugangsdaten liest ein Helfer direkt aus der Env-Datei; sie erscheinen weder auf der Kommandozeile noch im
Log. Backups sind mit `BACKUP_PASSPHRASE` verschlüsselt (Passphrase zusätzlich im Passwortmanager sichern), werden
14 Tage aufbewahrt (die neuesten drei immer) und nach dem Schreiben probeweise entschlüsselt. Fehler lösen einen
Alarm aus; Protokolle stehen im Journal (`journalctl -t quizmaster-backup`, `-t quizmaster-restore-test`,
`-t quizmaster-caddy`). Die Backups liegen auf demselben Server – zusätzlich extern sichern.

Wiederherstellung im Ernstfall: Apps stoppen (`pm2 stop quizmaster-web quizmaster-realtime`), das Archiv mit der
Passphrase entschlüsseln und mit `mongorestore --archive --gzip --drop` in die Produktionsdatenbank einspielen
(Zugangsdaten über `--config`, nicht auf der Kommandozeile), danach `pnpm deploy:restart`.

### Monitoring

`/api/health` (Web) und `/healthz` (Realtime) von außen überwachen. `/metrics` (Prometheus-Format) ist nur lokal
mit `METRICS_TOKEN` erreichbar. Der Watchdog meldet Ausfälle an `ALERT_WEBHOOK_URL`.

### Runbooks

| Lage | Vorgehen |
|---|---|
| Deploy fehlerhaft | `pnpm deploy:rollback`, danach Ursache in `pm2 logs` suchen |
| Realtime hängt, hohe CPU | Metriken prüfen → `maxActiveLobbies` senken oder Lobby-Erstellung pausieren (`appConfig`) → `pm2 restart quizmaster-realtime` (Clients verbinden neu) → Ursache im Profil suchen |
| MongoDB nicht erreichbar | laufende Spiele laufen im Speicher weiter, neue Sessions/Lobbys schlagen fehl → Wartungsbanner (`appConfig.maintenance`), Cluster-Status prüfen |
| Bot-Welle erstellt Lobbys | `appConfig.lobbyCreationEnabled=false` oder `turnstileOnJoin=true`; Cloudflare-Rate-Limit-Regel verschärfen |
| DDoS | Cloudflare „Under Attack Mode“, `maxActiveLobbies` senken, Caddy-Allowlist prüfen (`pnpm caddy:dry-run`) |
| Beleidigende Namen | Blockliste über `appConfig` ergänzen (wirkt beim nächsten Beitritt), betroffene Gäste sperren |
| Falsche Frage verbreitet sich | Frage im Katalog auf `retired` setzen oder korrigieren → Seed → Change Stream nimmt sie sofort aus dem Pool |
| Antwort-Leak entdeckt | Hotfix + Release, `minClientProtocol` erhöhen, Test ergänzen |
| Secret kompromittiert | rotieren (siehe oben), betroffene Apps neu starten, Vorfall dokumentieren |
| Alarm „Backup fehlgeschlagen“ | `journalctl -t quizmaster-backup`, Ursache beheben, `pnpm ops:backup` erneut ausführen |

## Sicherheit

Sicherheitslücken bitte nicht öffentlich melden, sondern über „Report a vulnerability“ (GitHub Security
Advisories) dieses Repositorys.

## Lizenz

MIT
