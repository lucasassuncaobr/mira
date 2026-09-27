#!/usr/bin/env python3
"""
Render de paginas PDF para JPEG — pypdfium2 (BSD-3-Clause/Apache-2.0).

Uso:
  python3 pdf_render.py <pdf> <dir_saida> [--dpi 150] [--quality 75]

Gera <dir_saida>/page-NN.jpg (NN com zero-pad de 2 digitos), mesmo contrato
do `pdftoppm -jpeg -r 150 -jpegopt quality=75 <pdf> <dir>/page`.

Substitui o poppler-utils (GPL) no pipeline: apos esta troca nenhum
componente GPL/AGPL permanece no runtime do projeto.
"""

import os
import sys

from PIL import Image


def parse_args(argv):
    pdf_path = argv[1]
    out_dir = argv[2]
    dpi = 150
    quality = 75
    i = 3
    while i < len(argv):
        if argv[i] == "--dpi" and i + 1 < len(argv):
            dpi = int(argv[i + 1])
            i += 2
        elif argv[i] == "--quality" and i + 1 < len(argv):
            quality = int(argv[i + 1])
            i += 2
        else:
            i += 1
    return pdf_path, out_dir, dpi, quality


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: pdf_render.py <pdf> <out_dir> [--dpi 150] [--quality 75]", file=sys.stderr)
        return 1
    try:
        import pypdfium2 as pdfium
    except ImportError:
        print("pypdfium2 not installed", file=sys.stderr)
        return 1
    pdf_path, out_dir, dpi, quality = parse_args(sys.argv)
    try:
        os.makedirs(out_dir, exist_ok=True)
        pdf = pdfium.PdfDocument(pdf_path)
        scale = dpi / 72
        for i in range(len(pdf)):
            bitmap = pdf[i].render(scale=scale)
            pil = bitmap.to_pil()
            if pil.mode in ("RGBA", "LA", "PA"):
                background = Image.new("RGB", pil.size, (255, 255, 255))
                background.paste(pil, mask=pil.split()[-1])
                pil = background
            elif pil.mode != "RGB":
                pil = pil.convert("RGB")
            pil.save(os.path.join(out_dir, "page-%02d.jpg" % (i + 1)), format="JPEG", quality=quality)
        print("{\"pages\": %d}" % len(pdf))
        return 0
    except Exception as e:
        print("pdf_render failed: %s" % str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
