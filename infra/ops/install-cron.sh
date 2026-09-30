#!/usr/bin/env bash
# Richtet /etc/cron.d/quizmaster ein (Betrieb, nur als root – Go-live durch den Orchestrator):
#   täglich 03:30                    Backup (infra/ops/backup.sh)
#   1. Jan/Apr/Jul/Okt, 04:30        Restore-Test (infra/ops/restore-test.sh)
#   montags 05:15                    Cloudflare-IP-Refresh der Caddy-Site (install-site.sh --refresh-ips)
# Ausgaben gehen ins Journal (journalctl -t quizmaster-backup | -restore-test | -caddy); Fehler lösen
# zusätzlich einen Alarm aus (ALERT_WEBHOOK_URL). flock verhindert überlappende Läufe.
# Vorher wird /etc/cron.d nach /root/backups/quizmaster/<ts>/cron.d gesichert.
#
#   pnpm ops:install-cron [--dry-run]
#   Nur Tests: QM_CRON_DIR=<verz> (Standard /etc/cron.d), QM_BACKUP_ROOT=<verz>
set -Eeuo pipefail
umask 022
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  -h | --help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) qm_die "unbekannte Option: $1 (--help)" ;;
esac
CRON_DIR="${QM_CRON_DIR:-/etc/cron.d}"
TARGET="$CRON_DIR/quizmaster"

# Pfade landen unverändert in Cron-Zeilen: nur unkritische Zeichen zulassen.
[[ "$QM_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || qm_die "Projektpfad enthält Zeichen, die in Cron-Zeilen stören: $QM_ROOT"

content="# quizmaster – Betrieb (erzeugt von infra/ops/install-cron.sh; Änderungen dort vornehmen)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=\"\"

# m  h  dom mon      dow  user  command
30   3  *   *        *    root  flock -n /run/lock/quizmaster-backup.lock /bin/bash $QM_ROOT/infra/ops/backup.sh 2>&1 | logger -t quizmaster-backup
30   4  1   1,4,7,10 *    root  flock -n /run/lock/quizmaster-restore-test.lock /bin/bash $QM_ROOT/infra/ops/restore-test.sh 2>&1 | logger -t quizmaster-restore-test
15   5  *   *        1    root  flock -n /run/lock/quizmaster-caddy.lock /bin/bash $QM_ROOT/infra/caddy/install-site.sh --refresh-ips 2>&1 | logger -t quizmaster-caddy
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
qm_log "Kontrolle: cat $TARGET · Journal: journalctl -t quizmaster-backup -t quizmaster-restore-test -t quizmaster-caddy"
