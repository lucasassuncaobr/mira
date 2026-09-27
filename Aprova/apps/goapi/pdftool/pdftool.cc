// pdftool — extração vetorial + raster sobre PDFium (BSD-3-Clause).
// Substitui pdf_extract.py/pdf_render.py (Python) e poppler (GPL) no runtime.
//
//   pdftool extract <pdf>              → JSON {pages:[{number,width,height,text,words}]}
///  pdftool render <pdf> <dir> [--dpi 150] [--quality 75] [--format jpeg|png] [--prefix page]
//
// Coordenadas em pontos, origem no TOPO (mesmo contrato do pdf_extract.py:
// x0/yMin=top, x1/yMax=bottom), para o focus.ts/focus.go consumirem sem mudança.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "fpdfview.h"
#include "fpdf_text.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

namespace {

struct Word {
  double x0, top, x1, bottom;
  std::string text;  // UTF-8
};

void append_utf8(std::string& out, unsigned long cp) {
  if (cp < 0x80) {
    out += (char)cp;
  } else if (cp < 0x800) {
    out += (char)(0xC0 | (cp >> 6));
    out += (char)(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    out += (char)(0xE0 | (cp >> 12));
    out += (char)(0x80 | ((cp >> 6) & 0x3F));
    out += (char)(0x80 | (cp & 0x3F));
  } else {
    out += (char)(0xF0 | (cp >> 18));
    out += (char)(0x80 | ((cp >> 12) & 0x3F));
    out += (char)(0x80 | ((cp >> 6) & 0x3F));
    out += (char)(0x80 | (cp & 0x3F));
  }
}

std::string json_escape(const std::string& s) {
  std::string out;
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += (char)c;
        }
    }
  }
  return out;
}

// Agrupa caracteres em palavras (corte em espaço/controle ou gap largo) e
// palavras em linhas (tolerância vertical) — espelha pdf_extract.py.
std::vector<std::string> page_lines(FPDF_TEXTPAGE tp, double page_h,
                                    std::vector<Word>& words_out) {
  int n = FPDFText_CountChars(tp);
  struct Char {
    double x0, top, x1, bottom, h;
    std::string text;
    Char(double a, double b, double c, double d, double e, std::string f)
        : x0(a), top(b), x1(c), bottom(d), h(e), text(f) {}
  };
  std::vector<Char> chars;
  for (int i = 0; i < n; ++i) {
    unsigned long cp = FPDFText_GetUnicode(tp, i);
    if (cp == 0 || cp == '\r' || cp == '\n' || cp == '\t' || cp == '\f') continue;
    double l = 0, t = 0, r = 0, b = 0;
    if (!FPDFText_GetCharBox(tp, i, &l, &r, &b, &t)) continue;
    std::string s;
    append_utf8(s, cp);
    // PDFium: origem embaixo; converte para origem no topo.
    chars.push_back(Char(l, page_h - t, r, page_h - b, t - b, s));
  }
  // Linhas primeiro (corte em salto vertical: fim de linha nunca gruda
  // no início da próxima), depois palavras por gap horizontal.
  std::sort(chars.begin(), chars.end(), [](const Char& a, const Char& b) {
    if (fabs(a.top - b.top) > 1e-9) return a.top < b.top;
    return a.x0 < b.x0;
  });
  std::vector<double> hs;
  for (auto& c : chars) hs.push_back(c.bottom - c.top);
  std::sort(hs.begin(), hs.end());
  double median_h = hs.empty() ? 10.0 : hs[hs.size() / 2];
  double vtol = median_h * 0.6;
  if (vtol < 2.0) vtol = 2.0;
  std::vector<std::vector<Char>> raw_lines;
  for (auto& c : chars) {
    if (!raw_lines.empty() &&
        fabs(c.top - raw_lines.back()[0].top) <= vtol) {
      raw_lines.back().push_back(c);
    } else {
      raw_lines.push_back({c});
    }
  }
  // Palavras dentro de cada linha.
  std::vector<Word> words;
  for (auto& rl : raw_lines) {
    std::sort(rl.begin(), rl.end(),
              [](const Char& a, const Char& b) { return a.x0 < b.x0; });
    std::vector<Char> cur;
    auto flush_word = [&]() {
      if (cur.empty()) return;
      Word w{cur[0].x0, cur[0].top, cur[0].x1, cur[0].bottom, ""};
      for (auto& c : cur) {
        w.text += c.text;
        if (c.x0 < w.x0) w.x0 = c.x0;
        if (c.top < w.top) w.top = c.top;
        if (c.x1 > w.x1) w.x1 = c.x1;
        if (c.bottom > w.bottom) w.bottom = c.bottom;
      }
      if (!w.text.empty()) words.push_back(w);
      cur.clear();
    };
    for (auto& c : rl) {
      if (c.text == " ") {
        flush_word();
        continue;
      }
      if (!cur.empty()) {
        double gap = c.x0 - cur.back().x1;
        double h = cur.back().bottom - cur.back().top;
        double tol = h * 0.3;
        if (tol < 3.0) tol = 3.0;
        // Quebra também em mudança brusca de corpo (ex.: "PORTUGUESA|Texto").
        double size_jump = fabs(h - (c.bottom - c.top));
        if (gap > tol || size_jump > h * 0.35) flush_word();
      }
      cur.push_back(c);
    }
    flush_word();
  }
  for (auto& w : words) words_out.push_back(w);
  // Reagrupa as palavras em linhas para montar o texto (mesma tolerância).
  std::sort(words.begin(), words.end(), [](const Word& a, const Word& b) {
    if (fabs(a.top - b.top) > 1e-9) return a.top < b.top;
    return a.x0 < b.x0;
  });
  double tol = median_h * 0.6;
  if (tol < 2.0) tol = 2.0;
  std::vector<std::vector<Word>> lines;
  for (auto& w : words) {
    if (!lines.empty() && fabs(w.top - lines.back()[0].top) <= tol) {
      lines.back().push_back(w);
    } else {
      lines.push_back({w});
    }
  }
  std::vector<std::string> out;
  for (auto& ln : lines) {
    std::sort(ln.begin(), ln.end(),
              [](const Word& a, const Word& b) { return a.x0 < b.x0; });
    std::string s;
    for (auto& w : ln) {
      if (!s.empty()) s += " ";
      s += w.text;
    }
    out.push_back(s);
  }
  return out;
}

