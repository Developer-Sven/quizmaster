#!/usr/bin/env bash
# Restore-Test von quizmaster (Cron quartalsweise; docs/12 „Restore quartalsweise testen“, docs/06):
#   neuestes Backup entschlüsseln (gpg, Passphrase über fd 3) → direkt als Strom in mongorestore → TEST-DB
#   (URI + TEST_MONGODB_DB aus .env.dev, ADR-029) mit umbenannten Collections rt<ts>_<name>
#   → Dokumente je Collection vergleichen (Manifest = Archiv = Test-DB) → restaurierte Collections löschen
#   → Ergebnis loggen. Nie in die Produktion: Ziel muss auf _test enden, Collections tragen das rt-Präfix.
# Ohne Index-/Optionen-Restore: TTL-Indizes würden abgelaufene Dokumente während des Vergleichs löschen,
# Validatoren und Indizes legt ensureIndexes() beim Start ohnehin an. Fehler → Alarm.
#
#   pnpm ops:restore-test [Optionen]
#     --backup-dir <verz>       Backups (Standard /var/backups/quizmaster)
#     --archive <datei>         bestimmtes Archiv statt des neuesten
#     --passphrase-file <f>     Passphrase aus Datei (600) statt BACKUP_PASSPHRASE aus .env.prod (Tests)
#     --target-env-file <f>     Zielverbindung (Standard .env.dev)
#     --keep                    restaurierte Collections nicht löschen (nur Fehlersuche)
#     --no-alert                Fehler nur loggen (Tests)
set -Eeuo pipefail
umask 077
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP_DIR="/var/backups/quizmaster"
ARCHIVE=""
PASS_FILE=""
TARGET_ENV="$QM_ROOT/.env.dev"
KEEP=0
ALERT=1
RESTORE_TIMEOUT="${QM_RESTORE_TIMEOUT:-2h}"

while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) BACKUP_DIR="${2:?--backup-dir braucht ein Verzeichnis}"; shift 2 ;;
    --archive) ARCHIVE="${2:?--archive braucht eine Datei}"; shift 2 ;;
    --passphrase-file) PASS_FILE="${2:?--passphrase-file braucht eine Datei}"; shift 2 ;;
    --target-env-file) TARGET_ENV="${2:?--target-env-file braucht eine Datei}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-alert) ALERT=0; shift ;;
    -h | --help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
HELPER="$QM_ROOT/scripts/ops"

STEP="Vorbereitung"
TMP=""
NODE=""
PREFIX=""
TARGET_DB=""
RESTORE_STARTED=0
VERIFY_RAN=0

finish() {
  local code=$?
  set +e
  # Reste eines abgebrochenen Laufs sofort entfernen (sonst spätestens beim nächsten Lauf per --drop-stale).
  if [ "$RESTORE_STARTED" = 1 ] && [ "$VERIFY_RAN" = 0 ] && [ "$KEEP" = 0 ]; then
    "$NODE" "$HELPER/restore-verify.ts" --env-file "$TARGET_ENV" --db "$TARGET_DB" --prefix "$PREFIX" \
      --drop-only >/dev/null 2>&1 || qm_warn "restaurierte Collections ($PREFIX*) nicht entfernt – nächster Lauf räumt auf"
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    gpgconf --homedir "$TMP/gnupg" --kill gpg-agent >/dev/null 2>&1
    rm -rf -- "$TMP"
  fi
  if [ "$code" -ne 0 ]; then
    qm_error "Restore-Test fehlgeschlagen im Schritt „$STEP“ (Exit $code)"
    if [ "$ALERT" = 1 ]; then
      qm_alert "Restore-Test fehlgeschlagen im Schritt „$STEP“ (Exit $code) – Details: journalctl -t quizmaster-restore-test"
    fi
  fi
  exit "$code"
}
trap finish EXIT

qm_require mongorestore gpg gpgconf find sort timeout
NODE="$(qm_node)" || qm_die "Node 24 nicht gefunden (.deploy/runtime oder .tooling)"
qm_private_file "$TARGET_ENV"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/quizmaster-restore.XXXXXX")"
export GNUPGHOME="$TMP/gnupg"
install -d -m 700 "$GNUPGHOME"

STEP="Archiv wählen"
if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'quizmaster-[0-9]*.archive.gz.gpg' -printf '%T@ %p\n' \
    | sort -rn | head -n 1 | cut -d' ' -f2-)"
fi
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || qm_die "kein Backup-Archiv in $BACKUP_DIR gefunden"
MANIFEST="${ARCHIVE%.archive.gz.gpg}.manifest.json"
SOURCE_DB=""
if [ -f "$MANIFEST" ]; then
  SOURCE_DB="$(sed -nE 's/^[[:space:]]*"database": "([A-Za-z0-9_-]{1,63})",?$/\1/p' "$MANIFEST" | head -n 1)"
