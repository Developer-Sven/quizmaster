#!/usr/bin/env bash
# Health-Kontrolle von quizmaster (Cron jede Minute). Meldet Ausfälle, solange der Watchdog (quizmaster-watchdog,
# dist/watchdog.mjs) nicht geliefert ist, und bleibt danach als von pm2 unabhängige Kontrolle sinnvoll (fällt pm2
# selbst aus, kann ein pm2-Prozess nichts mehr melden):
#   GET http://127.0.0.1:<QUIZMASTER_PORT>/api/health und http://127.0.0.1:<REALTIME_PORT>/healthz (Ports aus
#   .env.prod über resolveEnv). 200 mit ok ≠ false = gesund; 429 = lebt (Rate-Limit – Loopback-Anfragen ohne
#   cf-connecting-ip teilen sich einen Zähler); alles andere, auch keine Antwort, = gestört.
#   Alarm, wenn ein Dienst seit --alert-after-min Minuten gestört ist (Standard 2, docs/12 „Health down > 2 min“),
#   einmal je Störung und mit Entwarnung, sobald er wieder antwortet. Nichts wird geprüft ohne aktives Release
#   (.deploy/current) und während eines laufenden Deploys (lebende Sperre .deploy/deploy.lock, höchstens 90 min).
#   Ausgaben nur bei Zustandswechseln (journalctl -t quizmaster-healthcheck); Zustand in /var/lib/quizmaster.
#
#   pnpm ops:healthcheck [Optionen]
#     --env-file <datei>        Quelle der Ports (Standard .env.prod)
#     --alert-after-min <n>     Alarm nach n Minuten Störung (Standard 2)
#     --no-alert                Alarme nur loggen (Tests)
#   Nur Tests: --deploy-dir <verz> (Standard .deploy), QM_STATE_DIR=<verz>
set -Eeuo pipefail
umask 077
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_FILE="$QM_ROOT/.env.prod"
DEPLOY_DIR="$QM_ROOT/.deploy"
ALERT_AFTER_MIN=2
ALERT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file braucht eine Datei}"; shift 2 ;;
    --alert-after-min) ALERT_AFTER_MIN="${2:?--alert-after-min braucht eine Zahl}"; shift 2 ;;
    --deploy-dir) DEPLOY_DIR="${2:?--deploy-dir braucht ein Verzeichnis}"; shift 2 ;;
    --no-alert) ALERT=0; shift ;;
    -h | --help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) qm_die "unbekannte Option: $1 (--help)" ;;
  esac
done
[[ "$ALERT_AFTER_MIN" =~ ^[0-9]+$ ]] || qm_die "--alert-after-min: ganze Zahl ≥ 0"

notify() {
  if [ "$ALERT" = 1 ]; then qm_alert "$*"; else qm_warn "ALARM (nicht gesendet, --no-alert): $*"; fi
}

STATE=""
finish() {
  local code=$?
  set +e
  if [ "$code" -ne 0 ]; then
    qm_error "Health-Kontrolle selbst fehlgeschlagen (Exit $code)"
    # Höchstens ein Alarm pro Stunde, sonst käme jede Minute einer.
    local marker
    marker="$(qm_state_dir)/healthcheck-error.alerted"
    if [ ! -f "$marker" ] || [ -n "$(find "$marker" -mmin +60)" ]; then
      notify "Health-Kontrolle selbst fehlgeschlagen (Exit $code) – Ausfälle werden gerade NICHT erkannt;" \
        "journalctl -t quizmaster-healthcheck"
      : >"$marker"
    fi
  elif [ -n "$STATE" ]; then
    rm -f -- "$STATE/healthcheck-error.alerted"
  fi
  exit "$code"
}
trap finish EXIT

# Noch nie deployt: nichts zu prüfen.
[ -L "$DEPLOY_DIR/current" ] || exit 0
# Laufender Deploy/Rollback/Restart startet Apps absichtlich neu.
LOCK="$DEPLOY_DIR/deploy.lock"
if [ -f "$LOCK" ]; then
  lock_pid="$(sed -nE 's/.*"pid":([0-9]+).*/\1/p' "$LOCK" | head -n 1)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null && [ -n "$(find "$LOCK" -mmin -90)" ]; then exit 0; fi
fi

qm_require curl
NODE="$(qm_node)" || qm_die "Node 24 nicht gefunden (.deploy/runtime oder .tooling)"
qm_private_file "$ENV_FILE"
PORTS="$("$NODE" "$QM_ROOT/scripts/ops/ops-env.ts" ports --env-file "$ENV_FILE")"
qm_read_kv P_ <<<"$PORTS"
[[ "${P_WEB_PORT:-}" =~ ^[0-9]+$ ]] && [[ "${P_REALTIME_PORT:-}" =~ ^[0-9]+$ ]] || qm_die "Ports nicht lesbar"
STATE="$(qm_state_dir)"

# probe <app> <url>
probe() {
  local app="$1" url="$2" response code body since minutes
  local down="$STATE/health-$app.down" alerted="$STATE/health-$app.alerted"
  response="$(curl -s --max-time 5 -w '\n%{http_code}' "$url" 2>/dev/null || true)"
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code="000"
  if [ "$code" = 200 ] && [[ "$body" =~ \"ok\"[[:space:]]*:[[:space:]]*false ]]; then code="200 (ok: false)"; fi
  case "$code" in
    200 | 429)
      if [ -f "$alerted" ]; then
        since="$(cat "$down" 2>/dev/null || true)"
        minutes="?"
        if [[ "$since" =~ ^[0-9]+$ ]]; then minutes=$((($(date +%s) - since) / 60)); fi
        notify "Entwarnung: $app antwortet wieder (HTTP $code) nach etwa $minutes min Störung"
      elif [ -f "$down" ]; then
        qm_log "$app wieder erreichbar (HTTP $code) – kurze Störung ohne Alarm"
      fi
      rm -f -- "$down" "$alerted"
      ;;
    *)
      if [ ! -f "$down" ]; then
        date +%s >"$down"
        qm_warn "$app gestört (HTTP $code) – Alarm, falls das ${ALERT_AFTER_MIN} min anhält"
      fi
      since="$(cat "$down")"
      if ! [[ "$since" =~ ^[0-9]+$ ]]; then
        since="$(date +%s)"
        printf '%s\n' "$since" >"$down"
      fi
      minutes=$((($(date +%s) - since) / 60))
      if [ "$minutes" -ge "$ALERT_AFTER_MIN" ] && [ ! -f "$alerted" ]; then
        notify "$app gestört seit $minutes min (HTTP $code, $url) – pm2 status, pm2 logs $app --lines 100," \
          "pnpm deploy:status"
        : >"$alerted"
      fi
      ;;
  esac
}

probe quizmaster-web "http://127.0.0.1:$P_WEB_PORT/api/health"
probe quizmaster-realtime "http://127.0.0.1:$P_REALTIME_PORT/healthz"
