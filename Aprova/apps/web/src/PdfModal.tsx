import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Expand,
  Minimize,
  Minus,
  Plus,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  API,
  extractExamText,
  fetchExamInfo,
  fetchPageText,
  prefetchExamPdf,
  type TextLine,
} from "./pdf-cache";

import "./pdf-modal.css";

type RedactMark = {
  id: string;
  page: number;
  /** Coordenadas normalizadas (0..1) — independentes de zoom. */
  x: number;
  y: number;
  w: number;
  h: number;
};

type PdfModalProps = {
  examId: number;
  title: string;
  onClose: () => void;
};

function storageKey(examId: number) {
  return `mira:redactions:${examId}`;
}

function loadMarks(examId: number): RedactMark[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(examId)) ?? "[]") as RedactMark[];
    return Array.isArray(raw) ? raw.filter((m) => m && typeof m.page === "number") : [];
  } catch {
    return [];
  }
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function PdfModal({ examId, title, onClose }: PdfModalProps) {
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [marks, setMarks] = useState<RedactMark[]>(() => loadMarks(examId));
  const [redactMode, setRedactMode] = useState(false);
  const [draft, setDraft] = useState<(RedactMark & { id: "" }) | null>(null);
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<number[]>([]);
  const [textLayers, setTextLayers] = useState<Map<number, TextLine[]>>(new Map());
  const [exporting, setExporting] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const drawing = useRef<{ page: number; x0: number; y0: number } | null>(null);
  const examRef = useRef(examId);
  examRef.current = examId;

  const pages = useMemo(() => (totalPages ? Array.from({ length: totalPages }, (_, i) => i + 1) : []), [totalPages]);

  // Fecha com Escape; trava o scroll da página de fundo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const step = scroller.clientHeight * 0.9;
      if (event.key === "PageDown" || event.key === "ArrowDown") {
        event.preventDefault();
        scroller.scrollBy({ top: event.key === "PageDown" ? step : 120, behavior: "smooth" });
      } else if (event.key === "PageUp" || event.key === "ArrowUp") {
        event.preventDefault();
        scroller.scrollBy({ top: event.key === "PageUp" ? -step : -120, behavior: "smooth" });
      } else if (event.key === "Home") {
        event.preventDefault();
        scroller.scrollTo({ top: 0, behavior: "smooth" });
      } else if (event.key === "End") {
        event.preventDefault();
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Info (nº de páginas) + bytes (exportação/busca) em background.
  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    setTotalPages(null);
    fetchExamInfo(examId).then(
      ({ pages: count }) => {
        if (!cancelled) setTotalPages(count);
      },
      () => {
        if (!cancelled) setLoadError("Não foi possível carregar as páginas da prova.");
      }
    );
    prefetchExamPdf(examId).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [examId]);

  // Persiste as tarjas por prova.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(examId), JSON.stringify(marks));
    } catch {
      /* armazenamento indisponível */
    }
  }, [marks, examId]);

  // Página atual via IntersectionObserver.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !pages.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { page: number; ratio: number } | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (!best || entry.intersectionRatio > best.ratio) best = { page, ratio: entry.intersectionRatio };
        }
        if (best) setCurrent(best.page);
      },
      { root: scroller, threshold: [0.25, 0.5, 0.75] }
    );
    for (const n of pages) {
      const el = pageEls.current.get(n);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [pages]);

  const setPageEl = useCallback(
    (n: number) => (el: HTMLDivElement | null) => {
      if (el) pageEls.current.set(n, el);
      else pageEls.current.delete(n);
    },
    []
  );

  const scrollToPage = useCallback((n: number) => {
    pageEls.current.get(n)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await backdropRef.current?.requestFullscreen();
      }
    } catch {
      const maximized =
        backdropRef.current?.querySelector(".pdf-modal")?.classList.toggle("pdf-modal-maximized") ?? false;
      setIsFullscreen(maximized);
    }
  }, []);

  const changeZoom = useCallback((delta: number) => {
    setZoom((z) => Math.min(3, Math.max(0.5, Number((z + delta).toFixed(2)))));
  }, []);

  // --- Tarja: desenho sobre a página (coordenadas normalizadas) ---
  const pointOf = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const onPageDown = (n: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (!redactMode || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = pointOf(event);
    drawing.current = { page: n, x0: p.x, y0: p.y };
    setDraft({ id: "", page: n, x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPageMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drawing.current;
    if (!d) return;
    const p = pointOf(event);
    setDraft({
      id: "",
      page: d.page,
      x: Math.min(d.x0, p.x),
      y: Math.min(d.y0, p.y),
      w: Math.abs(p.x - d.x0),
      h: Math.abs(p.y - d.y0),
    });
  };

  const onPageUp = () => {
    const d = drawing.current;
    const rect = draft;
    drawing.current = null;
    setDraft(null);
    if (!d || !rect || rect.w < 0.008 || rect.h < 0.008) return;
    setMarks((list) => [
      ...list,
      {
        id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        page: d.page,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
      },
    ]);
  };

  const clearMarks = useCallback(() => {
    if (!marks.length) return;
    if (window.confirm(`Remover as ${marks.length} tarjas desta prova?`)) setMarks([]);
  }, [marks.length]);

  // --- Exportar PDF com tarjas queimadas (pdf-lib) ---
  const exportRedacted = useCallback(async () => {
    if (!marks.length || exporting) return;
    setExporting(true);
    try {
      const { PDFDocument, rgb } = await import("pdf-lib");
      const pdf = await PDFDocument.load((await prefetchExamPdf(examRef.current)).slice(0));
      for (const m of marks) {
        if (m.page < 1 || m.page > pdf.getPageCount()) continue;
        const pg = pdf.getPage(m.page - 1);
        const { width, height } = pg.getSize();
        pg.drawRectangle({
          x: m.x * width,
          y: (1 - m.y - m.h) * height,
          width: m.w * width,
          height: m.h * height,
          color: rgb(0, 0, 0),
          opacity: 1,
        });
      }
      const out = await pdf.save();
      const blob = new Blob([out.slice()], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `prova-${examRef.current}-tarjado.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      window.alert("Não foi possível exportar o PDF com as tarjas.");
    } finally {
      setExporting(false);
    }
  }, [marks, exporting]);

  // --- Busca textual (pdf.js, sob demanda) ---
  const runSearch = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      const term = query.trim().toLowerCase();
      if (!term) {
        setHits([]);
        return;
      }
      setSearching(true);
      try {
        const texts = await extractExamText(examId);
        const found = texts.map((t, i) => (t.toLowerCase().includes(term) ? i + 1 : -1)).filter((n) => n > 0);
        setHits(found);
        if (found[0]) scrollToPage(found[0]);
      } catch {
        window.alert("Não foi possível buscar no PDF agora.");
      } finally {
        setSearching(false);
      }
    },
    [query, examId, scrollToPage]
  );

  const marksByPage = useMemo(() => {
    const map = new Map<number, RedactMark[]>();
    for (const m of marks) {
      const list = map.get(m.page) ?? [];
      list.push(m);
      map.set(m.page, list);
    }
    return map;
  }, [marks]);

  // Portal para document.body: escapa de qualquer contexto de empilhamento
  // ancestral (coluna do PDF, workspace) para o backdrop/modal ficarem acima
  // de tudo — inclusive do relógio da prova.
  return createPortal(
    <div ref={backdropRef} className="pdf-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={`PDF: ${title}`}>
      <div className="pdf-modal pdf-modal-embed" onClick={(event) => event.stopPropagation()}>
        <header className="pdf-modal-toolbar">
          <div className="pdf-modal-title">
            <strong>{title}</strong>
            <span>Página inteira • PDF original</span>
          </div>
          <div className="pdf-modal-controls">
            <button
              aria-label={isFullscreen ? "Sair da tela cheia" : "Expandir para tela cheia"}
              title={isFullscreen ? "Sair da tela cheia" : "Expandir para tela cheia"}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? <Minimize size={17} /> : <Expand size={17} />}
            </button>
            <button className="pdf-modal-close" aria-label="Fechar PDF" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="pdf-reader-bar">
          <div className="pdf-reader-group">
            <button aria-label="Página anterior" title="Página anterior" onClick={() => scrollToPage(Math.max(1, current - 1))} disabled={current <= 1}>
              <ChevronLeft size={17} />
            </button>
            <span className="pdf-reader-counter">
              {totalPages ? `${current} de ${totalPages}` : "…"}
            </span>
            <button aria-label="Próxima página" title="Próxima página" onClick={() => scrollToPage(Math.min(totalPages ?? 1, current + 1))} disabled={!totalPages || current >= totalPages}>
              <ChevronRight size={17} />
            </button>
          </div>
          <i className="pdf-reader-sep" />
          <div className="pdf-reader-group">
            <button aria-label="Reduzir zoom" title="Reduzir zoom" onClick={() => changeZoom(-0.25)}>
              <Minus size={17} />
            </button>
            <button className="pdf-reader-zoom" title="Ajustar à largura" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button aria-label="Aumentar zoom" title="Aumentar zoom" onClick={() => changeZoom(0.25)}>
              <Plus size={17} />
            </button>
          </div>
          <i className="pdf-reader-sep" />
          <form className="pdf-reader-search" onSubmit={runSearch}>
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar no PDF…"
              aria-label="Buscar no PDF"
            />
          </form>
          <div className="pdf-reader-group">
            <button
              className={redactMode ? "is-active" : ""}
              aria-label="Tarjar trechos"
              title="Tarjar trechos (arraste sobre a página)"
              onClick={() => setRedactMode((v) => !v)}
            >
              <Square size={17} />
              <span>Tarjar{marks.length ? ` (${marks.length})` : ""}</span>
            </button>
            {marks.length > 0 && (
              <button aria-label="Remover tarjas" title="Remover todas as tarjas" onClick={clearMarks}>
                <Trash2 size={17} />
              </button>
            )}
            <button
              aria-label="Exportar PDF com tarjas"
              title={marks.length ? "Baixar PDF com as tarjas aplicadas" : "Marque tarjas para exportar"}
              onClick={exportRedacted}
              disabled={!marks.length || exporting}
            >
              <Download size={17} />
              <span>{exporting ? "Exportando…" : "Exportar"}</span>
            </button>
          </div>
        </div>
        {searching && <div className="pdf-reader-note">Buscando no documento…</div>}
        {!searching && hits.length > 0 && (
          <div className="pdf-reader-note">
            <span>
              {hits.length === 1 ? "Encontrado na página" : `Encontrado em ${hits.length} páginas`}:
            </span>
            {hits.map((n) => (
              <button key={n} className="pdf-chip" onClick={() => scrollToPage(n)}>
                {n}
              </button>
            ))}
            <button className="pdf-chip pdf-chip-clear" onClick={() => setHits([])} aria-label="Limpar busca">
              <X size={13} />
            </button>
          </div>
        )}

        <div ref={scrollerRef} className="pdf-modal-body pdf-modal-embed-body pdf-reader-scroll">
          {loadError ? (
            <div className="pdf-modal-error">
              {loadError}{" "}
              <button
                className="pdf-modal-retry"
                onClick={() => {
                  setLoadError("");
                  setTotalPages(null);
                  fetchExamInfo(examId).then(
                    ({ pages: count }) => setTotalPages(count),
                    () => setLoadError("Não foi possível carregar as páginas da prova.")
                  );
                }}
              >
                Tentar de novo
              </button>
            </div>
          ) : !totalPages ? (
            <div className="pdf-modal-loading">Carregando páginas…</div>
          ) : (
            <div className="pdf-reader-pages" style={{ width: `${zoom * 100}%` }}>
              {pages.map((n) => (
                <div
                  key={n}
                  ref={setPageEl(n)}
                  data-page={n}
                  className={`pdf-reader-page${redactMode ? " is-marking" : ""}`}
                  onPointerDown={onPageDown(n)}
                  onPointerMove={onPageMove}
                  onPointerUp={onPageUp}
                  onPointerCancel={onPageUp}
                >
                  {failedPages.has(n) ? (
                    <div className="pdf-page-failed">
                      <span>Página {n} indisponível</span>
                    </div>
                  ) : (
                    <img
                      src={`${API}/exams/${examId}/pages/${n}`}
                      alt={`Página ${n} do PDF original`}
                      draggable={false}
                      loading={n <= 3 ? "eager" : "lazy"}
                      decoding="async"
                      onLoad={(event) => {
                        const img = event.currentTarget;
                        img.classList.add("is-loaded");
                        const box = img.closest(".pdf-reader-page") as HTMLDivElement | null;
                        if (img.naturalWidth) {
                          box?.style.setProperty("--ar", String(img.naturalHeight / img.naturalWidth));
                        }
                        fetchPageText(examId, n).then(
                          ({ lines }) => setTextLayers((m) => new Map(m).set(n, lines)),
                          () => undefined
                        );
                      }}
                      onError={() => setFailedPages((s) => new Set(s).add(n))}
                    />
                  )}
                  {!redactMode &&
                    (textLayers.get(n) ?? []).map((line, i) => (
                      <span
                        key={i}
                        className="pdf-textline"
                        style={{
                          left: `${line.x * 100}%`,
                          top: `${line.y * 100}%`,
                          width: `${line.w * 100}%`,
                          height: `${line.h * 100}%`,
                          fontSize: `calc(${line.h} * var(--ar, 1.414) * 100cqw)`,
                        }}
                      >
                        {line.text}{" "}
                      </span>
                    ))}
                  {(marksByPage.get(n) ?? []).map((m) => (
                    <span
                      key={m.id}
                      className="pdf-mark"
                      style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
                    />
                  ))}
                  {draft && draft.page === n && (
                    <span
                      className="pdf-draft"
                      style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
                    />
                  )}
                  <span className="pdf-page-tag">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
