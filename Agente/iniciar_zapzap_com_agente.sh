#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
  if flatpak ps --columns=application | grep -q '^com.rtosta.zapzap$'; then
    printf '%s\n' 'ZapZap ja esta aberto sem o agente.'
    printf '%s\n' 'Feche o ZapZap completamente e rode este script de novo, ou use:'
    printf '%s\n' './reiniciar_zapzap_com_agente.sh'
    exit 1
  fi
  setsid flatpak run --env=QTWEBENGINE_REMOTE_DEBUGGING=9222 com.rtosta.zapzap >/tmp/zapzap-agent.log 2>&1 &
  for _ in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

python3 floating_agent.py
