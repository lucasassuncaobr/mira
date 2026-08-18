#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

flatpak kill com.rtosta.zapzap >/dev/null 2>&1 || true
pkill -f 'zapzap_inline_agent.py' >/dev/null 2>&1 || true
sleep 2
exec ./iniciar_inline.sh