else
  qm_warn "kein Manifest zu $(basename "$ARCHIVE") – Vergleich nur Archiv ↔ Test-DB"
  MANIFEST=""
fi
if [ -z "$SOURCE_DB" ]; then
  qm_private_file "$QM_ROOT/.env.prod"
  SOURCE_DB="$("$NODE" "$HELPER/ops-env.ts" value --env-file "$QM_ROOT/.env.prod" --key MONGODB_DB)"
fi
[[ "$SOURCE_DB" =~ ^[A-Za-z0-9_-]{1,63}$ ]] || qm_die "ungültige Quell-Datenbank"
AGE_HOURS=$(( ($(date +%s) - $(stat -c %Y "$ARCHIVE")) / 3600 ))
qm_log "Archiv $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1), ${AGE_HOURS} h alt), Quelle $SOURCE_DB"

STEP="Zugangsdaten"
TARGET_CONFIG="$("$NODE" "$HELPER/ops-env.ts" mongo-config --env-file "$TARGET_ENV")"
TARGET_DB="$("$NODE" "$HELPER/ops-env.ts" value --env-file "$TARGET_ENV" --key TEST_MONGODB_DB)"
[[ "$TARGET_DB" =~ ^[A-Za-z0-9_-]{1,63}_test$ ]] || qm_die "Ziel muss eine *_test-Datenbank sein"
if [ -n "$PASS_FILE" ]; then
  qm_private_file "$PASS_FILE"
  PASSPHRASE="$(<"$PASS_FILE")"
else
  qm_private_file "$QM_ROOT/.env.prod"
  PASSPHRASE="$("$NODE" "$HELPER/ops-env.ts" value --env-file "$QM_ROOT/.env.prod" --key BACKUP_PASSPHRASE)"
fi

STEP="Altlasten"
"$NODE" "$HELPER/restore-verify.ts" --env-file "$TARGET_ENV" --db "$TARGET_DB" --drop-stale >"$TMP/stale.out"
qm_read_kv ST_ <"$TMP/stale.out"
[ "${ST_RESTORE_STALE_DROPPED:-0}" = 0 ] || qm_warn "${ST_RESTORE_STALE_DROPPED} Collections abgebrochener Läufe entfernt"

STEP="Entschlüsseln + mongorestore"
PREFIX="rt$(date -u +%y%m%d%H%M%S)_"
qm_log "Restore nach $TARGET_DB (Collections ${PREFIX}*)"
RESTORE_STARTED=1
set +e
gpg --batch --no-tty --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$ARCHIVE" 3<<<"$PASSPHRASE" \
  | timeout --kill-after=60s "$RESTORE_TIMEOUT" mongorestore --config <(printf '%s' "$TARGET_CONFIG") \
    --archive --gzip --nsInclude "$SOURCE_DB.*" --nsFrom "$SOURCE_DB.*" --nsTo "$TARGET_DB.${PREFIX}*" \
    --noIndexRestore --noOptionsRestore --stopOnError 2>"$TMP/restore.log"
codes=("${PIPESTATUS[@]}")
set -e
unset TARGET_CONFIG PASSPHRASE
[ "${codes[0]}" = 0 ] || qm_die "gpg konnte das Archiv nicht entschlüsseln (Exit ${codes[0]}) – Passphrase/Archiv prüfen"
if [ "${codes[1]}" != 0 ]; then
  qm_sanitize <"$TMP/restore.log" | tail -n 20 >&2
  qm_die "mongorestore beendet mit Exit ${codes[1]}"
fi

STEP="Vergleich"
verify_args=(--env-file "$TARGET_ENV" --db "$TARGET_DB" --prefix "$PREFIX" --restore-log "$TMP/restore.log")
if [ -n "$MANIFEST" ]; then verify_args+=(--manifest "$MANIFEST"); fi
if [ "$KEEP" = 1 ]; then verify_args+=(--keep); fi
VERIFY_RAN=1
"$NODE" "$HELPER/restore-verify.ts" "${verify_args[@]}" >"$TMP/verify.out"
qm_read_kv RV_ <"$TMP/verify.out"

STEP="fertig"
qm_log "Restore-Test ok in ${SECONDS}s: $(basename "$ARCHIVE") → $TARGET_DB: ${RV_RESTORE_COLLECTIONS:-?} Collections," \
  "${RV_RESTORE_DOCUMENTS:-?} Dokumente – Zählung stimmt mit ${MANIFEST:+Manifest und }Archiv überein;" \
  "${RV_RESTORE_DROPPED:-0} restaurierte Collections wieder gelöscht"
