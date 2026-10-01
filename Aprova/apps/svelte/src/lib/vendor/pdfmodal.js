// Modal "Página inteira": shell Mira + viewer oficial Mozilla PDF.js em iframe.
// Substitui o render custom anterior (canvas/toolbar/busca próprios).

const API = window.__MIRA_API__ || (location.protocol.startsWith("http") ? location.origin + "/api" : "http://localhost:3333/api");
const VIEWER = "/assets/pdfjs/web/viewer.html";

const ICONS = {
  x: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  expand: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
  minimize: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
};

export class PdfModal {
  constructor(examId, title, onClose) {
    this.examId = examId;
    this.title = title;
    this.onCloseCb = onClose;
    this.isFullscreen = false;
    this.cancelled = false;
    this.build();
    this.bindGlobal();
  }

  build() {
    const file = encodeURIComponent(`${API}/exams/${this.examId}/source`);
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
        <div class="pdf-modal-body pdf-modal-embed-body">
          <iframe class="pdf-viewer-frame" title="Visualizador de PDF" src="${VIEWER}?file=${file}"></iframe>
        </div>
      </div>`;
    el.querySelector(".pdf-modal-title strong").textContent = this.title;
    el.addEventListener("click", (e) => { if (e.target === el) this.close(); });
    el.querySelector(".pdf-modal-close").addEventListener("click", () => this.close());
    el.querySelector('[data-act="fullscreen"]').addEventListener("click", () => this.toggleFullscreen());
    this.frame = el.querySelector(".pdf-viewer-frame");
    this.frame.addEventListener("load", () => this.applyAccent());
    this.el = el;
    document.body.appendChild(el);
  }

  // Acento principal do projeto PDF dentro do viewer oficial
  // (mesma origem permite injetar o CSS).
  applyAccent() {
    try {
      const doc = this.frame && this.frame.contentDocument;
      if (!doc || doc.querySelector("style[data-mira-accent]")) return;
      const style = doc.createElement("style");
      style.dataset.miraAccent = "";
      style.textContent = [
        ":root{",
        "--color-accent-primary:#2596be!important;",
        "--color-accent-primary-hover:#1e87ae!important;",
        "--color-accent-primary-active:#176e8f!important;",
        "--progressBar-color:#45add6!important;",
        "--link-fg-color:#7cc7ea!important;",
        "--toolbar-bg-color:#04002e!important;",
        "--body-bg-color:#040015!important;",
        "--sidebar-narrow-bg-color:rgba(4,0,21,.94)!important;",
        "--sidebar-toolbar-bg-color:#04002e!important;",
        "--toolbar-border-color:#2a2b5f!important;",
        "--main-color:#f2f2f7!important;",
        "--field-bg-color:#1a1a2e!important;",
        "--field-color:#f2f2f7!important;",
        "--doorhanger-bg-color:#12122b!important;",
        "--button-hover-color:#2a2b5f!important;",
        "--doorhanger-hover-bg-color:rgb(93, 94, 98)!important;",
        "--doorhanger-hover-color:#fff!important;",
        "#zoomOutButton:hover,#zoomInButton:hover{background-color:#2a2b5f!important;}",
        "#scaleSelect,#pageNumber{background-color:#2a2b5f!important;color:#fff!important;border-color:#47457c!important;}",
        "}",
      ].join("");
      doc.head.appendChild(style);
    } catch {
      /* Viewer inacessível: mantém o tema padrão. */
    }
  }

  bindGlobal() {
    this.onKey = (event) => {
      if (event.key === "Escape") { this.close(); }
    };
    this.onFsChange = () => {
      this.isFullscreen = Boolean(document.fullscreenElement);
      this.renderToolbar();
    };
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("fullscreenchange", this.onFsChange);
    document.body.style.overflow = "hidden";
  }

  renderToolbar() {
    const btn = this.el && this.el.querySelector('[data-act="fullscreen"]');
    if (btn) btn.innerHTML = this.isFullscreen ? ICONS.minimize : ICONS.expand;
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

  close() {
    this.cancelled = true;
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
