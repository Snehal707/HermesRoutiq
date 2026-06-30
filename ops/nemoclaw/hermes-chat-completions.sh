#!/usr/bin/env bash
set -euo pipefail

SANDBOX_NAME="${1:?sandbox name required}"
PAYLOAD_B64="${2:?payload base64 required}"

export PATH="$HOME/.local/bin:$PATH"
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use 22 >/dev/null 2>&1 || true
fi

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
  sh -lc "python3 -c \"import base64; open('/sandbox/hermes-request.json','wb').write(base64.b64decode('$PAYLOAD_B64'))\"; nsenter -t '$GATEWAY_PID' -n curl -sS --max-time 135 http://127.0.0.1:18642/v1/chat/completions -H 'Content-Type: application/json' --data @/sandbox/hermes-request.json"
