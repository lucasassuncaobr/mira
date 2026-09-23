#!/usr/bin/env python3
"""
Fallback de coordenadas para PDFs escaneados — PaddleOCR (backend Python).

Uso:  python3 ocr_map.py <caminho_do_pdf>

A triagem vetorial (pdftotext -bbox) roda antes, no servidor Node. Este script
só é acionado quando o PDF é imagem pura (escaneado). Ele devolve no STDOUT um
JSON com a MESMA estrutura normalizada do mapa vetorial:

  [{"questao": 1, "pagina": 1, "y_inicio": 18.42, "x_centro": 31.7}, ...]

- y_inicio = porcentagem vertical do topo da linha da questão (0..100).
  NUNCA pixel fixo: o frontend multiplica pelo clientHeight em tempo de execução.
- PDFs digitais são tratados antes pelo caminho leve; aqui só entra o motor de IA.
- Qualquer falha sai com código != 0 e mensagem no STDERR (o chamador Node
  degrada silenciosamente para "sem metadado de foco").

Dependências (opcional):  pip install paddlepaddle paddleocr pdf2image
                          + poppler-utils (pdftoppm)
"""

import json
import os
import re
import sys

# Regex de início de questão: "01.", "01)", "Questão 02", "Q03 -"
QUESTION_RE = re.compile(r"^(?:quest[aã]o\s*)?(\d{1,3})\s*[.\-–):]", re.IGNORECASE)

# 150 DPI = mesma resolução das imagens JPEG servidas pelo backend.
RENDER_DPI = 150
JPEG_QUALITY = 95  # temporário local, não é artefato servido


def _box_of(item):
    """Extrai (x0, y0, x1, y1) de um item do PaddleOCR em qualquer formato comum."""
    if isinstance(item, dict):
        for key in ("text_region", "textRegion", "box", "bbox", "position"):
            region = item.get(key)
            if not region:
                continue
            # [[x0,y0],[x1,y1],...] (text_region) ou [x0,y0,x1,y1] (bbox)
            if region and isinstance(region[0], (list, tuple)):
                xs = [float(p[0]) for p in region]
                ys = [float(p[1]) for p in region]
                return min(xs), min(ys), max(xs), max(ys)
            if len(region) >= 4:
                return float(region[0]), float(region[1]), float(region[2]), float(region[3])
    return None


def _lines_of(block):
    """Lista [(texto, caixa)] de um bloco estrutural, no formato que o PPStructure devolver."""
    res = block.get("res") or []
    lines = []
    for line in res:
        if isinstance(line, dict):
            text = str(line.get("text", "")).strip()
            box = _box_of(line)
            if text:
                lines.append((text, box))
        elif isinstance(line, (list, tuple)) and line:
            # Formato legado: [text, score, box]
            text = str(line[0]).strip()
            box = _box_of({"box": line[2]}) if len(line) > 2 else None
            if text:
                lines.append((text, box))
    if not lines and block.get("type") == "text":
        # Sem linha utilizável: usa a caixa do bloco inteiro.
        text = str(block.get("text", "")).strip() or " ".join(str(v) for v in res if isinstance(v, str))
        box = _box_of(block)
        if text and box:
            lines.append((text, box))
    return lines


def extrair_coordenadas(pdf_path):
    try:
        import fitz  # PyMuPDF — triagem vetorial instantânea (sem IA)
    except ImportError:
        fitz = None
    from paddleocr import PPStructure
    from pdf2image import convert_from_path

    mapa = {}

    # ------------------------------------------------------------------
    # 1) TRIAGEM VETORIAL LEVE (PDF digital) — mesmo caminho do Node, aqui
    #    serve para o script também funcionar sozinho no terminal.
    # ------------------------------------------------------------------
    if fitz is not None:
        doc = fitz.open(pdf_path)
        for num_pag, pagina in enumerate(doc, start=1):
            altura = pagina.rect.height
            for bloco in pagina.get_text("blocks"):
                texto = str(bloco[4]).strip()
                match = re.match(r"^(?:quest[aã]o\s*)?(\d{1,3})[.\s\)-]", texto, re.IGNORECASE)
                if match:
                    numero = int(match.group(1))
                    if numero not in mapa:
                        mapa[numero] = {
                            "questao": numero,
                            "pagina": num_pag,
                            "y_inicio": round((bloco[1] / altura) * 100, 2),
                            "x_centro": round(((bloco[0] + bloco[2]) / 2 / pagina.rect.width) * 100, 2),
                        }
        doc.close()

    # ------------------------------------------------------------------
    # 2) PDF ESCANEADO (imagem pura) → PPStructure (layout + OCR, lang='por')
    # ------------------------------------------------------------------
    if not mapa:
        print("[AVISO] PDF escaneado detectado. Iniciando motor PaddleOCR...", file=sys.stderr)
        ocr = PPStructure(lang="por", layout=True, show_log=False)
        paginas = convert_from_path(pdf_path, dpi=RENDER_DPI)

        for num_pag, img in enumerate(paginas, start=1):
            temp_path = f"temp_pag_{num_pag}.jpg"
            try:
                img.save(temp_path, "JPEG", quality=JPEG_QUALITY)
                altura_img = float(img.height)
                largura_img = float(img.width)
                resultado = ocr(temp_path)

                for bloco in resultado:
                    for texto, caixa in _lines_of(bloco):
                        match_ocr = QUESTION_RE.match(texto)
                        if not match_ocr:
                            continue
                        numero = int(match_ocr.group(1))
                        if numero in mapa:
                            break
                        if caixa is None:
                            caixa = _box_of(bloco)
                        if caixa is None:
                            continue
                        x0, y0, x1, _y1 = caixa
                        mapa[numero] = {
                            "questao": numero,
                            "pagina": num_pag,
                            "y_inicio": round(max(0.0, min(100.0, (y0 / altura_img) * 100)), 2),
                            "x_centro": round(max(0.0, min(100.0, (((x0 + x1) / 2) / largura_img) * 100)), 2),
                        }
                        break
            finally:
                if os.path.exists(temp_path):
                    os.remove(temp_path)

    return sorted(mapa.values(), key=lambda item: item["questao"])


def main():
    if len(sys.argv) != 2:
        print("uso: ocr_map.py <pdf>", file=sys.stderr)
        return 2
    try:
        resultado = extrair_coordenadas(sys.argv[1])
    except Exception as error:  # noqa: BLE001 — degradação graciosa chamada pelo Node
        print(f"[ERRO] PaddleOCR: {error}", file=sys.stderr)
        return 1
    json.dump(resultado, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
