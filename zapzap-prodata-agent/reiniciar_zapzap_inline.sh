#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

pkill -f 'zapzap_inline_agent.py' >/dev/null 2>&1 || true
sleep 2
exec ./iniciar_inline.sh