int cmd_extract(const char* pdf_path) {
  FPDF_LIBRARY_CONFIG config;
  config.version = 2;
  config.m_pUserFontPaths = nullptr;
  config.m_pIsolate = nullptr;
  config.m_v8EmbedderSlot = 0;
  FPDF_InitLibraryWithConfig(&config);
  FPDF_DOCUMENT doc = FPDF_LoadDocument(pdf_path, nullptr);
  if (!doc) {
    fprintf(stderr, "{\"error\": \"cannot open pdf\"}\n");
    FPDF_DestroyLibrary();
    return 1;
  }
  int count = FPDF_GetPageCount(doc);
  printf("{\"pages\": [");
  for (int i = 0; i < count; ++i) {
    FPDF_PAGE page = FPDF_LoadPage(doc, i);
    double w = 0, h = 0;
    FPDF_GetPageSizeByIndex(doc, i, &w, &h);
    std::vector<Word> words;
    std::vector<std::string> lines;
    FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
    if (tp) {
      lines = page_lines(tp, h, words);
      FPDFText_ClosePage(tp);
    }
    if (i > 0) printf(",");
    printf("{\"number\": %d, \"width\": %.2f, \"height\": %.2f, \"text\": \"",
           i + 1, w, h);
    for (size_t li = 0; li < lines.size(); ++li) {
      if (li > 0) printf("\\n");
      printf("%s", json_escape(lines[li]).c_str());
    }
    printf("\", \"words\": [");
    for (size_t wi = 0; wi < words.size(); ++wi) {
      if (wi > 0) printf(",");
      printf("{\"x0\": %.2f, \"top\": %.2f, \"x1\": %.2f, \"bottom\": %.2f, "
             "\"text\": \"%s\"}",
             words[wi].x0, words[wi].top, words[wi].x1, words[wi].bottom,
             json_escape(words[wi].text).c_str());
    }
    printf("]}");
    FPDF_ClosePage(page);
  }
  printf("]}\n");
  FPDF_CloseDocument(doc);
  FPDF_DestroyLibrary();
  return 0;
}

