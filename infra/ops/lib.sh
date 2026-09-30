# shellcheck shell=bash
# Gemeinsame Helfer für infra/ops/*.sh und infra/caddy/install-site.sh – wird mit `source` geladen.
# Grundsätze: Secrets nie auf der Kommandozeile, nie im Terminal, nie in Logs (docs/06, ADR-022);
# Node-Helfer (scripts/ops) lesen die Env-Dateien selbst mit dem Parser von @quizmaster/shared/env.

QM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
QM_BACKUP_ROOT="${QM_BACKUP_ROOT:-/root/backups/quizmaster}"
export QM_ROOT QM_BACKUP_ROOT

qm_ts() { date +%Y%m%d-%H%M%S; }

# Neues Sicherungsverzeichnis $QM_BACKUP_ROOT/<ts>/<art> (700); existiert es schon, mit PID-Suffix.
qm_backup_dir() {
  local stamp dir
  stamp="$(qm_ts)"
  dir="$QM_BACKUP_ROOT/$stamp/$1"
  if [ -e "$dir" ]; then dir="$QM_BACKUP_ROOT/$stamp-$$/$1"; fi
  install -d -m 700 "$(dirname "$dir")"
  install -d -m 700 "$dir"
  printf '%s\n' "$dir"
}

qm_log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
qm_warn() { printf '%s WARNUNG %s\n' "$(date '+%F %T')" "$*" >&2; }
qm_error() { printf '%s FEHLER %s\n' "$(date '+%F %T')" "$*" >&2; }
qm_die() {
  qm_error "$*"
  exit 1
}

# Pflichtwerkzeuge prüfen.
qm_require() {
  local bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null 2>&1 || qm_die "Werkzeug fehlt: $bin"
  done
}

# Node 24 für die Helfer: verifizierte Laufzeit des Deploys, sonst die Toolchain (.tooling, ADR-026).
qm_node() {
  local candidate
  for candidate in "${QM_NODE:-}" "$QM_ROOT/.deploy/runtime/node/bin/node" "$QM_ROOT/.tooling/node/bin/node"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    if [ "$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "24" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Datei muss existieren und darf nur für den Besitzer lesbar sein (600/400).
qm_private_file() {
  local file="$1" mode
  [ -f "$file" ] || qm_die "Datei fehlt: $file"
  mode="$(stat -c '%a' "$file")"
  case "$mode" in
    600 | 400) ;;
    *) qm_die "$file hat Rechte $mode – erwartet 600" ;;
  esac
}

# Entfernt Mongo-URIs (mit Zugangsdaten) aus Werkzeug-Ausgaben.
qm_sanitize() { sed -E 's#mongodb(\+srv)?://[^[:space:]"'"'"'`]*#mongodb://***#g'; }

# Schlüssel=Wert-Zeilen eines Helfers einlesen (ohne eval): qm_read_kv <präfix> < datei
# Setzt Variablen <präfix><SCHLÜSSEL> nur für Schlüssel aus [A-Z0-9_].
qm_read_kv() {
  local prefix="$1" line key value
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
    printf -v "${prefix}${key}" '%s' "$value"
  done
}

# Alarm (Discord/Slack-Webhook aus .env.prod); Fehler beim Zustellen nur loggen.
qm_alert() {
  bash "$QM_ROOT/infra/ops/alert.sh" "$@" || qm_warn "Alarm konnte nicht zugestellt werden"
}
