#!/usr/bin/env bash
set -euo pipefail

SANDBOX_NAME="${1:-hermes-runway}"
PROMPT="${2:-Reply with the word ok}"

export PATH="$HOME/.local/bin:$PATH"
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use 22 >/dev/null 2>&1 || true
fi

PROMPT_JSON="$(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"

CONTAINER_NAME="$(docker ps --filter "label=openshell.ai/sandbox-name=${SANDBOX_NAME}" --format '{{.Names}}' | head -n 1)"
if [ -z "$CONTAINER_NAME" ]; then
  echo "running OpenShell container not found for sandbox '${SANDBOX_NAME}'" >&2
  exit 1
fi

GATEWAY_PID="$(
  docker exec \
    -u sandbox \
    -e HOME=/sandbox \
    -e HERMES_HOME=/sandbox/.hermes \
    "$CONTAINER_NAME" \
    sh -lc "ps -ef | awk '/[h]ermes gateway run/ { print \$2; exit }'"
)"
if [ -z "$GATEWAY_PID" ]; then
  echo "Hermes gateway PID not found in sandbox '${SANDBOX_NAME}'" >&2
  exit 1
fi

docker exec \
  "$CONTAINER_NAME" \
  sh -lc "printf '%s' '{\"model\":\"hermes-agent\",\"messages\":[{\"role\":\"user\",\"content\":$PROMPT_JSON}],\"stream\":false}' > /sandbox/hermes-probe.json; nsenter -t '$GATEWAY_PID' -n curl -sS http://127.0.0.1:18642/v1/chat/completions -H 'Content-Type: application/json' --data @/sandbox/hermes-probe.json"