int cmd_render(int argc, char** argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: pdftool render <pdf> <out_dir> [--dpi 150] "
                    "[--quality 75] [--format jpeg|png] [--prefix page]\n");
    return 1;
  }
  const char* pdf_path = argv[2];
  const char* out_dir = argv[3];
  int dpi = 150, quality = 75;
  std::string fmt = "jpeg", prefix = "page";
  for (int i = 4; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--dpi" && i + 1 < argc) dpi = atoi(argv[++i]);
    else if (a == "--quality" && i + 1 < argc)
      quality = atoi(argv[++i]);
    else if (a == "--format" && i + 1 < argc)
      fmt = argv[++i];
    else if (a == "--prefix" && i + 1 < argc)
      prefix = argv[++i];
  }
  FPDF_LIBRARY_CONFIG config;
  config.version = 2;
  config.m_pUserFontPaths = nullptr;
  config.m_pIsolate = nullptr;
  config.m_v8EmbedderSlot = 0;
  FPDF_InitLibraryWithConfig(&config);
  FPDF_DOCUMENT doc = FPDF_LoadDocument(pdf_path, nullptr);
  if (!doc) {
    fprintf(stderr, "cannot open pdf\n");
    FPDF_DestroyLibrary();
    return 1;
  }
  char cmd[1024];
  snprintf(cmd, sizeof(cmd), "mkdir -p %s", out_dir);
  if (system(cmd) != 0) {
    fprintf(stderr, "cannot create out dir\n");
    FPDF_CloseDocument(doc);
    FPDF_DestroyLibrary();
    return 1;
  }
  double scale = dpi / 72.0;
  int count = FPDF_GetPageCount(doc);
  for (int i = 0; i < count; ++i) {
    FPDF_PAGE page = FPDF_LoadPage(doc, i);
    double w = 0, h = 0;
    FPDF_GetPageSizeByIndex(doc, i, &w, &h);
    int pw = (int)(w * scale + 0.5), ph = (int)(h * scale + 0.5);
    FPDF_BITMAP bmp = FPDFBitmap_CreateEx(pw, ph, FPDFBitmap_BGRx, nullptr, 0);
    if (!bmp) {
      FPDF_ClosePage(page);
      continue;
    }
    FPDFBitmap_FillRect(bmp, 0, 0, pw, ph, 0xFFFFFFFF);
    FS_MATRIX m{scale, 0, 0, scale, 0, 0};
    FS_RECTF clip{0, 0, (float)pw, (float)ph};
    FPDF_RenderPageBitmap(bmp, page, 0, 0, pw, ph, 0, 0);
    (void)m;
    (void)clip;
    const unsigned char* buf =
        (const unsigned char*)FPDFBitmap_GetBuffer(bmp);
    int stride = FPDFBitmap_GetStride(bmp);
    // BGRx -> RGB contíguo.
    std::vector<unsigned char> rgb((size_t)pw * ph * 3);
    for (int y = 0; y < ph; ++y) {
      const unsigned char* row = buf + (size_t)y * stride;
      for (int x = 0; x < pw; ++x) {
        rgb[((size_t)y * pw + x) * 3 + 0] = row[x * 4 + 2];
        rgb[((size_t)y * pw + x) * 3 + 1] = row[x * 4 + 1];
        rgb[((size_t)y * pw + x) * 3 + 2] = row[x * 4 + 0];
      }
    }
    char path[1024];
    if (fmt == "png") {
      snprintf(path, sizeof(path), "%s/%s-%02d.png", out_dir, prefix.c_str(),
               i + 1);
      stbi_write_png(path, pw, ph, 3, rgb.data(), pw * 3);
    } else {
      snprintf(path, sizeof(path), "%s/%s-%02d.jpg", out_dir, prefix.c_str(),
               i + 1);
      stbi_write_jpg(path, pw, ph, 3, rgb.data(), quality);
    }
    FPDFBitmap_Destroy(bmp);
    FPDF_ClosePage(page);
  }
  printf("{\"pages\": %d}\n", count);
  FPDF_CloseDocument(doc);
  FPDF_DestroyLibrary();
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc >= 2 && std::string(argv[1]) == "extract") {
    if (argc < 3) {
      fprintf(stderr, "usage: pdftool extract <pdf>\n");
      return 1;
    }
    // Desloca argv para reutilizar o parser de render se preciso.
    return cmd_extract(argv[2]);
  }
  if (argc >= 2 && std::string(argv[1]) == "render") {
    return cmd_render(argc, argv);
  }
  fprintf(stderr, "usage: pdftool {extract <pdf> | render <pdf> <dir> [...]}\n");
  return 1;
}
