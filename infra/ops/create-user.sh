#!/usr/bin/env bash
# Legt den Systembenutzer „quizmaster“ für die pm2-Apps an (docs/12 „Nicht-Root-User“, README „Systembenutzer“) –
# nur als root (einmalig beim Einrichten des Servers), idempotent:
#   1. Gruppe quizmaster (groupadd --system), falls sie fehlt
#   2. Benutzer quizmaster (useradd --system): primäre Gruppe quizmaster, kein Home (/nonexistent, wird nicht
#      angelegt), Shell nologin, gesperrtes Passwort, kein lastlog-Eintrag – falls er fehlt
#   3. vorher Sicherung von /etc/passwd, /etc/group, /etc/shadow und /etc/gshadow nach
#      /root/backups/quizmaster/<ts>/users/ (Verzeichnis 700, Dateien 600) – nur, wenn sich etwas ändert
# Vorhandene Einträge werden nur geprüft, nie geändert: uid/gid 0, eine Login-Shell, eine andere primäre Gruppe,
# eine zweite Kennung mit derselben uid, weitere Gruppenmitglieder oder andere Konten mit dieser primären Gruppe
# brechen ab (die Env-Dateien unter .deploy/env sind für die Gruppe lesbar).
# Wirkung erst mit dem nächsten `pnpm deploy:prod` bzw. `pnpm deploy:restart` (alle Apps): ecosystem.config.js
# startet web, realtime und watchdog dann mit uid/gid quizmaster, der Deploy setzt die Rechte unter .deploy.
#
#   pnpm ops:create-user [--dry-run]
#   Nur Tests: QM_ETC_DIR=<verz> (Quelle der Sicherung, Standard /etc), QM_BACKUP_ROOT=<verz>
set -Eeuo pipefail
umask 077
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

NAME="quizmaster"
HOME_DIR="/nonexistent"
COMMENT="quizmaster (pm2-Apps, ohne Login)"
ETC_DIR="${QM_ETC_DIR:-/etc}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
qm_require getent install

NOLOGIN=""
for candidate in /usr/sbin/nologin /sbin/nologin /bin/false; do
  if [ -x "$candidate" ]; then
    NOLOGIN="$candidate"
    break
  fi
done
[ -n "$NOLOGIN" ] || qm_die "keine nologin-Shell gefunden (/usr/sbin/nologin, /sbin/nologin, /bin/false)"

# Einträge aus /etc/passwd bzw. /etc/group (NSS-Dienst „files“) – genau dort suchen pm2 und ecosystem.config.js;
# ein gleichnamiges Konto aus LDAP o. Ä. zählt nicht. Leer = fehlt.
lookup() { getent -s files "$1" "$2" || true; }

# Andere Konten (außer $NAME) aus allen NSS-Quellen (vorsichtshalber auch LDAP o. Ä.), deren Feld $1 (3 = uid,
# 4 = primäre gid) den Wert $2 hat – kommagetrennt.
accounts_with() {
  getent passwd | awk -F: -v field="$1" -v value="$2" -v self="$NAME" \
    '$field == value && $1 != self { printf "%s%s", sep, $1; sep = "," }'
}

# Prüft einen vorhandenen Gruppeneintrag; gibt die gid aus.
check_group() {
  local gid members others
  IFS=: read -r _ _ gid members <<<"$1"
  [[ "$gid" =~ ^[0-9]+$ ]] || qm_die "Gruppe $NAME hat keine gültige gid"
  [ "$gid" != 0 ] || qm_die "Gruppe $NAME hat gid 0 – das wäre root; Eintrag von Hand prüfen"
  members="$(printf '%s' "$members" | tr ',' '\n' | grep -vx -e "$NAME" -e '' | paste -sd, - || true)"
  [ -z "$members" ] || qm_die "Gruppe $NAME hat weitere Mitglieder ($members) – sie könnten die Env-Dateien lesen"
  others="$(accounts_with 4 "$gid")"
  [ -z "$others" ] || qm_die "Gruppe $NAME (gid $gid) ist primäre Gruppe weiterer Konten ($others)"
  printf '%s\n' "$gid"
}

