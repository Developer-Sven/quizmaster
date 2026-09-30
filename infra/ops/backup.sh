#!/usr/bin/env bash
# Tägliches Backup von quizmaster (Cron 03:30; docs/12 §MongoDB, docs/06 §MongoDB-Sicherheit):
#   1. mongodump der Datenbank aus .env.prod → gzip-Archiv → gpg --symmetric (AES256, Passphrase
#      BACKUP_PASSPHRASE über Dateideskriptor 3) → /var/backups/quizmaster/quizmaster-<ts>.archive.gz.gpg (600)
#      + Manifest mit den Dokumentzahlen je Collection (für den Restore-Test)
#   2. content/ und docs/ (lokale Git-Repos, ADR-021) als verschlüsseltes tar
#   3. Prüfung (entschlüsseln + gzip -t), Aufbewahrung 14 Tage (die neuesten 3 bleiben immer)
# Die Mongo-URI (mit Passwort, TLS-Parametern) liest ein Node-Helfer aus der Env-Datei; mongodump bekommt sie
# über --config aus einer Pipe – nie auf der Kommandozeile, nie im Terminal, nie im Log. Fehler → Alarm.
#
#   pnpm ops:backup [Optionen]
#     --env prod|dev          Quelle der Zugangsdaten (Standard prod → .env.prod)
#     --db <name>             Datenbank (Standard MONGODB_DB der Quelle)
#     --out-dir <verz>        Ziel (Standard /var/backups/quizmaster)
#     --passphrase-file <f>   Passphrase aus Datei (600) statt BACKUP_PASSPHRASE (Tests)
#     --retention-days <n>    Aufbewahrung (Standard 14)
#     --no-files              content/ und docs/ nicht sichern
#     --no-alert              Fehler nur loggen (Tests)
set -Eeuo pipefail
umask 077
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_NAME="prod"
DB=""
OUT_DIR="/var/backups/quizmaster"
PASS_FILE=""
RETENTION_DAYS=14
KEEP_MIN=3
WITH_FILES=1
ALERT=1
DUMP_TIMEOUT="${QM_BACKUP_TIMEOUT:-2h}"

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:?--env braucht prod oder dev}"; shift 2 ;;
    --db) DB="${2:?--db braucht einen Namen}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?--out-dir braucht ein Verzeichnis}"; shift 2 ;;
    --passphrase-file) PASS_FILE="${2:?--passphrase-file braucht eine Datei}"; shift 2 ;;
    --retention-days) RETENTION_DAYS="${2:?--retention-days braucht eine Zahl}"; shift 2 ;;
    --no-files) WITH_FILES=0; shift ;;
    --no-alert) ALERT=0; shift ;;
    -h | --help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
case "$ENV_NAME" in prod | dev) ;; *) qm_die "--env erwartet prod oder dev" ;; esac
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -ge 1 ] || qm_die "--retention-days: ganze Zahl ≥ 1"
ENV_FILE="$QM_ROOT/.env.$ENV_NAME"
HELPER="$QM_ROOT/scripts/ops"

STEP="Vorbereitung"
TMP=""
TS="$(qm_ts)"
ARCHIVE="$OUT_DIR/quizmaster-$TS.archive.gz.gpg"
MANIFEST="$OUT_DIR/quizmaster-$TS.manifest.json"
FILES_ARCHIVE="$OUT_DIR/quizmaster-files-$TS.tar.gz.gpg"

finish() {
  local code=$?
  set +e
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    gpgconf --homedir "$TMP/gnupg" --kill gpg-agent >/dev/null 2>&1
    rm -rf -- "$TMP"
  fi
  rm -f -- "$ARCHIVE.partial" "$MANIFEST.partial" "$FILES_ARCHIVE.partial"
  if [ "$code" -ne 0 ]; then
    qm_error "Backup fehlgeschlagen im Schritt „$STEP“ (Exit $code)"
    if [ "$ALERT" = 1 ]; then
      qm_alert "Backup fehlgeschlagen im Schritt „$STEP“ (Exit $code) – Details: journalctl -t quizmaster-backup"
    fi
  fi
  exit "$code"
}
trap finish EXIT

qm_require mongodump gpg gpgconf gzip tar find sort timeout flock
NODE="$(qm_node)" || qm_die "Node 24 nicht gefunden (.deploy/runtime oder .tooling)"
qm_private_file "$ENV_FILE"
install -d -m 700 "$OUT_DIR"
chmod 700 "$OUT_DIR"
exec 9>"$OUT_DIR/.backup.lock"
flock -n 9 || qm_die "ein anderes Backup läuft bereits"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/quizmaster-backup.XXXXXX")"
export GNUPGHOME="$TMP/gnupg"
install -d -m 700 "$GNUPGHOME"

STEP="Zugangsdaten"
MONGO_CONFIG="$("$NODE" "$HELPER/ops-env.ts" mongo-config --env-file "$ENV_FILE")"
[ -n "$DB" ] || DB="$("$NODE" "$HELPER/ops-env.ts" value --env-file "$ENV_FILE" --key MONGODB_DB)"
[[ "$DB" =~ ^[A-Za-z0-9_-]{1,63}$ ]] || qm_die "ungültiger Datenbankname"
if [ -n "$PASS_FILE" ]; then
  qm_private_file "$PASS_FILE"
  PASSPHRASE="$(<"$PASS_FILE")"
