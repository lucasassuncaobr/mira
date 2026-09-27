#!/usr/bin/env python3
"""
Extracao vetorial de texto + geometria — pdfplumber (MIT) + pdfminer.six (MIT).

Uso:
  python3 pdf_extract.py <caminho_do_pdf>

Saida no STDOUT (JSON):
  {"pages": [{"number": 1, "width": 595.4, "height": 841.9,
              "text": "...", "words": [{"x0":..,"top":..,"x1":..,"bottom":..,"text":".."}]}]}

Contrato com o Node:
- text usa "\\n" entre linhas e "\\f" entre paginas (igual ao `pdftotext -raw`),
  para o parser.ts continuar montando [[PAGE:N]] sem mudanca.
- words usam origem no topo (top/bottom), mesma orientacao do `pdftotext -bbox`
  que o focus.ts consome (yMin=top, yMax=bottom).
- Falha sai com codigo != 0 e mensagem no STDERR (o chamador Node cai no
  fallback seguinte: pdf-parse, depois OCR).
"""

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing pdf path argument"}), file=sys.stderr)
        return 1
    try:
        import pdfplumber
    except ImportError:
        print(json.dumps({"error": "pdfplumber not installed"}), file=sys.stderr)
        return 1
    try:
        out_pages = []
        with pdfplumber.open(sys.argv[1]) as pdf:
            for i, page in enumerate(pdf.pages, start=1):
                text = page.extract_text() or ""
                words = []
                try:
                    for w in page.extract_words() or []:
                        t = (w.get("text") or "").strip()
                        if not t:
                            continue
                        words.append({
                            "x0": round(float(w["x0"]), 2),
                            "top": round(float(w["top"]), 2),
                            "x1": round(float(w["x1"]), 2),
                            "bottom": round(float(w["bottom"]), 2),
                            "text": t,
                        })
                except Exception:
                    words = []
                out_pages.append({
                    "number": i,
                    "width": round(float(page.width), 2),
                    "height": round(float(page.height), 2),
                    "text": text,
                    "words": words,
                })
        print(json.dumps({"pages": out_pages}))
        return 0
    except Exception as e:
        print(json.dumps({"error": "pdf_extract failed: %s" % str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