# Prüft einen vorhandenen Benutzereintrag gegen die gid der Gruppe; gibt die uid aus.
check_user() {
  local entry="$1" want_gid="$2" uid gid home shell twins
  IFS=: read -r _ _ uid gid _ home shell <<<"$entry"
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || qm_die "Benutzer $NAME hat keine gültige uid/gid"
  [ "$uid" != 0 ] || qm_die "Benutzer $NAME hat uid 0 – das wäre root; Eintrag von Hand prüfen"
  [ "$gid" = "$want_gid" ] || qm_die "Benutzer $NAME hat die primäre gid $gid statt $want_gid (Gruppe $NAME)"
  case "$shell" in
    */nologin | */false) ;;
    *) qm_die "Benutzer $NAME hat die Login-Shell ${shell:-(leer)} – erwartet nologin; Eintrag von Hand prüfen" ;;
  esac
  twins="$(accounts_with 3 "$uid")"
  [ -z "$twins" ] || qm_die "uid $uid von $NAME gehört auch $twins – eigene uid nötig"
  if [ "$home" != "$HOME_DIR" ] && [ -e "$home" ]; then
    qm_warn "Benutzer $NAME hat das Home $home (vorhanden) – die Apps brauchen keines"
  fi
  printf '%s\n' "$uid"
}

group_entry="$(lookup group "$NAME")"
user_entry="$(lookup passwd "$NAME")"
[ -n "$group_entry" ] || [ -z "$user_entry" ] \
  || qm_die "Benutzer $NAME existiert ohne Gruppe $NAME – Eintrag von Hand prüfen"

USERADD_ARGS=(--system --gid "$NAME" --no-user-group --no-create-home --home-dir "$HOME_DIR" --shell "$NOLOGIN"
  --comment "$COMMENT" --no-log-init "$NAME")
steps=()
if [ -n "$group_entry" ]; then
  gid="$(check_group "$group_entry")"
  qm_log "Gruppe $NAME vorhanden (gid $gid, exklusiv)"
else
  steps+=("groupadd --system $NAME")
fi
if [ -n "$user_entry" ]; then
  uid="$(check_user "$user_entry" "$gid")"
  qm_log "Benutzer $NAME vorhanden (uid $uid, gid $gid, ohne Login)"
else
  steps+=("useradd ${USERADD_ARGS[*]}")
fi

if [ "${#steps[@]}" -eq 0 ]; then
  qm_log "nichts zu tun – Wirkung: pnpm deploy:prod bzw. pnpm deploy:restart startet die Apps als $NAME"
  exit 0
fi
for step in "${steps[@]}"; do qm_log "geplant: $step"; done
if [ "$DRY_RUN" = 1 ]; then
  qm_log "Dry-Run – nichts geändert (vorher würden passwd, group, shadow, gshadow gesichert)"
  exit 0
fi
[ "$(id -u)" = 0 ] || qm_die "nur als root ausführbar (Vorschau: --dry-run)"

BACKUP="$(qm_backup_dir users)"
for file in passwd group shadow gshadow; do
  if [ -f "$ETC_DIR/$file" ]; then
    install -m 600 -- "$ETC_DIR/$file" "$BACKUP/$file"
  else
    qm_warn "$ETC_DIR/$file fehlt – nicht gesichert"
  fi
done
qm_log "Sicherung: $ETC_DIR/{passwd,group,shadow,gshadow} → $BACKUP"

# Übliche umask für die Konto-Werkzeuge (sie behalten die Rechte von /etc/passwd usw. ohnehin bei).
if [ -z "$group_entry" ]; then
  (umask 022 && groupadd --system "$NAME")
  qm_log "Gruppe $NAME angelegt"
fi
if [ -z "$user_entry" ]; then
  (umask 022 && useradd "${USERADD_ARGS[@]}")
  qm_log "Benutzer $NAME angelegt"
fi

# Ergebnis mit denselben Regeln prüfen, die auch ecosystem.config.js und der Deploy anwenden.
group_entry="$(lookup group "$NAME")"
user_entry="$(lookup passwd "$NAME")"
if [ -z "$group_entry" ] || [ -z "$user_entry" ]; then
  qm_die "Benutzer oder Gruppe $NAME nach dem Anlegen nicht auflösbar"
fi
gid="$(check_group "$group_entry")"
uid="$(check_user "$user_entry" "$gid")"
qm_log "fertig: $NAME (uid $uid, gid $gid, Shell $NOLOGIN, Home $HOME_DIR ohne Verzeichnis)"
qm_log "Wirkung: pnpm deploy:prod bzw. pnpm deploy:restart (alle Apps) startet web, realtime und watchdog als $NAME;" \
  "Kontrolle: pnpm deploy:status · Rückweg: README „Systembenutzer“"