else
  PASSPHRASE="$("$NODE" "$HELPER/ops-env.ts" value --env-file "$ENV_FILE" --key BACKUP_PASSPHRASE)"
fi
[ "${#PASSPHRASE}" -ge 16 ] || qm_die "Passphrase fehlt oder ist zu kurz (mind. 16 Zeichen)"

# Klartext von stdin → verschlüsselt nach $1 (Passphrase über fd 3, AES256, S2K SHA512 mit max. Iterationen).
encrypt_to() {
  gpg --batch --yes --no-tty --quiet --pinentry-mode loopback --passphrase-fd 3 \
    --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --compress-algo none --output "$1" 3<<<"$PASSPHRASE"
}
decrypt_from() {
  gpg --batch --no-tty --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$1" 3<<<"$PASSPHRASE"
}

STEP="mongodump"
qm_log "Backup der Datenbank $DB (.env.$ENV_NAME) → $(basename "$ARCHIVE")"
set +e
timeout --kill-after=60s "$DUMP_TIMEOUT" mongodump --config <(printf '%s' "$MONGO_CONFIG") \
  --db "$DB" --archive --gzip 2>"$TMP/dump.log" | encrypt_to "$ARCHIVE.partial"
codes=("${PIPESTATUS[@]}")
set -e
unset MONGO_CONFIG
if [ "${codes[0]}" != 0 ]; then
  qm_sanitize <"$TMP/dump.log" | tail -n 20 >&2
  qm_die "mongodump beendet mit Exit ${codes[0]}"
fi
[ "${codes[1]}" = 0 ] || qm_die "gpg beendet mit Exit ${codes[1]}"

STEP="Manifest"
"$NODE" "$HELPER/dump-manifest.ts" --log "$TMP/dump.log" --db "$DB" --archive "$(basename "$ARCHIVE")" \
  --out "$MANIFEST.partial" >"$TMP/manifest.out"
qm_read_kv MF_ <"$TMP/manifest.out"

STEP="Prüfung"
decrypt_from "$ARCHIVE.partial" | gzip -t
mv -f -- "$ARCHIVE.partial" "$ARCHIVE"
mv -f -- "$MANIFEST.partial" "$MANIFEST"
chmod 600 -- "$ARCHIVE" "$MANIFEST"
qm_log "Datenbank gesichert: ${MF_MANIFEST_COLLECTIONS:-?} Collections, ${MF_MANIFEST_DOCUMENTS:-?} Dokumente, $(du -h "$ARCHIVE" | cut -f1)"

if [ "$WITH_FILES" = 1 ]; then
  STEP="content/ + docs/"
  dirs=()
  for dir in content docs; do
    if [ -d "$QM_ROOT/$dir" ]; then dirs+=("$dir"); else qm_warn "$dir/ fehlt – nicht gesichert"; fi
  done
  if [ "${#dirs[@]}" -gt 0 ]; then
    set +e
    tar -C "$QM_ROOT" --warning=no-file-changed -czf - -- "${dirs[@]}" | encrypt_to "$FILES_ARCHIVE.partial"
    codes=("${PIPESTATUS[@]}")
    set -e
    # GNU tar: Exit 1 = Dateien änderten sich während des Lesens (Archiv bleibt gültig), > 1 = Fehler.
    case "${codes[0]}" in
      0) ;;
      1) qm_warn "Dateien in ${dirs[*]} änderten sich während der Sicherung – Archiv ist trotzdem gültig" ;;
      *) qm_die "tar beendet mit Exit ${codes[0]}" ;;
    esac
    [ "${codes[1]}" = 0 ] || qm_die "gpg beendet mit Exit ${codes[1]}"
    decrypt_from "$FILES_ARCHIVE.partial" | gzip -t
    mv -f -- "$FILES_ARCHIVE.partial" "$FILES_ARCHIVE"
    chmod 600 -- "$FILES_ARCHIVE"
    qm_log "Dateien gesichert: ${dirs[*]} → $(basename "$FILES_ARCHIVE") ($(du -h "$FILES_ARCHIVE" | cut -f1))"
  fi
fi
unset PASSPHRASE

STEP="Aufbewahrung"
# Löscht Archive älter als RETENTION_DAYS – die neuesten KEEP_MIN je Art bleiben immer (auch wenn alt).
prune() {
  local pattern="$1" file index=0
  local -a files=()
  mapfile -t files < <(find "$OUT_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  for file in "${files[@]}"; do
    index=$((index + 1))
    if [ "$index" -le "$KEEP_MIN" ]; then continue; fi
    if [ -n "$(find "$file" -maxdepth 0 -mtime +"$((RETENTION_DAYS - 1))")" ]; then
      rm -f -- "$file" "${file%.archive.gz.gpg}.manifest.json"
      qm_log "gelöscht (älter als $RETENTION_DAYS Tage): $(basename "$file")"
    fi
  done
}
prune 'quizmaster-[0-9]*.archive.gz.gpg'
prune 'quizmaster-files-[0-9]*.tar.gz.gpg'

STEP="fertig"
qm_log "Backup ok in ${SECONDS}s: $OUT_DIR ($(find "$OUT_DIR" -maxdepth 1 -type f -name 'quizmaster-*.gpg' | wc -l) verschlüsselte Archive)"
