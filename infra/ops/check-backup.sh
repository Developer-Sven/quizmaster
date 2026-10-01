#!/usr/bin/env bash
# Backup-Kontrolle von quizmaster (Cron täglich 09:00, nach dem Backup um 03:30): Totmannschalter für alle
# Fälle, in denen backup.sh gar nicht startet und deshalb selbst keinen Alarm auslösen kann (Cron/flock hängt,
# Arbeitsbaum defekt, Skript fehlt). Prüft ohne Secrets und ohne Entschlüsselung:
#   - neuestes quizmaster-<ts>.archive.gz.gpg existiert, ist nicht leer und höchstens --max-age-hours alt,
#     und das zugehörige Manifest (für den Restore-Test) liegt daneben
#   - neuestes quizmaster-files-<ts>.tar.gz.gpg ebenso – sofern content/ oder docs/ existieren
# Fehler → Alarm (ALERT_WEBHOOK_URL). Ein Ausfall des Cron-Dienstes selbst fällt so nicht auf – dafür braucht
# es einen externen Check (README „Monitoring“).
#
#   pnpm ops:check-backup [Optionen]
#     --backup-dir <verz>       Backups (Standard /var/backups/quizmaster)
#     --max-age-hours <n>       höchstes Alter des neuesten Archivs (Standard 26)
#     --no-alert                Fehler nur loggen (Tests)
set -Eeuo pipefail
umask 077
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP_DIR="/var/backups/quizmaster"
MAX_AGE_HOURS=26
ALERT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) BACKUP_DIR="${2:?--backup-dir braucht ein Verzeichnis}"; shift 2 ;;
    --max-age-hours) MAX_AGE_HOURS="${2:?--max-age-hours braucht eine Zahl}"; shift 2 ;;
    --no-alert) ALERT=0; shift ;;
    -h | --help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] && [ "$MAX_AGE_HOURS" -ge 1 ] || qm_die "--max-age-hours: ganze Zahl ≥ 1"

PROBLEMS=()
finish() {
  local code=$?
  set +e
  if [ "$code" -ne 0 ]; then
    local message="Backup-Kontrolle fehlgeschlagen (Exit $code)"
    if [ "${#PROBLEMS[@]}" -gt 0 ]; then message="Backup-Kontrolle: ${PROBLEMS[*]}"; fi
    qm_error "$message"
    if [ "$ALERT" = 1 ]; then
      qm_alert "$message – Details: journalctl -t quizmaster-backup -t quizmaster-check-backup"
    else
      qm_warn "ALARM (nicht gesendet, --no-alert): $message"
    fi
  fi
  exit "$code"
}
trap finish EXIT

qm_require find sort stat

# check <Muster> <Bezeichnung> <Manifest nötig 0|1>
check() {
  local newest age
  newest="$(qm_newest "$BACKUP_DIR" "$1")"
  if [ -z "$newest" ]; then
    PROBLEMS+=("kein $2 in $BACKUP_DIR;")
    return 0
  fi
  age="$(qm_age_hours "$newest")"
  if [ ! -s "$newest" ]; then PROBLEMS+=("$2 $(basename "$newest") ist leer;"); fi
  if [ "$age" -gt "$MAX_AGE_HOURS" ]; then
    PROBLEMS+=("neuestes $2 ist ${age} h alt (erlaubt ${MAX_AGE_HOURS} h) – das nächtliche Backup lief nicht;")
  fi
  if [ "$3" = 1 ] && [ ! -f "${newest%.archive.gz.gpg}.manifest.json" ]; then
    PROBLEMS+=("Manifest zu $(basename "$newest") fehlt;")
  fi
  qm_log "$2: $(basename "$newest"), ${age} h alt"
}

[ -d "$BACKUP_DIR" ] || PROBLEMS+=("Backup-Verzeichnis $BACKUP_DIR fehlt;")
if [ -d "$BACKUP_DIR" ]; then
  check 'quizmaster-[0-9]*.archive.gz.gpg' "Datenbank-Archiv" 1
  if [ -d "$QM_ROOT/content" ] || [ -d "$QM_ROOT/docs" ]; then
    check 'quizmaster-files-[0-9]*.tar.gz.gpg' "Datei-Archiv (content/, docs/)" 0
  else
    qm_warn "weder content/ noch docs/ vorhanden – Datei-Archiv nicht geprüft"
  fi
fi
if [ "${#PROBLEMS[@]}" -gt 0 ]; then exit 1; fi
qm_log "Backup-Kontrolle ok (höchstens ${MAX_AGE_HOURS} h alt)"
