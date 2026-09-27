// Porte vanilla de apps/web/src/PdfModal.tsx — modal "Página inteira".
// pdf-lib (UMD global `PDFLib`) carrega sob demanda, só ao exportar.

import { fetchExamInfo, fetchPageText, prefetchExamPdf, extractExamText } from "./pdfcache.js";

const API = window.__MIRA_API__ || (location.protocol.startsWith("http") ? location.origin + "/api" : "http://localhost:3333/api");

const ICONS = {
  x: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  chevL: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>',
  chevR: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
  minus: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  plus: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  square: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
  trash: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  download: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  expand: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
  minimize: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
};

function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/assets/vendor/pdf-lib.min.js";
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => reject(new Error("pdf-lib indisponível"));
    document.head.appendChild(s);
  });
}

export class PdfModal {
  constructor(examId, title, onClose) {
    this.examId = examId;
    this.title = title;
    this.onCloseCb = onClose;
    this.totalPages = null;
    this.loadError = "";
    this.zoom = 1;
    this.current = 1;
    this.marks = this.loadMarks();
    this.redactMode = false;
    this.draft = null;
    this.failedPages = new Set();
    this.query = "";
    this.searching = false;
    this.hits = [];
    this.textLayers = new Map();
    this.exporting = false;
    this.isFullscreen = false;
    this.pageEls = new Map();
    this.drawing = null;
    this.cancelled = false;
    this.build();
    this.bindGlobal();
    this.load();
  }

  storageKey() { return `mira:redactions:${this.examId}`; }

