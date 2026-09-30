#!/usr/bin/env bash
# Caddy-Site für quizmaster (ADR-024) – Host-Caddy mit Cloudflare-Origin-Zertifikat, nur Cloudflare-IPs.
#
#   pnpm caddy:dry-run      Site aus .env.prod erzeugen, Zertifikat prüfen, gesamte Caddy-Konfiguration mit der
#                           neuen Site validieren und den Unterschied zur installierten Datei zeigen – ändert nichts
#   pnpm caddy:install      (root) Backup → /etc/caddy/quizmaster.caddy → eine `import`-Zeile im Caddyfile
#                           (idempotent) → caddy validate → `systemctl reload caddy` → is-active; bei Fehlern
#                           Wiederherstellung + erneuter Reload
#   install-site.sh --refresh-ips   (Cron, wöchentlich) nur tätig, wenn sich die Cloudflare-Liste geändert hat
#
# Werte: QUIZMASTER_DOMAIN, QUIZMASTER_PORT, REALTIME_PORT (leer = Port + 1), TLS_CERT_FILE, TLS_KEY_FILE aus
# .env.prod über @quizmaster/shared/env. Cloudflare-Bereiche von cloudflare.com/ips-v4|ips-v6 (geprüft; Fallback:
# infra/caddy/cloudflare-ips.txt). Reload ausschließlich über systemd – nie `caddy reload/run/stop` oder :2019.
#
# Optionen: --env-file <datei> (Standard .env.prod) · --out <datei> (Dry-Run: Site zusätzlich speichern)
# Nur Tests: QM_CADDY_DIR=<verz> (Standard /etc/caddy) zusammen mit --no-reload, QM_BACKUP_ROOT=<verz>.
set -Eeuo pipefail
umask 022
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../ops/lib.sh"

MODE="install"
REFRESH=0
NO_RELOAD=0
ENV_FILE="$QM_ROOT/.env.prod"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --refresh-ips) REFRESH=1; shift ;;
    --no-reload) NO_RELOAD=1; shift ;;
    --env-file) ENV_FILE="${2:?--env-file braucht eine Datei}"; shift 2 ;;
    --out) OUT="${2:?--out braucht eine Datei}"; shift 2 ;;
    -h | --help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
CADDY_DIR="${QM_CADDY_DIR:-/etc/caddy}"
if [ "$NO_RELOAD" = 1 ] && [ "$CADDY_DIR" = "/etc/caddy" ]; then
  qm_die "--no-reload ist nur mit QM_CADDY_DIR (Testverzeichnis) erlaubt"
fi
[ "$REFRESH" = 0 ] || [ "$MODE" = "install" ] || qm_die "--refresh-ips und --dry-run schließen sich aus"
MAIN="$CADDY_DIR/Caddyfile"
SITE="$CADDY_DIR/quizmaster.caddy"
CADDY_ENV="$CADDY_DIR/caddy.env"
IMPORT_LINE="import $SITE"
TEMPLATE="$QM_ROOT/infra/caddy/quizmaster.caddy.template"
IPS_FILE="$QM_ROOT/infra/caddy/cloudflare-ips.txt"
HELPER="$QM_ROOT/scripts/ops/caddy-site.ts"

STEP="Vorbereitung"
TMP=""
BK=""
HAD_SITE=0
finish() {
  local code=$?
  set +e
  [ -n "$TMP" ] && rm -rf -- "$TMP"
  if [ "$code" -ne 0 ]; then
    qm_error "Caddy-Site ($MODE) fehlgeschlagen im Schritt „$STEP“ (Exit $code)"
    if [ "$REFRESH" = 1 ]; then
      qm_alert "Caddy-Site-Refresh fehlgeschlagen im Schritt „$STEP“ – Details: journalctl -t quizmaster-caddy"
    fi
  fi
  exit "$code"
}
trap finish EXIT

qm_require caddy openssl diff curl flock
NODE="$(qm_node)" || qm_die "Node 24 nicht gefunden (.deploy/runtime oder .tooling)"
if [ "$MODE" = "install" ] && [ "$(id -u)" != 0 ]; then qm_die "Installation nur als root (Dry-Run: pnpm caddy:dry-run)"; fi
[ -f "$MAIN" ] || qm_die "$MAIN fehlt"
qm_private_file "$ENV_FILE"
if [ "$MODE" = "install" ]; then
  # Nie zwei Installationen gleichzeitig (manuell + wöchentlicher Cron); eigene Sperrdatei neben der des Crons.
  LOCK_FILE="${QM_CADDY_DIR:+$QM_CADDY_DIR/.quizmaster-install.lock}"
  exec 8>"${LOCK_FILE:-/run/lock/quizmaster-caddy-install.lock}"
  flock -n 8 || qm_die "eine andere Installation der Caddy-Site läuft gerade"
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/quizmaster-caddy.XXXXXX")"

