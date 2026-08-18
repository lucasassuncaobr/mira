#!/bin/bash
set -e

echo "=== Instalando dependências do Node ==="
npm install

echo ""
echo "=== Verificando dependências de sistema ==="
MISSING=0

if ! command -v pdftotext &>/dev/null; then
  echo "[FALTA] poppler-utils (pdftotext, pdftoppm)"
  echo "  Instale com: sudo dnf install poppler-utils  # Fedora"
  echo "  Instale com: sudo apt install poppler-utils  # Ubuntu/Debian"
  MISSING=1
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "Instale os pacotes faltantes e rode este script novamente."
  exit 1
fi

echo ""
echo "=== Tudo pronto ==="
echo "Para iniciar: npm run dev"
echo ""
echo "Web: http://localhost:5173"
echo "API: http://localhost:3333"
