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


def group_lines(raw_words):
    """Agrupa palavras em linhas pela proximidade vertical (top).

    Em layout 2-colunas, linhas das duas colunas têm o mesmo top e são
    fundidas aqui de propósito — a separação acontece por gap em
    split_line_fragments()."""
    if not raw_words:
        return []
    ordered = sorted(raw_words, key=lambda w: (w["top"], w["x0"]))
    heights = sorted(w["bottom"] - w["top"] for w in ordered)
    median_h = heights[len(heights) // 2] if heights else 10
    tol = max(2.0, median_h * 0.6)
    lines = []
    for w in ordered:
        if lines and abs(w["top"] - lines[-1][0]["top"]) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
    for line in lines:
        line.sort(key=lambda w: w["x0"])
    return lines


def split_line_fragments(line, min_gap=40):
    """Quebra a linha nos gaps largos (sarjeta entre colunas)."""
    frags, current = [], [line[0]]
    for prev, word in zip(line, line[1:]):
        if word["x0"] - prev["x1"] > min_gap:
            frags.append(current)
            current = [word]
        else:
            current.append(word)
    frags.append(current)
    return frags


def find_gutter(raw_words, page_width, page_height):
    """Sarjeta global: x (entre 35% e 65% da largura) atravessado pelo menor
    número de palavras, com a faixa ao redor majoritariamente vazia.
    Retorna o x ou None (página de 1 coluna)."""
    if len(raw_words) < 20:
        return None
    best, best_score = None, None
    x = page_width * 0.35
    while x <= page_width * 0.65:
        straddle = sum(1 for w in raw_words if w["x0"] < x < w["x1"])
        left = any(w["x1"] <= x for w in raw_words)
        right = any(w["x0"] >= x for w in raw_words)
        if left and right and (best_score is None or straddle < best_score):
            best, best_score = x, straddle
        x += 5
    if best is None:
        return None
    # Valida: a faixa de 24pt ao redor deve estar quase vazia (cabeçalhos
    # full-width esporádicos são tolerados até 25% da altura).
    band_y = sum(min(w["bottom"], page_height) - max(w["top"], 0)
                 for w in raw_words if w["x0"] < best - 12 and w["x1"] > best + 12)
    if band_y > page_height * 0.25:
        return None
    return best


def ordered_text(words):
    return " ".join(w["text"] for w in sorted(words, key=lambda w: w["x0"]))


def reading_order_text(lines, gutter, page_height):
    """Emite cabeçalho, coluna esquerda, meio, coluna direita, rodapé.

    Cada fragmento é CORTADO NA SARJETA: palavras à esquerda vão para a
    coluna esquerda, à direita para a direita — mesmo quando dividem a
    mesma linha visual (ex.: cauda da questão anterior + "QUESTÃO 8").
    Só fragmentos que atravessam a sarjeta sem corte limpo (faixas
    full-width de verdade) vão para cabeçalho (<12%), rodapé (>90%) ou meio.
    """
    if gutter is None:
        return "\n".join(" ".join(w["text"] for w in line) for line in lines)
    header, left, middle, right, footer = [], [], [], [], []
    for line in lines:
        for frag in split_line_fragments(line):
            lpart = [w for w in frag if w["x1"] <= gutter + 2]
            rpart = [w for w in frag if w["x0"] >= gutter - 2]
            in_both = [w for w in frag if w not in lpart and w not in rpart]
            if in_both and not lpart and not rpart:
                # Faixa full-width de verdade (cabeçalho/rodapé/seção).
                text = ordered_text(frag)
                top = min(w["top"] for w in frag)
                if top < page_height * 0.12:
                    header.append(text)
                elif top > page_height * 0.90:
                    footer.append(text)
                else:
                    middle.append(text)
                continue
            left_side = lpart + [w for w in in_both if (w["x0"] + w["x1"]) / 2 <= gutter]
            right_side = rpart + [w for w in in_both if (w["x0"] + w["x1"]) / 2 > gutter]
            if left_side:
                left.append(ordered_text(left_side))
            if right_side:
                right.append(ordered_text(right_side))
    return "\n".join(header + left + middle + right + footer)


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
                raw = []
                try:
                    for w in page.extract_words() or []:
                        t = (w.get("text") or "").strip()
                        if t:
                            raw.append({"x0": float(w["x0"]), "top": float(w["top"]),
                                        "x1": float(w["x1"]), "bottom": float(w["bottom"]),
                                        "text": t})
                except Exception:
                    raw = []
                lines = group_lines(raw)
                gutter = find_gutter(raw, float(page.width), float(page.height))
                text = reading_order_text(lines, gutter, float(page.height))
                words = [{"x0": round(w["x0"], 2), "top": round(w["top"], 2),
                          "x1": round(w["x1"], 2), "bottom": round(w["bottom"], 2),
                          "text": w["text"]} for w in raw]
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