# caddy validate mit der Umgebung des Dienstes (EnvironmentFile), Ausgabe ohne mögliche Token-Werte.
validate() {
  local config="$1"
  local -a args=(validate --config "$config" --adapter caddyfile)
  if [ -f "$CADDY_ENV" ]; then args+=(--envfile "$CADDY_ENV"); fi
  caddy "${args[@]}" 2>&1 | grep -vE '"level":"(info|debug)"' \
    | sed -E 's/((token|secret|password|key)=)[^&[:space:]"]*/\1***/Ig' | tail -n 15
  return "${PIPESTATUS[0]}"
}

STEP="Cloudflare-IP-Bereiche"
"$NODE" "$HELPER" refresh-ips --ips-file "$IPS_FILE" --out "$TMP/cloudflare-ips.txt" >"$TMP/ips.out"
qm_read_kv IP_ <"$TMP/ips.out"
IPS_SOURCE="$IPS_FILE"
case "${IP_STATUS:-failed}" in
  changed)
    IPS_SOURCE="$TMP/cloudflare-ips.txt"
    qm_log "Cloudflare-Liste geändert: ${IP_V4_COUNT:-?} IPv4 + ${IP_V6_COUNT:-?} IPv6 Bereiche"
    ;;
  unchanged) qm_log "Cloudflare-Liste unverändert (${IP_V4_COUNT:-?} IPv4 + ${IP_V6_COUNT:-?} IPv6)" ;;
  *) qm_warn "Cloudflare-Listen nicht abrufbar oder unplausibel – gespeicherte Liste $IPS_FILE wird verwendet" ;;
esac
if [ "$REFRESH" = 1 ] && [ "${IP_STATUS:-failed}" != "changed" ]; then
  STEP="fertig"
  qm_log "Refresh: nichts zu tun (Konfiguration bleibt, kein Reload)"
  exit 0
fi

STEP="Site erzeugen"
"$NODE" "$HELPER" render --env-file "$ENV_FILE" --template "$TEMPLATE" --ips-file "$IPS_SOURCE" \
  --out "$TMP/quizmaster.caddy" >"$TMP/site.out"
qm_read_kv SITE_ <"$TMP/site.out"
qm_log "Site ${SITE_DOMAIN:-?}: Web 127.0.0.1:${SITE_WEB_PORT:-?}, Realtime 127.0.0.1:${SITE_REALTIME_PORT:-?}, ${SITE_IPS_COUNT:-?} Cloudflare-Bereiche"

STEP="Zertifikat"
CERT="${SITE_TLS_CERT_FILE:-}"
KEY="${SITE_TLS_KEY_FILE:-}"
[ -f "$CERT" ] || qm_die "TLS_CERT_FILE existiert nicht"
[ -f "$KEY" ] || qm_die "TLS_KEY_FILE existiert nicht"
checkhost="$(openssl x509 -in "$CERT" -noout -checkhost "$SITE_DOMAIN" 2>&1 || true)"
case "$checkhost" in
  *"does match certificate"*) qm_log "Zertifikat deckt ${SITE_DOMAIN} ab (SAN geprüft)" ;;
  *) qm_die "Zertifikat deckt ${SITE_DOMAIN} NICHT ab (openssl x509 -checkhost)" ;;
esac
openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null || qm_die "Zertifikat ist abgelaufen"
if ! openssl x509 -in "$CERT" -noout -checkend $((30 * 24 * 3600)) >/dev/null; then
  qm_warn "Zertifikat läuft in weniger als 30 Tagen ab"
fi
cert_pub="$(openssl x509 -in "$CERT" -noout -pubkey | openssl sha256)"
key_pub="$(openssl pkey -in "$KEY" -pubout 2>/dev/null | openssl sha256)"
[ "$cert_pub" = "$key_pub" ] || qm_die "TLS_KEY_FILE passt nicht zu TLS_CERT_FILE"
if [ -z "${QM_CADDY_DIR:-}" ] && id -u caddy >/dev/null 2>&1; then
  runuser -u caddy -- test -r "$CERT" || qm_die "Benutzer caddy kann TLS_CERT_FILE nicht lesen"
  runuser -u caddy -- test -r "$KEY" || qm_die "Benutzer caddy kann TLS_KEY_FILE nicht lesen"
  qm_log "Benutzer caddy kann Zertifikat und Schlüssel lesen"
fi

STEP="Validierung (gesamte Konfiguration mit neuer Site)"
# Die Domain darf nicht zusätzlich direkt im Caddyfile als Site stehen (Kopfzeilen „… domain … {“).
domain_re="${SITE_DOMAIN//./\\.}"
if grep -Ev '^[[:space:]]*#' "$MAIN" | grep -E '\{[[:space:]]*$' \
  | grep -Eq "(^|[[:space:],/])${domain_re}(:[0-9]+)?([[:space:],{]|$)"; then
  qm_die "$MAIN definiert ${SITE_DOMAIN} bereits selbst – Site dort entfernen, sie kommt aus $SITE"
