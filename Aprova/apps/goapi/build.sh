#!/bin/sh
# Build do binário Mira Go (CGO: pdf_oxide estático + tesseract).
# Uso: ./build.sh   (gera ./mira-goapi enxuto, sem símbolos de debug)
set -e
cd "$(dirname "$0")"
if [ -z "$CGO_LDFLAGS" ]; then
  OXIDE="${PDF_OXIDE_DIR:-$HOME/.cache/pdf_oxide/v0.3.78}"
  export CGO_CFLAGS="-I$OXIDE/include"
  export CGO_LDFLAGS="$OXIDE/lib/linux_amd64/libpdf_oxide.a -lm -lpthread -ldl -lrt -lgcc_s -lutil -lc"
fi
go build -ldflags="-s -w" -o mira-goapi .
ls -la mira-goapi
