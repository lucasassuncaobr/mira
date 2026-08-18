#!/usr/bin/env bash
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
PYTHON_BIN="python3"
if [ -x ".venv-moondream/bin/python" ]; then
  PYTHON_BIN=".venv-moondream/bin/python"
fi
"$PYTHON_BIN" desktop_app.py
