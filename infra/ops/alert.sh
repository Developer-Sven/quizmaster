#!/usr/bin/env bash
# Alarm von quizmaster: Nachricht an ALERT_WEBHOOK_URL aus .env.prod (Discord- und Slack-kompatibel:
# {"content": …, "text": …}); ohne URL nur Log. Die URL (enthält das Webhook-Token) wird nie ausgegeben.
#
#   pnpm ops:alert-test                         → "Testalarm von quizmaster"
#   bash infra/ops/alert.sh [--env-file <datei>] <nachricht …>
#
# Exit 0: zugestellt oder (ohne URL) nur geloggt · Exit 1: Zustellung fehlgeschlagen.
set -Eeuo pipefail
umask 077
# shellcheck source=infra/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_FILE="$QM_ROOT/.env.prod"
if [ "${1:-}" = "--env-file" ]; then
  ENV_FILE="${2:?--env-file braucht einen Pfad}"
  shift 2
fi
[ "${1:-}" = "--" ] && shift
MESSAGE="$*"
[ -n "$MESSAGE" ] || qm_die "Aufruf: alert.sh [--env-file <datei>] <nachricht …>"

# Immer ins Log (Journal), unabhängig vom Webhook.
qm_warn "ALARM $MESSAGE"
if command -v logger >/dev/null 2>&1; then
  logger -t quizmaster-alert -p user.warning -- "$MESSAGE" || true
fi

NODE="$(qm_node)" || qm_die "Node 24 nicht gefunden (.deploy/runtime oder .tooling) – Alarm nur im Log"
exec "$NODE" "$QM_ROOT/scripts/ops/alert.ts" --env-file "$ENV_FILE" -- "$MESSAGE"
