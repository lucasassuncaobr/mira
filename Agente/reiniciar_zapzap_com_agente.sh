#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

flatpak kill com.rtosta.zapzap >/dev/null 2>&1 || true
sleep 2
setsid flatpak run --env=QTWEBENGINE_REMOTE_DEBUGGING=9222 com.rtosta.zapzap >/tmp/zapzap-agent.log 2>&1 &

for _ in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
    exec python3 floating_agent.py
  fi
  sleep 1
done

printf '%s\n' 'Nao consegui abrir a porta 9222 do ZapZap.'
printf '%s\n' 'Confira /tmp/zapzap-agent.log.'
exit 1
