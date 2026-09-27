#!/bin/bash
set -e

echo "=== Instalando dependências do Node ==="
npm install

echo ""
echo "=== Instalando dependências Python do pipeline (MIT/BSD) ==="
pip install -r apps/api/requirements.txt

echo ""
echo "=== Verificando dependências de sistema ==="
MISSING=0

if ! command -v python3 &>/dev/null; then
  echo "[FALTA] python3"
  echo "  Instale com: sudo dnf install python3  # Fedora"
  echo "  Instale com: sudo apt install python3  # Ubuntu/Debian"
  MISSING=1
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "Instale os pacotes faltantes e rode este script novamente."
  exit 1
fi

echo ""
echo "=== Tudo pronto ==="
