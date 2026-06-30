#!/usr/bin/env bash
set -euo pipefail

SANDBOX_NAME="${1:-hermes-runway}"

export PATH="$HOME/.local/bin:$PATH"
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use 22 >/dev/null 2>&1 || true
fi

exec_in_sandbox() {
  nemohermes "$SANDBOX_NAME" exec -- sh -lc "$1"
}

echo "[repair] inspecting gateway preload sources"
exec_in_sandbox 'set -e; SAFETY_TARGET=/tmp/nemoclaw-sandbox-safety-net.js; CIAO_TARGET=/tmp/nemoclaw-ciao-network-guard.js; [ -f "$SAFETY_TARGET" ] || printf "%s\n" "\"use strict\";" > "$SAFETY_TARGET"; [ -f "$CIAO_TARGET" ] || printf "%s\n" "\"use strict\";" > "$CIAO_TARGET"; chmod 444 "$SAFETY_TARGET" "$CIAO_TARGET"; chmod u+w /tmp/nemoclaw-proxy-env.sh; grep -q "nemoclaw-sandbox-safety-net" /tmp/nemoclaw-proxy-env.sh || printf "%s\n" "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $SAFETY_TARGET\"" >> /tmp/nemoclaw-proxy-env.sh; grep -q "nemoclaw-ciao-network-guard" /tmp/nemoclaw-proxy-env.sh || printf "%s\n" "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $CIAO_TARGET\"" >> /tmp/nemoclaw-proxy-env.sh; chmod 444 /tmp/nemoclaw-proxy-env.sh; echo "--- proxy env tail ---"; tail -n 8 /tmp/nemoclaw-proxy-env.sh; echo "--- target stat ---"; stat -c "%a %U:%G %n" /tmp/nemoclaw-proxy-env.sh "$SAFETY_TARGET" "$CIAO_TARGET";'

echo "[repair] recovering sandbox gateway"
nemohermes "$SANDBOX_NAME" recover

echo "[repair] sandbox status"
nemohermes "$SANDBOX_NAME" status
