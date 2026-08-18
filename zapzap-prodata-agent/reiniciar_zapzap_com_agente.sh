#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

pkill -f 'floating_agent.py' >/dev/null 2>&1 || true
sleep 1
exec ./iniciar_zapzap_com_agente.sh
