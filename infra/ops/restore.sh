#!/usr/bin/env bash
# Wiederherstellung der PRODUKTIONSDATENBANK aus einem Backup (Ernstfall; docs/12, README „Backups“).
#   1. Plan: Archiv (Standard: neuestes), Alter, Manifest, Ziel-Datenbank – ohne --confirm-prod endet es hier
#   2. Sicherheitskopie des jetzigen Stands (backup.sh --no-files) – scheitert sie, bleibt alles unverändert
#   3. Deploy-Sperre nehmen (kein paralleler Deploy; die Health-Kontrolle schweigt), Apps stoppen
#      (pm2 stop quizmaster-watchdog/-realtime/-web – nur diese Namen)
#   4. entschlüsseln (gpg, Passphrase über fd 3) → mongorestore --drop --nsInclude "<db>.*" (URI per --config,
#      nie auf der Kommandozeile) → Fehlerzahl und Dokumentzahl gegen das Manifest prüfen
#   5. Sperre freigeben, Apps mit frischer Env + Smoke-Test starten (scripts/deploy/deploy.ts restart)
#   Scheitert etwas nach Schritt 3, werden die Apps trotzdem wieder gestartet und ein Alarm ausgelöst; die
#   Sicherheitskopie aus Schritt 2 lässt sich mit --archive erneut einspielen.
#
#   pnpm ops:restore [Optionen]
#     --archive <datei>         Archiv (Standard: neuestes quizmaster-*.archive.gz.gpg)
#     --backup-dir <verz>       Backups (Standard /var/backups/quizmaster)
#     --confirm-prod            tatsächlich ausführen (ohne: nur der Plan)
#     --no-safety-backup        Schritt 2 auslassen (nur, wenn die Datenbank nicht mehr lesbar ist)
#     --passphrase-file <f>     Passphrase aus Datei (600), z. B. aus dem Passwortmanager, statt BACKUP_PASSPHRASE
#   Nur Tests: --env-file <f>, --deploy-dir <verz>, --no-alert, QM_PM2_BIN=<pm2>, QM_DEPLOY_TOOL=<deploy.ts>
set -Eeuo pipefail
umask 077
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP_DIR="/var/backups/quizmaster"
ARCHIVE=""
CONFIRM=0
SAFETY=1
PASS_FILE=""
ENV_FILE="$QM_ROOT/.env.prod"
DEPLOY_DIR="$QM_ROOT/.deploy"
ALERT=1
RESTORE_TIMEOUT="${QM_RESTORE_TIMEOUT:-2h}"
PM2_BIN="${QM_PM2_BIN:-pm2}"
DEPLOY_TOOL="${QM_DEPLOY_TOOL:-$QM_ROOT/scripts/deploy/deploy.ts}"
APPS_STOP=(quizmaster-watchdog quizmaster-realtime quizmaster-web)

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="${2:?--archive braucht eine Datei}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?--backup-dir braucht ein Verzeichnis}"; shift 2 ;;
    --confirm-prod) CONFIRM=1; shift ;;
    --no-safety-backup) SAFETY=0; shift ;;
    --passphrase-file) PASS_FILE="${2:?--passphrase-file braucht eine Datei}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file braucht eine Datei}"; shift 2 ;;
    --deploy-dir) DEPLOY_DIR="${2:?--deploy-dir braucht ein Verzeichnis}"; shift 2 ;;
    --no-alert) ALERT=0; shift ;;
    -h | --help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
HELPER="$QM_ROOT/scripts/ops"
LOCK="$DEPLOY_DIR/deploy.lock"

STEP="Vorbereitung"
TMP=""
NODE=""
LOCKED=0
APPS_STOPPED=0
RESTARTED=0

# Apps mit frischer Env starten (inkl. Smoke-Test und Rückweg des Deploy-Werkzeugs). Toolchain im PATH für pnpm.
restart_apps() {
  RESTARTED=1
  PATH="$QM_ROOT/.tooling/bin:$QM_ROOT/.tooling/node/bin:$PATH" "$NODE" "$DEPLOY_TOOL" restart
}

release_lock() {
  if [ "$LOCKED" = 1 ]; then
    rm -f -- "$LOCK"
    LOCKED=0
  fi
}

