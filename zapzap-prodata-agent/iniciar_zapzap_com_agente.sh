#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
  printf '%s\n' 'ZapZap nao esta com a porta 9222 aberta.'
  printf '%s\n' 'Abra o ZapZap manualmente com depuracao ativa e rode este script de novo.'
  exit 1
fi

python3 floating_agent.py
