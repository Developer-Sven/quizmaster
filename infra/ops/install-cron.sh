#!/usr/bin/env bash
# Richtet /etc/cron.d/quizmaster ein (Betrieb, nur als root – einmalig beim Einrichten des Servers):
#   jede Minute                      Health-Kontrolle Web/Realtime (infra/ops/healthcheck.sh)
#   täglich 03:30                    Backup (infra/ops/backup.sh)
#   täglich 09:00                    Backup-Kontrolle: Alarm, wenn kein frisches Backup existiert (check-backup.sh)
#   1. Jan/Apr/Jul/Okt, 04:30        Restore-Test (infra/ops/restore-test.sh)
#   montags 05:15                    Cloudflare-IP-Refresh der Caddy-Site (install-site.sh --refresh-ips)
# Ausgaben gehen ins Journal (journalctl -t quizmaster-healthcheck | -backup | -check-backup | -restore-test |
# -caddy); Fehler lösen zusätzlich einen Alarm aus (ALERT_WEBHOOK_URL – ohne Webhook verweigert dieses Skript
# die Einrichtung, außer mit --allow-no-webhook). flock verhindert überlappende Läufe. QM_UNATTENDED=1: Backup,
# Restore-Test und Caddy-Refresh laufen nur mit committeten Betriebswerkzeugen (infra/ops/lib.sh).
# Vorher wird /etc/cron.d nach /root/backups/quizmaster/<ts>/cron.d gesichert.
#
#   pnpm ops:install-cron [--dry-run] [--allow-no-webhook] [--env-file <datei>]
#   Nur Tests: QM_CRON_DIR=<verz> (Standard /etc/cron.d), QM_BACKUP_ROOT=<verz>
set -Eeuo pipefail
umask 022
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DRY_RUN=0
ALLOW_NO_WEBHOOK=0
ENV_FILE="$QM_ROOT/.env.prod"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --allow-no-webhook) ALLOW_NO_WEBHOOK=1; shift ;;
    --env-file) ENV_FILE="${2:?--env-file braucht eine Datei}"; shift 2 ;;
    -h | --help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
CRON_DIR="${QM_CRON_DIR:-/etc/cron.d}"
TARGET="$CRON_DIR/quizmaster"

# Pfade landen unverändert in Cron-Zeilen: nur unkritische Zeichen zulassen.
[[ "$QM_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || qm_die "Projektpfad enthält Zeichen, die in Cron-Zeilen stören: $QM_ROOT"

# Ohne Webhook gehen alle Alarme (Backup, Restore-Test, Health, Caddy) nur ins Journal – das liest nachts niemand.
NODE="$(qm_node)" || qm_die "Node 24 nicht gefunden (.deploy/runtime oder .tooling)"
qm_private_file "$ENV_FILE"
HAS_WEBHOOK="$("$NODE" "$QM_ROOT/scripts/ops/ops-env.ts" has --env-file "$ENV_FILE" --key ALERT_WEBHOOK_URL)"
if [ "$HAS_WEBHOOK" != "yes" ]; then
  if [ "$ALLOW_NO_WEBHOOK" = 1 ]; then
    qm_warn "ALERT_WEBHOOK_URL fehlt – Alarme landen nur im Journal (bewusst mit --allow-no-webhook)"
  elif [ "$DRY_RUN" = 1 ]; then
    qm_warn "ALERT_WEBHOOK_URL fehlt in $(basename "$ENV_FILE") – die Einrichtung würde verweigert"
  else
    qm_die "ALERT_WEBHOOK_URL fehlt in $(basename "$ENV_FILE") – ohne Webhook bleibt jeder Alarm im Journal." \
      "Eintragen, mit 'pnpm ops:alert-test' prüfen, dann erneut ausführen (bewusst ohne: --allow-no-webhook)"
  fi
fi

job() { # job <Zeitplan> <Tag> <Befehl …>
  local schedule="$1" tag="$2"
  shift 2
  printf '%s root  flock -n /run/lock/%s.lock /bin/bash %s 2>&1 | logger -t %s\n' "$schedule" "$tag" "$*" "$tag"
}

content="# quizmaster – Betrieb (erzeugt von infra/ops/install-cron.sh; Änderungen dort vornehmen)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=\"\"
# Unbeaufsichtigt: nur committete Betriebswerkzeuge ausführen (infra/ops/lib.sh qm_require_committed_tools)
QM_UNATTENDED=1

# m  h  dom mon      dow  user  command
$(job '*    *  *   *        * ' quizmaster-healthcheck "$QM_ROOT/infra/ops/healthcheck.sh")
$(job '30   3  *   *        * ' quizmaster-backup "$QM_ROOT/infra/ops/backup.sh")
$(job '0    9  *   *        * ' quizmaster-check-backup "$QM_ROOT/infra/ops/check-backup.sh")
$(job '30   4  1   1,4,7,10 * ' quizmaster-restore-test "$QM_ROOT/infra/ops/restore-test.sh")
$(job '15   5  *   *        1 ' quizmaster-caddy "$QM_ROOT/infra/caddy/install-site.sh --refresh-ips")
"

if [ "$DRY_RUN" = 1 ]; then
  qm_log "Dry-Run – würde $TARGET schreiben:"
  printf '%s' "$content"
  exit 0
fi

[ "$(id -u)" = 0 ] || qm_die "nur als root ausführbar"
[ -d "$CRON_DIR" ] || qm_die "$CRON_DIR fehlt"

BACKUP="$(qm_backup_dir cron)"
cp -a -- "$CRON_DIR" "$BACKUP/cron.d"
qm_log "Sicherung: $CRON_DIR → $BACKUP/cron.d"

tmp="$(mktemp "$CRON_DIR/.quizmaster.XXXXXX")"
trap 'rm -f -- "$tmp"' EXIT
printf '%s' "$content" >"$tmp"
chmod 0644 "$tmp"
chown root:root "$tmp"
mv -f -- "$tmp" "$TARGET"
trap - EXIT
qm_log "$TARGET geschrieben (cron liest /etc/cron.d selbstständig neu ein)"
qm_log "Kontrolle: cat $TARGET · Journal: journalctl -t quizmaster-healthcheck -t quizmaster-backup" \
  "-t quizmaster-check-backup -t quizmaster-restore-test -t quizmaster-caddy"