finish() {
  local code=$?
  set +e
  release_lock
  if [ "$APPS_STOPPED" = 1 ] && [ "$RESTARTED" = 0 ]; then
    qm_warn "Apps sind gestoppt – starte sie wieder (deploy.ts restart)"
    restart_apps || qm_error "Neustart der Apps fehlgeschlagen – sofort prüfen: pnpm deploy:status"
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    gpgconf --homedir "$TMP/gnupg" --kill gpg-agent >/dev/null 2>&1
    rm -rf -- "$TMP"
  fi
  if [ "$code" -ne 0 ]; then
    qm_error "Wiederherstellung fehlgeschlagen im Schritt „$STEP“ (Exit $code)"
    if [ "$ALERT" = 1 ]; then
      qm_alert "Wiederherstellung der Produktionsdatenbank fehlgeschlagen im Schritt „$STEP“ (Exit $code)"
    fi
  fi
  exit "$code"
}
trap finish EXIT

qm_require mongorestore gpg gpgconf gzip find sort timeout
NODE="$(qm_node)" || qm_die "Node 24 nicht gefunden (.deploy/runtime oder .tooling)"
qm_private_file "$ENV_FILE"

STEP="Plan"
if [ -z "$ARCHIVE" ]; then ARCHIVE="$(qm_newest "$BACKUP_DIR" 'quizmaster-[0-9]*.archive.gz.gpg')"; fi
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || qm_die "kein Backup-Archiv gefunden ($BACKUP_DIR)"
MANIFEST="${ARCHIVE%.archive.gz.gpg}.manifest.json"
DB="$("$NODE" "$HELPER/ops-env.ts" value --env-file "$ENV_FILE" --key MONGODB_DB)"
[[ "$DB" =~ ^[A-Za-z0-9_-]{1,63}$ ]] || qm_die "ungültiger Datenbankname"
EXPECTED=""
if [ -f "$MANIFEST" ]; then
  SOURCE_DB="$(sed -nE 's/^[[:space:]]*"database": "([A-Za-z0-9_-]{1,63})",?$/\1/p' "$MANIFEST" | head -n 1)"
  EXPECTED="$(sed -nE 's/^[[:space:]]*"totalDocuments": ([0-9]+),?$/\1/p' "$MANIFEST" | head -n 1)"
  [ "$SOURCE_DB" = "$DB" ] || qm_die "Archiv stammt aus Datenbank „${SOURCE_DB:-?}“, Ziel ist „$DB“ – abgebrochen"
else
  qm_warn "kein Manifest zu $(basename "$ARCHIVE") – Dokumentzahl wird nicht verglichen"
fi
qm_log "Plan: $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1), $(qm_age_hours "$ARCHIVE") h alt" \
  "${EXPECTED:+, $EXPECTED Dokumente laut Manifest}) → Datenbank $DB (vorhandene Collections aus dem Archiv werden ersetzt)"
qm_log "Ablauf: $([ "$SAFETY" = 1 ] && echo "Sicherheitskopie → ")Apps stoppen → mongorestore --drop → Apps starten + Smoke-Test"
if [ "$CONFIRM" = 0 ]; then
  STEP="fertig"
  qm_log "Nur Plan – zum Ausführen: pnpm ops:restore --archive $ARCHIVE --confirm-prod"
  exit 0
fi

STEP="Passphrase"
if [ -n "$PASS_FILE" ]; then
  qm_private_file "$PASS_FILE"
  PASSPHRASE="$(<"$PASS_FILE")"
else
  PASSPHRASE="$("$NODE" "$HELPER/ops-env.ts" value --env-file "$ENV_FILE" --key BACKUP_PASSPHRASE)"
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/quizmaster-restore-prod.XXXXXX")"
export GNUPGHOME="$TMP/gnupg"
install -d -m 700 "$GNUPGHOME"
# Archiv vollständig prüfen (Passphrase, Integrität, gzip), bevor irgendetwas gestoppt wird.
STEP="Archiv prüfen"
set +e
gpg --batch --no-tty --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$ARCHIVE" 3<<<"$PASSPHRASE" \
  2>/dev/null | gzip -t 2>/dev/null
codes=("${PIPESTATUS[@]}")
set -e
[ "${codes[0]}" = 0 ] || qm_die "Archiv lässt sich nicht entschlüsseln (Passphrase oder Archiv defekt, gpg Exit ${codes[0]})"
[ "${codes[1]}" = 0 ] || qm_die "Archiv ist entschlüsselt kein gültiges gzip (Exit ${codes[1]})"
qm_log "Archiv geprüft: entschlüsselbar und vollständig"