  loadMarks() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.storageKey()) ?? "[]");
      return Array.isArray(raw) ? raw.filter((m) => m && typeof m.page === "number") : [];
    } catch { return []; }
  }

  saveMarks() {
    try { localStorage.setItem(this.storageKey(), JSON.stringify(this.marks)); } catch { /* sem armazenamento */ }
  }

  clamp01(v) { return Math.min(1, Math.max(0, v)); }

  build() {
    const el = document.createElement("div");
    el.className = "pdf-modal-backdrop";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", `PDF: ${this.title}`);
    el.innerHTML = `
      <div class="pdf-modal pdf-modal-embed">
        <header class="pdf-modal-toolbar">
          <div class="pdf-modal-title"><strong></strong><span>Página inteira • PDF original</span></div>
          <div class="pdf-modal-controls">
            <button data-act="fullscreen" aria-label="Expandir para tela cheia" title="Expandir para tela cheia">${ICONS.expand}</button>
            <button class="pdf-modal-close" aria-label="Fechar PDF">${ICONS.x}</button>
          </div>
        </header>
        <div class="pdf-reader-bar">
          <div class="pdf-reader-group">
            <button data-act="prev" aria-label="Página anterior" title="Página anterior">${ICONS.chevL}</button>
            <span class="pdf-reader-counter">…</span>
            <button data-act="next" aria-label="Próxima página" title="Próxima página">${ICONS.chevR}</button>
          </div>
          <i class="pdf-reader-sep"></i>
          <div class="pdf-reader-group">
            <button data-act="zout" aria-label="Reduzir zoom" title="Reduzir zoom">${ICONS.minus}</button>
            <button class="pdf-reader-zoom" title="Ajustar à largura">100%</button>
            <button data-act="zin" aria-label="Aumentar zoom" title="Aumentar zoom">${ICONS.plus}</button>
          </div>
          <i class="pdf-reader-sep"></i>
          <form class="pdf-reader-search">
            ${ICONS.search}
            <input placeholder="Buscar no PDF…" aria-label="Buscar no PDF" />
          </form>
          <div class="pdf-reader-group">
            <button data-act="redact" aria-label="Tarjar trechos" title="Tarjar trechos (arraste sobre a página)">${ICONS.square}<span data-role="redact-label">Tarjar</span></button>
            <button data-act="clear" aria-label="Remover tarjas" title="Remover todas as tarjas" hidden>${ICONS.trash}</button>
            <button data-act="export" aria-label="Exportar PDF com tarjas" title="Marque tarjas para exportar" disabled>${ICONS.download}<span data-role="export-label">Exportar</span></button>
          </div>
        </div>
        <div class="pdf-reader-note" data-role="note" hidden></div>
        <div class="pdf-modal-body pdf-modal-embed-body pdf-reader-scroll">
          <div class="pdf-modal-loading">Carregando páginas…</div>
        </div>
      </div>`;
    el.querySelector(".pdf-modal-title strong").textContent = this.title;
    el.addEventListener("click", (e) => { if (e.target === el) this.close(); });
    el.querySelector(".pdf-modal-close").addEventListener("click", () => this.close());
    el.querySelector('[data-act="fullscreen"]').addEventListener("click", () => this.toggleFullscreen());
    el.querySelector('[data-act="prev"]').addEventListener("click", () => this.scrollToPage(Math.max(1, this.current - 1)));
    el.querySelector('[data-act="next"]').addEventListener("click", () => this.scrollToPage(Math.min(this.totalPages ?? 1, this.current + 1)));
    el.querySelector('[data-act="zout"]').addEventListener("click", () => this.changeZoom(-0.25));
    el.querySelector('[data-act="zin"]').addEventListener("click", () => this.changeZoom(0.25));
    el.querySelector(".pdf-reader-zoom").addEventListener("click", () => { this.zoom = 1; this.renderPages(); });
    el.querySelector(".pdf-reader-search").addEventListener("submit", (e) => this.runSearch(e));
    el.querySelector(".pdf-reader-search input").addEventListener("input", (e) => { this.query = e.target.value; });
    el.querySelector('[data-act="redact"]').addEventListener("click", () => { this.redactMode = !this.redactMode; this.renderToolbar(); this.renderPages(); });
    el.querySelector('[data-act="clear"]').addEventListener("click", () => this.clearMarks());
    el.querySelector('[data-act="export"]').addEventListener("click", () => this.exportRedacted());
    this.el = el;
    this.scroller = el.querySelector(".pdf-modal-body");
    document.body.appendChild(el);
  }

  bindGlobal() {
    this.onKey = (event) => {
      if (event.key === "Escape") { this.close(); return; }
      const target = event.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const step = this.scroller.clientHeight * 0.9;
      if (event.key === "PageDown" || event.key === "ArrowDown") {
        event.preventDefault();
        this.scroller.scrollBy({ top: event.key === "PageDown" ? step : 120, behavior: "smooth" });
      } else if (event.key === "PageUp" || event.key === "ArrowUp") {
        event.preventDefault();
        this.scroller.scrollBy({ top: event.key === "PageUp" ? -step : -120, behavior: "smooth" });
      } else if (event.key === "Home") {
        event.preventDefault();
        this.scroller.scrollTo({ top: 0, behavior: "smooth" });
      } else if (event.key === "End") {
        event.preventDefault();
        this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: "smooth" });
      }
    };
    this.onFsChange = () => {
      this.isFullscreen = Boolean(document.fullscreenElement);
      this.renderToolbar();
    };
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("fullscreenchange", this.onFsChange);
    document.body.style.overflow = "hidden";
  }

  load() {
    fetchExamInfo(this.examId).then(
      ({ pages }) => { if (!this.cancelled) { this.totalPages = pages; this.renderPages(); this.observePages(); } },
      () => { if (!this.cancelled) { this.loadError = "Não foi possível carregar as páginas da prova."; this.renderBody(); } }
    );
    prefetchExamPdf(this.examId).catch(() => undefined);
  }

  renderToolbar() {
    const q = (s) => this.el.querySelector(s);
    q('[data-act="fullscreen"]').innerHTML = this.isFullscreen ? ICONS.minimize : ICONS.expand;
    q(".pdf-reader-counter").textContent = this.totalPages ? `${this.current} de ${this.totalPages}` : "…";
    q(".pdf-reader-zoom").textContent = `${Math.round(this.zoom * 100)}%`;
    q('[data-act="redact"]').classList.toggle("is-active", this.redactMode);
    q('[data-role="redact-label"]').textContent = `Tarjar${this.marks.length ? ` (${this.marks.length})` : ""}`;
    q('[data-act="clear"]').hidden = !this.marks.length;
    const exp = q('[data-act="export"]');
    exp.disabled = !this.marks.length || this.exporting;
    exp.title = this.marks.length ? "Baixar PDF com as tarjas aplicadas" : "Marque tarjas para exportar";
    q('[data-role="export-label"]').textContent = this.exporting ? "Exportando…" : "Exportar";
    const note = q('[data-role="note"]');
    if (this.searching) {
      note.hidden = false;
      note.textContent = "Buscando no documento…";
    } else if (this.hits.length) {
      note.hidden = false;
      note.innerHTML = "";
      const span = document.createElement("span");
      span.textContent = this.hits.length === 1 ? "Encontrado na página" : `Encontrado em ${this.hits.length} páginas`;
      note.appendChild(span);
      note.appendChild(document.createTextNode(": "));
      for (const n of this.hits) {
        const b = document.createElement("button");
        b.className = "pdf-chip";
        b.textContent = String(n);
        b.addEventListener("click", () => this.scrollToPage(n));
        note.appendChild(b);
      }
      const clear = document.createElement("button");
      clear.className = "pdf-chip pdf-chip-clear";
      clear.setAttribute("aria-label", "Limpar busca");
      clear.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      clear.addEventListener("click", () => { this.hits = []; this.renderToolbar(); });
      note.appendChild(clear);
    } else {
      note.hidden = true;
      note.innerHTML = "";
    }
  }

  renderBody() {
    const body = this.el.querySelector(".pdf-modal-body");
    body.innerHTML = "";
    if (this.loadError) {
      const err = document.createElement("div");
      err.className = "pdf-modal-error";
      err.textContent = this.loadError + " ";
      const retry = document.createElement("button");
      retry.className = "pdf-modal-retry";
      retry.textContent = "Tentar de novo";
      retry.addEventListener("click", () => {
        this.loadError = "";
        this.totalPages = null;
        this.renderBody();
        fetchExamInfo(this.examId).then(
          ({ pages }) => { if (!this.cancelled) { this.totalPages = pages; this.renderPages(); this.observePages(); } },
          () => { if (!this.cancelled) { this.loadError = "Não foi possível carregar as páginas da prova."; this.renderBody(); } }
        );
      });
      err.appendChild(retry);
      body.appendChild(err);
      return;
    }
    if (!this.totalPages) {
      const l = document.createElement("div");
      l.className = "pdf-modal-loading";
      l.textContent = "Carregando páginas…";
      body.appendChild(l);
      return;
    }
    this.renderPages();
    this.observePages();
  }

  renderPages() {
    const body = this.el.querySelector(".pdf-modal-body");
    if (this.loadError || !this.totalPages) { this.renderBody(); return; }
    this.pageEls.clear();
    body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "pdf-reader-pages";
    wrap.style.width = `${this.zoom * 100}%`;
    for (let n = 1; n <= this.totalPages; n++) {
      const pg = document.createElement("div");
      pg.dataset.page = String(n);
      pg.className = "pdf-reader-page" + (this.redactMode ? " is-marking" : "");
      pg.addEventListener("pointerdown", (e) => this.onPageDown(n, e));
      pg.addEventListener("pointermove", (e) => this.onPageMove(e));
      pg.addEventListener("pointerup", () => this.onPageUp());
      pg.addEventListener("pointercancel", () => this.onPageUp());
      this.pageEls.set(n, pg);
      if (this.failedPages.has(n)) {
        const f = document.createElement("div");
        f.className = "pdf-page-failed";
        const s = document.createElement("span");
        s.textContent = `Página ${n} indisponível`;
        f.appendChild(s);
        pg.appendChild(f);
      } else {
        const img = document.createElement("img");
        img.src = `${API}/exams/${this.examId}/pages/${n}`;
        img.alt = `Página ${n} do PDF original`;
        img.draggable = false;
        img.loading = n <= 3 ? "eager" : "lazy";
        img.decoding = "async";
        img.addEventListener("load", () => {
          img.classList.add("is-loaded");
          if (img.naturalWidth) pg.style.setProperty("--ar", String(img.naturalHeight / img.naturalWidth));
          fetchPageText(this.examId, n).then(
            ({ lines }) => {
              this.textLayers.set(n, lines);
              this.paintTextLayer(pg, n, lines);
            },
            () => undefined
          );
        });
        img.addEventListener("error", () => { this.failedPages.add(n); this.renderPages(); this.observePages(); });
        pg.appendChild(img);
      }
      if (!this.redactMode) {
        for (const line of this.textLayers.get(n) ?? []) {
          pg.appendChild(this.textSpan(line));
        }
      }
      for (const m of this.marks.filter((x) => x.page === n)) {
        const s = document.createElement("span");
        s.className = "pdf-mark";
        s.style.left = `${m.x * 100}%`;
        s.style.top = `${m.y * 100}%`;
        s.style.width = `${m.w * 100}%`;
        s.style.height = `${m.h * 100}%`;
        pg.appendChild(s);
      }
      const d = this.draft && this.draft.page === n ? this.draft : null;
      if (d) {
        const s = document.createElement("span");
        s.className = "pdf-draft";
        s.style.left = `${d.x * 100}%`;
        s.style.top = `${d.y * 100}%`;
        s.style.width = `${d.w * 100}%`;
        s.style.height = `${d.h * 100}%`;
        pg.appendChild(s);
      }
      const tag = document.createElement("span");
      tag.className = "pdf-page-tag";
      tag.textContent = String(n);
      pg.appendChild(tag);
      wrap.appendChild(pg);
    }
    body.innerHTML = "";
    body.appendChild(wrap);
    this.renderToolbar();
  }

  paintTextLayer(pg, n, lines) {
    if (this.redactMode) return;
    if (!pg.isConnected) return;
    pg.querySelectorAll(".pdf-textline").forEach((el) => el.remove());
    for (const line of lines) {
      pg.appendChild(this.textSpan(line));
    }
  }

  textSpan(line) {
    const s = document.createElement("span");
    s.className = "pdf-textline";
    s.style.left = `${line.x * 100}%`;
    s.style.top = `${line.y * 100}%`;
    s.style.width = `${line.w * 100}%`;
    s.style.height = `${line.h * 100}%`;
    s.style.fontSize = `calc(${line.h} * var(--ar, 1.414) * 100cqw)`;
    s.textContent = line.text + " ";
    return s;
  }

  observePages() {
    if (this.observer) this.observer.disconnect();
    if (!this.totalPages) return;
    this.observer = new IntersectionObserver(
      (entries) => {
        let best = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number(entry.target.dataset.page);
          if (!best || entry.intersectionRatio > best.ratio) best = { page, ratio: entry.intersectionRatio };
        }
        if (best && best.page !== this.current) {
          this.current = best.page;
          this.renderToolbar();
        }
      },
      { root: this.scroller, threshold: [0.25, 0.5, 0.75] }
    );
    for (const [, el] of this.pageEls) this.observer.observe(el);
  }

  scrollToPage(n) {
    this.pageEls.get(n)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  changeZoom(delta) {
    this.zoom = Math.min(3, Math.max(0.5, Number((this.zoom + delta).toFixed(2))));
    this.renderToolbar();
    this.renderPages();
    this.observePages();
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await this.el.requestFullscreen();
      }
    } catch {
      const maximized = this.el.querySelector(".pdf-modal")?.classList.toggle("pdf-modal-maximized") ?? false;
      this.isFullscreen = maximized;
      this.renderToolbar();
    }
  }

  pointOf(pg, event) {
    const rect = pg.getBoundingClientRect();
    return {
      x: this.clamp01((event.clientX - rect.left) / rect.width),
      y: this.clamp01((event.clientY - rect.top) / rect.height),
    };
  }

  onPageDown(n, event) {
    if (!this.redactMode || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    const pg = this.pageEls.get(n);
    pg.setPointerCapture(event.pointerId);
    const p = this.pointOf(pg, event);
    this.drawing = { page: n, x0: p.x, y0: p.y };
    this.draft = { id: "", page: n, x: p.x, y: p.y, w: 0, h: 0 };
    this.renderPages();
    this.observePages();
  }

  onPageMove(event) {
    const d = this.drawing;
    if (!d) return;
    const pg = this.pageEls.get(d.page);
    const p = this.pointOf(pg, event);
    this.draft = {
      id: "", page: d.page,
      x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y),
      w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0),
    };
    const old = pg.querySelector(".pdf-draft");
    if (old) old.remove();
    const s = document.createElement("span");
    s.className = "pdf-draft";
    s.style.left = `${this.draft.x * 100}%`;
    s.style.top = `${this.draft.y * 100}%`;
    s.style.width = `${this.draft.w * 100}%`;
    s.style.height = `${this.draft.h * 100}%`;
    pg.appendChild(s);
  }

  onPageUp() {
    const d = this.drawing;
    const rect = this.draft;
    this.drawing = null;
    this.draft = null;
    if (!d || !rect || rect.w < 0.008 || rect.h < 0.008) { this.renderPages(); this.observePages(); return; }
    this.marks = [...this.marks, {
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      page: d.page, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    }];
    this.saveMarks();
    this.renderPages();
    this.observePages();
  }

  clearMarks() {
    if (!this.marks.length) return;
    if (window.confirm(`Remover as ${this.marks.length} tarjas desta prova?`)) {
      this.marks = [];
      this.saveMarks();
      this.renderToolbar();
      this.renderPages();
      this.observePages();
    }
  }

  async exportRedacted() {
    if (!this.marks.length || this.exporting) return;
    this.exporting = true;
    this.renderToolbar();
    try {
      const { PDFDocument, rgb } = await loadPdfLib();
      const pdf = await PDFDocument.load((await prefetchExamPdf(this.examId)).slice(0));
      for (const m of this.marks) {
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
      a.download = `prova-${this.examId}-tarjado.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      window.alert("Não foi possível exportar o PDF com as tarjas.");
    } finally {
      this.exporting = false;
      this.renderToolbar();
    }
  }

  async runSearch(event) {
    if (event) event.preventDefault();
    const term = this.query.trim().toLowerCase();
    if (!term) {
      this.hits = [];
      this.renderToolbar();
      return;
    }
    this.searching = true;
    this.renderToolbar();
    try {
      const texts = await extractExamText(this.examId);
      const found = texts.map((t, i) => (t.toLowerCase().includes(term) ? i + 1 : -1)).filter((n) => n > 0);
      this.hits = found;
      if (found[0]) this.scrollToPage(found[0]);
    } catch {
      window.alert("Não foi possível buscar no PDF agora.");
    } finally {
      this.searching = false;
      this.renderToolbar();
    }
  }

  close() {
    this.cancelled = true;
    if (this.observer) this.observer.disconnect();
    window.removeEventListener("keydown", this.onKey);
    document.removeEventListener("fullscreenchange", this.onFsChange);
    document.body.style.overflow = "";
    this.el.remove();
    if (this.onCloseCb) this.onCloseCb();
  }

  static open(examId, title, onClose) {
    return new PdfModal(examId, title, onClose);
  }
}