fi
# Kopie des Caddyfile mit der neuen Site statt der installierten – nichts in $CADDY_DIR wird verändert.
grep -vxF -- "$IMPORT_LINE" "$MAIN" >"$TMP/Caddyfile" || true
printf '\n# quizmaster (Kandidat)\nimport %s\n' "$TMP/quizmaster.caddy" >>"$TMP/Caddyfile"
validate "$TMP/Caddyfile" || qm_die "caddy validate lehnt die Konfiguration mit der neuen Site ab"
qm_log "caddy validate: gesamte Konfiguration mit der neuen Site gültig"

if [ "$MODE" = "dry-run" ]; then
  STEP="Dry-Run"
  if [ -f "$SITE" ]; then
    if diff -u --label "installiert: $SITE" --label "neu" "$SITE" "$TMP/quizmaster.caddy"; then
      qm_log "installierte Site ist identisch"
    fi
  else
    qm_log "noch keine Site installiert – würde $SITE anlegen und '$IMPORT_LINE' ans Ende von $MAIN setzen:"
    cat "$TMP/quizmaster.caddy"
  fi
  if [ -n "$OUT" ]; then
    cp -- "$TMP/quizmaster.caddy" "$OUT"
    qm_log "Site gespeichert: $OUT"
  fi
  STEP="fertig"
  qm_log "Dry-Run ok – nichts wurde verändert"
  exit 0
fi

STEP="Backup"
BK="$(qm_backup_dir caddy)"
cp -a -- "$MAIN" "$BK/Caddyfile"
if [ -f "$SITE" ]; then
  HAD_SITE=1
  cp -a -- "$SITE" "$BK/quizmaster.caddy"
fi
MAIN_BAK="$CADDY_DIR/Caddyfile.$(qm_ts).bak"
if [ -e "$MAIN_BAK" ]; then MAIN_BAK="${MAIN_BAK%.bak}-$$.bak"; fi
cp -a -- "$MAIN" "$MAIN_BAK"
qm_log "Sicherung: $BK und $MAIN_BAK"

restore() {
  qm_warn "stelle die vorherige Konfiguration wieder her"
  cp -a -- "$BK/Caddyfile" "$MAIN"
  if [ "$HAD_SITE" = 1 ]; then cp -a -- "$BK/quizmaster.caddy" "$SITE"; else rm -f -- "$SITE"; fi
}

STEP="Installation"
install -m 0644 "$TMP/quizmaster.caddy" "$SITE.tmp"
mv -f -- "$SITE.tmp" "$SITE"
if grep -qxF -- "$IMPORT_LINE" "$MAIN"; then
  qm_log "import-Zeile bereits vorhanden"
else
  cp -a -- "$MAIN" "$TMP/Caddyfile.new"
  if [ -n "$(tail -c 1 "$MAIN")" ]; then printf '\n' >>"$TMP/Caddyfile.new"; fi
  printf '\n# quizmaster (infra/caddy/install-site.sh)\n%s\n' "$IMPORT_LINE" >>"$TMP/Caddyfile.new"
  cp -- "$TMP/Caddyfile.new" "$MAIN.tmp"
  chmod --reference="$MAIN" "$MAIN.tmp"
  chown --reference="$MAIN" "$MAIN.tmp"
  mv -f -- "$MAIN.tmp" "$MAIN"
  qm_log "import-Zeile an $MAIN angehängt"
fi

STEP="caddy validate"
if ! validate "$MAIN"; then
  restore
  qm_die "caddy validate fehlgeschlagen – vorherige Dateien wiederhergestellt (kein Reload erfolgt)"
fi

STEP="systemctl reload caddy"
if [ "$NO_RELOAD" = 1 ]; then
  qm_log "Test: Reload übersprungen (--no-reload)"
else
  if ! systemctl reload caddy || ! systemctl is-active --quiet caddy; then
    restore
    systemctl reload caddy || qm_warn "erneuter Reload nach Wiederherstellung fehlgeschlagen – systemctl status caddy prüfen"
    qm_alert "Caddy-Reload mit der quizmaster-Site fehlgeschlagen – vorherige Konfiguration wiederhergestellt"
    qm_die "systemctl reload caddy fehlgeschlagen – vorherige Konfiguration wiederhergestellt"
  fi
  qm_log "Caddy neu geladen (systemctl reload caddy), Dienst aktiv"
  STEP="Kontrolle"
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${SITE_DOMAIN}:443:127.0.0.1" \
    "https://${SITE_DOMAIN}/api/health" || true)"
  qm_log "Kontrolle über Loopback: https://${SITE_DOMAIN}/api/health → HTTP ${code:-keine Antwort} (502 = Apps noch nicht deployt)"
fi

if [ "${IP_STATUS:-}" = "changed" ]; then
  cp -- "$TMP/cloudflare-ips.txt" "$IPS_FILE"
  qm_log "infra/caddy/cloudflare-ips.txt aktualisiert – bitte committen"
fi
STEP="fertig"
qm_log "Caddy-Site installiert: $SITE"