if [ "$SAFETY" = 1 ]; then
  STEP="Sicherheitskopie"
  safety_args=(--no-files --no-alert --env-file "$ENV_FILE" --out-dir "$BACKUP_DIR")
  if [ -n "$PASS_FILE" ]; then safety_args+=(--passphrase-file "$PASS_FILE"); fi
  bash "$QM_ROOT/infra/ops/backup.sh" "${safety_args[@]}"
  qm_log "Sicherheitskopie des jetzigen Stands liegt in $BACKUP_DIR (neuestes Archiv)"
fi

STEP="Deploy-Sperre"
install -d -m 700 "$DEPLOY_DIR"
take_lock() {
  (set -o noclobber; printf '{"pid":%s,"command":"ops:restore","startedAt":"%s"}' "$$" "$(date -u +%FT%TZ)" \
    >"$LOCK") 2>/dev/null
}
if ! take_lock; then
  holder="$(sed -nE 's/.*"pid":([0-9]+).*/\1/p' "$LOCK" 2>/dev/null | head -n 1)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    qm_die "Deploy-Sperre belegt (PID $holder) – erst den laufenden Deploy/Rollback abwarten"
  fi
  qm_warn "verwaiste Deploy-Sperre (PID ${holder:-?}) wird übernommen"
  rm -f -- "$LOCK"
  take_lock || qm_die "Deploy-Sperre nicht erhältlich"
fi
LOCKED=1

STEP="Apps stoppen"
APPS_STOPPED=1
# pm2 mit bereinigter Umgebung (wie scripts/deploy/lib/proc.ts pm2Env) – sonst landet die Shell-Env in pm2.
pm2_clean() {
  local -a env_args=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "HOME=${HOME:-/root}" LANG=C.UTF-8)
  if [ -n "${PM2_HOME:-}" ]; then env_args+=("PM2_HOME=$PM2_HOME"); fi
  env -i "${env_args[@]}" "$PM2_BIN" "$@"
}
pm2_clean stop "${APPS_STOP[0]}" >/dev/null 2>&1 || qm_warn "${APPS_STOP[0]} nicht gestoppt (läuft nicht?)"
pm2_clean stop "${APPS_STOP[1]}" "${APPS_STOP[2]}" >/dev/null || qm_die "pm2 stop fehlgeschlagen – nichts eingespielt"
qm_log "gestoppt: ${APPS_STOP[*]}"

STEP="mongorestore"
MONGO_CONFIG="$("$NODE" "$HELPER/ops-env.ts" mongo-config --env-file "$ENV_FILE")"
set +e
gpg --batch --no-tty --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$ARCHIVE" 3<<<"$PASSPHRASE" \
  | timeout --kill-after=60s "$RESTORE_TIMEOUT" mongorestore --config <(printf '%s' "$MONGO_CONFIG") \
    --archive --gzip --drop --nsInclude "$DB.*" --stopOnError 2>"$TMP/restore.log"
codes=("${PIPESTATUS[@]}")
set -e
unset MONGO_CONFIG PASSPHRASE
if [ "${codes[0]}" != 0 ] || [ "${codes[1]}" != 0 ]; then
  qm_sanitize <"$TMP/restore.log" | tail -n 20 >&2
  qm_die "Einspielen fehlgeschlagen (gpg Exit ${codes[0]}, mongorestore Exit ${codes[1]})"
fi
summary="$(grep -oE '[0-9]+ document\(s\) restored successfully\. [0-9]+ document\(s\) failed to restore\.' \
  "$TMP/restore.log" | tail -n 1)"
RESTORED="$(sed -nE 's/^([0-9]+) document.*/\1/p' <<<"$summary")"
FAILED="$(sed -nE 's/.* ([0-9]+) document\(s\) failed.*/\1/p' <<<"$summary")"
[ -n "$RESTORED" ] || qm_die "mongorestore-Ausgabe ohne Zusammenfassung – Ergebnis unklar"
[ "${FAILED:-0}" = 0 ] || qm_die "$FAILED Dokumente nicht eingespielt"
if [ -n "$EXPECTED" ] && [ "$RESTORED" != "$EXPECTED" ]; then
  qm_die "$RESTORED Dokumente eingespielt, Manifest nennt $EXPECTED"
fi
qm_log "eingespielt: $RESTORED Dokumente in $DB${EXPECTED:+ (= Manifest)}"

STEP="Apps starten"
release_lock
restart_apps
STEP="fertig"
qm_log "Wiederherstellung abgeschlossen: $(basename "$ARCHIVE") → $DB, Apps laufen (Smoke-Test bestanden)"
