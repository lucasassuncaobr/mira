#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ -f ".mimo_api_key" ]; then
  export MIMO_API_KEY="$(cat .mimo_api_key)"
fi
export LOCAL_QWEN_RESPONSE_ENABLED=0
export LOCAL_QWEN_TRIAGE_ENABLED=0
export MIMO_FINAL_WAIT_SECONDS="${MIMO_FINAL_WAIT_SECONDS:-18}"
export QWEN_ENABLED="${QWEN_ENABLED:-1}"
export PRODATA_AUTO_SUGGEST_ENABLED=1

APP_LOG=/tmp/zapzap-inline-app.log
AGENT_LOG=/tmp/zapzap-inline-agent.log
PYTHON_BIN=python3

pkill -f 'zapzap_inline_agent.py' >/dev/null 2>&1 || true

if ! curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
  flatpak kill com.rtosta.zapzap >/dev/null 2>&1 || true
  sleep 2
  setsid flatpak run --env=QTWEBENGINE_REMOTE_DEBUGGING=9222 com.rtosta.zapzap >"$APP_LOG" 2>&1 &
  for _ in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
  printf '%s\n' 'Nao consegui abrir a porta 9222 do ZapZap.'
  printf '%s\n' "Confira $APP_LOG."
  exit 1
fi

setsid "$PYTHON_BIN" zapzap_inline_agent.py >"$AGENT_LOG" 2>&1 &
exit 0
