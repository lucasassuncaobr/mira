#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi
if [ -f ".mimo_api_key" ]; then
  export MIMO_API_KEY="$(cat .mimo_api_key)"
fi
if [ -f ".deepseek_api_key" ]; then
  export DEEPSEEK_API_KEY="$(cat .deepseek_api_key)"
fi
if [ -f ".qwen_api_key" ]; then
  export QWEN_API_KEY="$(cat .qwen_api_key)"
fi

AGENT_LOG=/tmp/zapzap-inline-agent.log
PYTHON_BIN="python3"
if [ -x ".venv-moondream/bin/python" ]; then
  PYTHON_BIN=".venv-moondream/bin/python"
fi

pkill -f 'zapzap_inline_agent.py' >/dev/null 2>&1 || true

if ! curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
  printf '%s\n' 'ZapZap nao esta com a porta 9222 aberta.'
  printf '%s\n' 'Abra o ZapZap manualmente com depuracao ativa antes de iniciar o agente inline.'
  exit 1
fi

setsid "$PYTHON_BIN" zapzap_inline_agent.py >"$AGENT_LOG" 2>&1 &
exit 0
