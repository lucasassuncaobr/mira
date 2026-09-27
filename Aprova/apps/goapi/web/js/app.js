// Mira — frontend AlpineJS + vanilla, sem build.
// Porte de apps/web/src/App.tsx: mesmas telas, classes e comportamentos.
// Alpine via ESM + start() manual: sem corrida com alpine:init.
import Alpine from "alpinejs";
import { getFocusMap, getPageSrc, hostExam, shutdownP2P } from "./p2p.js";
import { warmPdfReader, fetchExamInfo, preloadExamPages } from "./pdfcache.js";
import { PdfModal } from "./pdfmodal.js";

const API = window.__MIRA_API__ || (location.protocol.startsWith("http") ? location.origin + "/api" : "http://localhost:3333/api");

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function assetURL(path) {
  const value = String(path ?? "");
  return value.startsWith("/") ? `${location.origin}${value}` : `${API}/${value}`;
}

function formatStudyTime(seconds) {
  seconds = Number(seconds ?? 0);
  if (seconds < 60) return "0min";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min`;
}

function formatTimer(seconds) {
  seconds = Number(seconds ?? 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}
window.fmtClock = formatTimer;

const ICONS = {
  fileText: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  book: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  clock: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  chart: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  chevR: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
  upload: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16l-4-4-4 4"/><path d="M12 12v9"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>',
  uploadSm: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16l-4-4-4 4"/><path d="M12 12v9"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>',
  pencil: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  clipboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12l2 2 4-4"/></svg>',
};

Alpine.store("app", {
    view: "exams",
    exams: [],
    exam: null,
    loading: false,
    error: "",
    historyReady: false,
    historyView: null,
    fallbackAttempted: false,
    titles: {
      dashboard: "Sua preparação, em um só lugar",
      exams: "Suas provas",
      performance: "Seu desempenho",
      import: "Importar nova prova",
      review: "Revisar questões",
      solve: "Resolver prova",
    },

    async refresh() {
      const response = await fetch(`${API}/exams`);
      this.exams = await response.json();
      this.error = "";
    },

    setView(view) {
      if (window.__solveCleanup) { window.__solveCleanup(); window.__solveCleanup = null; }
      stopClock();
      if (this.historyReady && this.historyView === view) { this.view = view; return; }
      this.view = view;
      if (!this.historyReady) return;
      const currentHash = window.location.hash.replace("#", "");
      const hashMatch = currentHash.match(/^(solve)(?:\/(\d+))?$/);
      const examId = hashMatch?.[2];
      window.history.pushState({ view, examId: examId ? Number(examId) : undefined }, "", `${window.location.pathname}#${view}${examId ? "/" + examId : ""}`);
      this.historyView = view;
    },

    async openExam(id, nextView) {
      if (window.__solveCleanup) { window.__solveCleanup(); window.__solveCleanup = null; }
      stopClock();
      const response = await fetch(`${API}/exams/${id}`);
      this.exam = await response.json();
      this.view = nextView;
      window.history.replaceState({ view: nextView, examId: id }, "", `${window.location.pathname}#${nextView}/${id}`);
      this.historyView = nextView;
    },

    async removeExam(id) {
      if (!window.confirm("Remover esta prova e todo o histórico dela?")) return;
      const response = await fetch(`${API}/exams/${id}`, { method: "DELETE" });
      if (!response.ok) return (this.error = "Não foi possível remover a prova.");
      await this.refresh();
    },

    init() {
      this.refresh().catch(() => (this.error = "A API não está disponível."));
      const hash = window.location.hash.replace("#", "");
      const match = hash.match(/^(solve)(?:\/(\d+))?$/);
      const plainView = ["exams", "performance", "import", "review", "solve"].includes(hash);
      const initialView = match ? "solve" : plainView ? hash : "exams";
      const examId = match?.[2];
      this.historyView = initialView;
      this.view = initialView;
      this.historyReady = true;
      if (examId) {
        fetch(`${API}/exams/${examId}`).then((r) => r.json()).then((e) => (this.exam = e)).catch(() => undefined);
      }
      window.history.replaceState(
        { view: initialView, examId: examId ? Number(examId) : undefined },
        "", `${window.location.pathname}#${initialView}${examId ? "/" + examId : ""}`
      );
      window.addEventListener("popstate", (event) => {
        const state = event.state;
        const target = state?.view;
        const restoredView = target && ["exams", "performance", "import", "review", "solve"].includes(target) ? target : "exams";
        if (window.__solveCleanup) { window.__solveCleanup(); window.__solveCleanup = null; }
        stopClock();
        this.historyView = restoredView;
        this.view = restoredView;
        if (state?.examId && restoredView === "solve") {
          fetch(`${API}/exams/${state.examId}`).then((r) => r.json()).then((e) => (this.exam = e)).catch(() => undefined);
        } else {
          this.exam = null;
        }
      });
      // fallback: solve direto sem prova carregada abre a primeira
      setInterval(() => {
        if (this.view === "solve" && !this.exam && !this.fallbackAttempted && this.exams.length > 0) {
          this.fallbackAttempted = true;
          const fallbackId = this.exams[0].id;
          window.history.replaceState({ view: "solve", examId: fallbackId }, "", `${window.location.pathname}#solve/${fallbackId}`);
          fetch(`${API}/exams/${fallbackId}`).then((r) => r.json()).then((e) => (this.exam = e)).catch(() => undefined);
        }
      }, 500);
    },
  });

  // ---- dashboard ----
  // NOTA Alpine: dentro de handlers x-on:click, this.$el/$refs resolvem para
  // o elemento clicado — por isso cada componente captura a raiz no init()
  // e usa this.root / refs capturadas em todos os métodos.
  Alpine.data("dashboardComponent", () => ({
    get exams() { return Alpine.store("app").exams; },
    get answered() { return this.exams.reduce((s, i) => s + Number(i.answered_count ?? 0), 0); },
    get correct() { return this.exams.reduce((s, i) => s + Number(i.correct_count ?? 0), 0); },
    get studySeconds() { return this.exams.reduce((s, i) => s + Number(i.study_seconds ?? 0), 0); },
    get accuracy() { return this.answered ? Math.round((this.correct / this.answered) * 100) : 0; },
    get tone() { return this.accuracy >= 70 ? "green" : this.accuracy >= 50 ? "amber" : "red"; },
    get studyTime() { return formatStudyTime(this.studySeconds); },
    init() {
      this.root = this.$el;
      this.$nextTick(() => this.renderCards());
      this.$watch(() => Alpine.store("app").exams, () => this.renderCards());
    },
    renderCards() {
      const box = this.root.querySelector(".dashboard-exams");
      if (!box) return;
      if (!this.exams.length) return;
      box.innerHTML = this.exams.map((item) => examCardHtml(item)).join("");
      wireExamCards(box);
    },
  }));

  // ---- heatmap ----
  Alpine.data("heatmapComponent", () => ({
    html: "",
    async init() {
      let activity = [];
      try { activity = await fetch(`${API}/activity`).then((r) => r.json()); } catch { activity = []; }
      const visible = activity.slice(-371);
      const cells = [...Array(Math.max(0, 371 - visible.length)).fill(null), ...visible].slice(-371);
      const activeDays = visible.filter((d) => d.count > 0).length;
      const total = visible.reduce((s, d) => s + d.count, 0);
      this.html = `<section class="side-card consistency modern-heatmap github-calendar"><div class="side-title"><div><span class="eyebrow">CONSTÂNCIA</span><h3>Ritmo de estudo</h3></div><span class="activity-total">${total} questões</span></div><div class="heatmap-scroll"><div class="github-months"><span>Jan</span><span>Mar</span><span>Mai</span><span>Jul</span><span>Set</span><span>Nov</span></div><div class="consistency-grid compact-heatmap github-grid">${cells.map((day, i) => `<i key="${day?.date ?? `empty-${i}`}" class="level-${Math.min(4, day?.count ?? 0)}" title="${day ? `${esc(day.label)}: ${day.count} ${day.count === 1 ? "questão" : "questões"}` : "Sem registro"}"></i>`).join("")}</div></div><div class="heatmap-footer"><span>${activeDays} dias ativos</span><div><small>Menos</small>${[0, 1, 2, 3, 4].map((l) => `<i class="level-${l}"></i>`).join("")}<small>Mais</small></div></div></section>`;
    },
  }));

  // ---- performance ----
  Alpine.data("performanceComponent", () => ({
    days: [],
    scoreMode: "normal",
    get exams() { return Alpine.store("app").exams; },
    get total() { return this.exams.reduce((s, i) => s + Number(i.question_count ?? 0), 0); },
    get answered() { return this.exams.reduce((s, i) => s + Number(i.answered_count ?? 0), 0); },
    get correct() { return this.exams.reduce((s, i) => s + Number(i.correct_count ?? 0), 0); },
    get wrong() { return this.exams.reduce((s, i) => s + Number(i.wrong_count ?? 0), 0); },
    get blank() { return Math.max(0, this.total - this.answered); },
    get seconds() { return this.exams.reduce((s, i) => s + Number(i.study_seconds ?? 0), 0); },
    get accuracy() { return this.answered ? Math.round((this.correct / this.answered) * 100) : 0; },
    get liquid() { return this.answered ? Math.max(0, Math.round(((this.correct - this.wrong) / this.answered) * 100)) : 0; },
    get displayed() { return this.scoreMode === "normal" ? this.accuracy : this.liquid; },
    get completion() { return this.total ? Math.round((this.answered / this.total) * 100) : 0; },
    get avgSeconds() { return this.answered ? Math.round(this.seconds / this.answered) : 0; },
    get maxDay() { return Math.max(1, ...this.days.map((d) => d.answered)); },
    get weekTotal() { return this.days.reduce((s, d) => s + d.answered, 0); },
    fmtTime(s) { return formatTimer(s); },
    donut(title, value, correct, wrong, goal) {
      return `<div class="donut-card"><h3>${title}</h3><div class="performance-donut" style="--donut: ${correct * 3.6}deg"><div><strong>${value}%</strong><span>${goal ? "Referência" : "Pontuação"}</span></div></div><div class="donut-legend"><span><i class="green"></i>Acertos ${correct}%</span><span><i class="red"></i>Erros ${wrong}%</span></div></div>`;
    },
    get donutsHtml() {
      const mastery = Math.round((this.accuracy + this.completion) / 2);
      return this.donut("Seu desempenho", this.displayed, this.accuracy, this.answered ? 100 - this.accuracy : 0)
        + this.donut("Meta de aprovação", 75, 75, 25, true)
        + `<div class="mastery"><strong>Índice de domínio</strong><div><i style="left: ${Math.min(100, mastery)}%"></i></div><span>${mastery}%</span></div>`;
    },
    get weekHtml() {
      return this.days.map((day) => `<div class="day-column"><div class="bar-track"><i style="height: ${Math.max(day.answered ? 8 : 2, (day.answered / this.maxDay) * 100)}%"></i></div><strong>${day.answered}</strong><span>${esc(day.day)}</span></div>`).join("");
    },
    get rankingHtml() {
      return this.exams.map((item) => {
        const done = Number(item.answered_count ?? 0);
        const hits = Number(item.correct_count ?? 0);
        const rate = done ? Math.round((hits / done) * 100) : 0;
        return `<button data-open="${item.id}"><div><strong>${esc(item.title)}</strong><span>${done} resolvidas • ${hits} acertos</span></div><div class="rank-rate"><b>${done ? `${rate}%` : "—"}</b>${ICONS.chevR}</div></button>`;
      }).join("");
    },
    async init() {
      try { this.days = await fetch(`${API}/performance`).then((r) => r.json()); } catch { this.days = []; }
      this.$el.querySelector(".exam-ranking")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-open]");
        if (btn) Alpine.store("app").openExam(Number(btn.dataset.open), "solve");
      });
    },
  }));

  // ---- import ----
  Alpine.data("importComponent", () => ({
    examFile: null,
    answerFile: null,
    secs: 0,
    timer: null,
    iconCheck: ICONS.check,
    iconUpload: ICONS.upload,
    get loading() { return Alpine.store("app").loading; },
    fmtClock(s) { return formatTimer(s); },
    init() {
      this.$watch(() => Alpine.store("app").loading, (v) => {
        if (v) {
          const startedAt = performance.now();
          const tick = () => { this.secs = Math.floor((performance.now() - startedAt) / 1000); };
          tick();
          this.timer = window.setInterval(tick, 250);
        } else {
          this.secs = 0;
          if (this.timer) window.clearInterval(this.timer);
        }
      });
    },
    async send() {
      const app = Alpine.store("app");
      if (!this.examFile || !this.answerFile) return;
      app.loading = true;
      app.error = "";
      const body = new FormData();
      body.append("exam", this.examFile);
      body.append("answerKey", this.answerFile);
      try {
        const response = await fetch(`${API}/exams/import`, { method: "POST", body });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        await app.refresh();
        await app.openExam(data.id, "review");
      } catch (e) {
        app.error = e instanceof Error ? e.message : "Falha ao importar";
      } finally {
        app.loading = false;
      }
    },
  }));

  // ---- review ----
  Alpine.data("reviewComponent", () => ({
    selected: 0,
    saving: false,
    get exam() { return Alpine.store("app").exam; },
    get questions() { return this.exam?.questions ?? []; },
    get question() { return this.questions[this.selected]; },
    get gridHtml() {
      return this.questions.map((q, i) => `<button class="${i === this.selected ? "active" : ""}" data-i="${i}">${q.number}</button>`).join("");
    },
    get altsHtml() {
      const q = this.question;
      if (!q) return "";
      return q.alternatives.map((alt, i) => `<div class="alternative-edit"><button class="${q.correct_answer === alt.label ? "letter correct" : "letter"}" data-letter="${esc(alt.label)}">${esc(alt.label)}</button><textarea data-i="${i}">${esc(alt.text)}</textarea></div>`).join("");
    },
    init() {
      this.root = this.$el;
      const root = this.root;
      root.querySelector(".number-grid").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-i]");
        if (btn) { this.selected = Number(btn.dataset.i); this.refresh(); }
      });
      root.querySelector(".alternatives").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-letter]");
        if (!btn) return;
        const qs = [...this.questions];
        qs[this.selected] = { ...this.question, correct_answer: btn.dataset.letter };
        Alpine.store("app").exam = { ...this.exam, questions: qs };
        this.refresh();
      });
      root.querySelector(".alternatives").addEventListener("input", (e) => {
        const ta = e.target.closest("textarea[data-i]");
        if (!ta) return;
        const qs = [...this.questions];
        const alts = [...this.question.alternatives];
        alts[Number(ta.dataset.i)] = { ...alts[Number(ta.dataset.i)], text: ta.value };
        qs[this.selected] = { ...this.question, alternatives: alts };
        Alpine.store("app").exam = { ...this.exam, questions: qs };
      });
    },
    refresh() {
      const root = this.root;
      root.querySelector(".number-grid").innerHTML = this.gridHtml;
      const head = root.querySelector(".editor-head .eyebrow");
      if (head) head.textContent = "QUESTÃO " + this.question.number;
      root.querySelector(".alternatives").innerHTML = this.altsHtml;
    },
    async save() {
      const q = this.question;
      this.saving = true;
      const btn = this.root.querySelector(".editor-footer .primary");
      if (btn) btn.textContent = "Salvando...";
      await fetch(`${API}/questions/${q.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statement: q.statement, alternatives: q.alternatives, correctAnswer: q.correct_answer, subject: q.subject, topic: q.topic }),
      });
      this.saving = false;
      if (btn) btn.textContent = "Salvar e avançar";
      if (this.selected < this.questions.length - 1) {
        this.selected += 1;
        this.refresh();
      }
    },
  }));

  // ---- solve ----
  Alpine.data("solveComponent", () => ({
    currentIdx: 0,
    answers: {},
    results: {},
    feedback: null,
    submitting: false,
    focusMap: null,
    get exam() { return Alpine.store("app").exam; },
    get questions() {
      const all = this.exam?.questions ?? [];
      return all.filter((q, i, arr) => arr.findIndex((x) => x.number === q.number) === i);
    },
    get question() { return this.questions[this.currentIdx]; },
    get total() { return this.questions.length; },
    get selected() { return this.question ? this.answers[this.question.id] ?? null : null; },
    get allAnswered() { return this.questions.every((q) => this.answers[q.id]); },
    get answeredCount() { return this.questions.filter((q) => this.answers[q.id]).length; },
    get focusEntry() { return this.question ? this.focusMap?.[String(this.question.number)] : undefined; },
    get currentPage() { return this.focusEntry?.page ?? this.question?.page_number; },
    init() {
      this.root = this.$el;
      this.indexGridEl = this.$el.querySelector('[x-ref="indexGrid"]');
      const examId = this.exam.id;
      let alive = true;
      getFocusMap(examId).then(
        (map) => { if (alive) { this.focusMap = map; this.renderAll(); this.reloadPage(); } },
        () => undefined
      );
      void hostExam(examId);
      window.__solveCleanup = () => { alive = false; void shutdownP2P(); };
      this.$watch("currentIdx", () => {
        const grid = this.indexGridEl;
        const active = grid?.querySelector(".index-btn.active");
        if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
        this.renderAll();
        this.reloadPage();
      });
      this.renderAll();
    },
    reloadPage() {
      const ref = this.page();
      if (ref && this.question) ref.load(this.exam.id, this.currentPage, this.question, this.focusEntry, this.exam.title);
    },
    page() { return this._pageRef || null; },
    setPageRef(ref) { this._pageRef = ref; },
    renderAll() {
      this.renderIndex();
      this.renderOptions();
      const nav = this.root.querySelector(".bottom-nav");
      if (nav) {
        const resp = nav.querySelector("#respond-btn");
        if (resp && !this.feedback) {
          resp.disabled = !this.selected || this.submitting;
          resp.textContent = this.submitting ? "Enviando..." : "Responder";
        }
        const fin = nav.querySelector("#finish-btn");
        if (fin) {
          fin.disabled = !this.allAnswered;
          fin.textContent = this.allAnswered ? "Finalizar prova" : `Faltam ${this.total - this.answeredCount} questões`;
        }
      }
    },
    renderIndex() {
      const grid = this.indexGridEl;
      if (!grid || !this.question) return;
      grid.innerHTML = this.questions.map((q, i) => {
        const r = this.results[q.id];
        const cls = `index-btn${i === this.currentIdx ? " active" : ""}${r === "correct" ? " correct-answer" : r === "wrong" ? " wrong-answer" : ""}`;
        return `<button class="${cls}" data-i="${i}">${String(q.number).padStart(2, "0")}</button>`;
      }).join("");
      grid.onclick = (e) => {
        const btn = e.target.closest("[data-i]");
        if (!btn) return;
        this.feedback = null;
        this.currentIdx = Number(btn.dataset.i);
      };
    },
    renderOptions() {
      const host = this.root.querySelector("#options-host");
      if (!host || !this.question) return;
      host.innerHTML = this.question.alternatives.map((alt) => {
        const isSelected = this.selected === alt.label;
        const isCorrectAnswer = this.feedback && this.feedback.correctAnswer === alt.label;
        const isWrongSelected = this.feedback && isSelected && !this.feedback.correct;
        const isUnknown = this.feedback?.unknown === true;
        let cls = "option";
        if (isSelected && !this.feedback) cls += " selected";
        if (this.feedback && !isUnknown && isCorrectAnswer) cls += " correct-highlight";
        if (!isUnknown && isWrongSelected) cls += " wrong-highlight";
        if (this.feedback) cls += " disabled";
        const marker = this.feedback
          ? `<div class="option-letter">(${esc(alt.label)})</div>`
          : `<label class="radio-wrapper-8" for="radio-${this.question.id}-${esc(alt.label)}"><input id="radio-${this.question.id}-${esc(alt.label)}" type="radio" name="respostaAluno" ${isSelected ? "checked" : ""} readonly /><span></span></label>`;
        return `<div class="${cls}" data-label="${esc(alt.label)}">${marker}<div class="option-text texto-questao">${esc(alt.text)}</div></div>`;
      }).join("");
      host.onclick = (e) => {
        const opt = e.target.closest("[data-label]");
        if (!opt || this.feedback) return;
        this.answers = { ...this.answers, [this.question.id]: opt.dataset.label };
        this.renderAll();
      };
    },
    async submitAnswer() {
      const q = this.question;
      if (!q || !this.answers[q.id] || this.submitting) return;
      this.submitting = true;
      this.feedback = null;
      this.renderAll();
      try {
        const res = await fetch(`${API}/questions/${q.id}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: this.answers[q.id], elapsedSeconds: 0 }),
        });
        const data = await res.json();
        if (data.isCorrect === null || data.isCorrect === undefined) {
          this.feedback = { correct: false, correctAnswer: "?", unknown: true };
        } else {
          const isCorrect = data.isCorrect === true;
          this.feedback = { correct: isCorrect, correctAnswer: data.correctAnswer ?? "?" };
          this.results = { ...this.results, [q.id]: isCorrect ? "correct" : "wrong" };
        }
      } catch (e) {
        this.feedback = { correct: false, correctAnswer: "?" };
        this.results = { ...this.results, [q.id]: "wrong" };
      } finally {
        this.submitting = false;
        this.renderAll();
      }
    },
    goNext() { if (this.currentIdx < this.total - 1) { this.feedback = null; this.currentIdx += 1; } },
    goPrev() { if (this.currentIdx > 0) { this.feedback = null; this.currentIdx -= 1; } },
    finishExam() {
      if (!this.allAnswered) return;
      Alpine.store("app").setView("performance");
    },
  }));

  // ---- page reference (foco) ----
  Alpine.data("pageRef", () => ({
    zoom: 1,
    src: null,
    dragging: false,
    pdfOpen: false,
    examId: 0,
    page: 0,
    questionNumber: 0,
    focus: null,
    faixaFixa: false,
    faixaTimer: undefined,
    focoTentativas: 0,
    drag: null,
    init() {
      this.viewportEl = this.$el.querySelector('[x-ref="viewport"]');
      this.paginaEl = this.$el.querySelector('[x-ref="pagina"]');
      this.faixaEl = this.$el.querySelector('[x-ref="faixa"]');
      const solveEl = this.$el.closest(".solve");
      const solve = solveEl ? Alpine.$data(solveEl) : null;
      if (solve) {
        solve.setPageRef(this);
        if (solve.question) this.load(solve.exam.id, solve.currentPage, solve.question, solve.focusEntry, solve.exam.title);
      }
    },
    load(examId, page, question, focus, examTitle) {
      this.examId = examId;
      this.page = page;
      this.questionNumber = question.number;
      this.focus = focus;
      this.examTitle = examTitle || `Questão ${question.number}`;
      this.focoTentativas = 0;
      this.src = null;
      let alive = true;
      this._alive = alive;
      getPageSrc(examId, page).then(
        (value) => { if (this._alive) { this.src = value; } },
        () => { if (this._alive) this.src = `${API}/exams/${examId}/pages/${page}`; }
      );
      warmPdfReader(examId);
      this.$nextTick(() => this.aplicarFoco());
    },
    destroy() { this._alive = false; },
    aplicarFoco() {
      const container = this.viewportEl;
      const pagina = this.paginaEl;
      if (!container || !pagina) return;
      if (!pagina.clientHeight) {
        if (this.focoTentativas < 120) {
          this.focoTentativas += 1;
          requestAnimationFrame(() => this.aplicarFoco());
        }
        return;
      }
      this.focoTentativas = 0;
      const faixaEl = this.faixaEl;
      const focus = this.focus;
      if (focus?.y_inicio == null) {
        if (faixaEl) faixaEl.classList.remove("ativa");
        return;
      }
      const alvo = (focus.y_inicio / 100) * pagina.clientHeight;
      const alvoTop = Math.max(0, alvo - container.clientHeight * 0.22);
      const alvoLeft = Number.isFinite(focus.x_center)
        ? Math.max(0, pagina.offsetLeft + (focus.x_center / 100) * pagina.clientWidth - container.clientWidth * 0.5)
        : container.scrollLeft;
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const isLaggy = navigator.deviceMemory !== undefined && navigator.deviceMemory < 4;
      if (prefersReduced || isLaggy) {
        container.scrollTop = alvoTop;
        container.scrollLeft = alvoLeft;
      } else if ("scrollBehavior" in document.documentElement.style) {
        try { container.scrollTo({ top: alvoTop, left: alvoLeft, behavior: "smooth" }); } catch { container.scrollTop = alvoTop; container.scrollLeft = alvoLeft; }
      } else {
        const startTop = container.scrollTop;
        const startLeft = container.scrollLeft;
        const dTop = alvoTop - startTop;
        const dLeft = alvoLeft - startLeft;
        const dur = 260;
        let t0 = null;
        const step = (t) => {
          if (t0 === null) t0 = t;
          const p = Math.min(1, (t - t0) / dur);
          const e = 1 - Math.pow(1 - p, 3);
          container.scrollTop = startTop + dTop * e;
          container.scrollLeft = startLeft + dLeft * e;
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      if (faixaEl) {
        const alturaPrecisa = Number.isFinite(focus.focus_height) && focus.focus_height ? focus.focus_height / 100 : null;
        const alturaBloco = focus.focus_scale ? Math.min(0.34, Math.max(0.16, 0.86 / focus.focus_scale)) : 0.24;
        const alturaBase = Math.max(88, Math.round((alturaPrecisa ?? alturaBloco) * pagina.clientHeight));
        const limiteEstimado = alturaPrecisa ? pagina.clientHeight : Math.round(container.clientHeight * 0.86);
        const base = Math.min(alturaBase, Math.max(88, limiteEstimado), Math.max(88, pagina.clientHeight - alvo));
        const alturaFaixa = Math.min(pagina.clientHeight - Math.max(0, alvo - 4), base + 12);
        faixaEl.style.top = `${Math.max(0, alvo - 4)}px`;
        faixaEl.style.height = `${alturaFaixa}px`;
        if (Number.isFinite(focus.x_center)) {
          if (focus.x_center > 45 && focus.x_center < 55) {
            faixaEl.style.left = "0";
            faixaEl.style.right = "0";
          } else {
            const ladoEsquerdo = focus.x_center < 50;
            faixaEl.style.left = ladoEsquerdo ? "0" : "50%";
            faixaEl.style.right = ladoEsquerdo ? "50%" : "0";
          }
        } else {
          faixaEl.style.left = "0";
          faixaEl.style.right = "0";
        }
        const rot = ((this.questionNumber * 13) % 7 - 3) * 0.09;
        faixaEl.style.setProperty("--faixa-rotate", `${rot.toFixed(2)}deg`);
        window.clearTimeout(this.faixaTimer);
        faixaEl.classList.remove("ativa");
        void faixaEl.offsetWidth;
        faixaEl.classList.add("ativa");
        if (!this.faixaFixa) {
          this.faixaTimer = window.setTimeout(() => faixaEl.classList.remove("ativa"), 1800);
        }
      }
    },
    warm() { warmPdfReader(this.examId, true); },
    openPdf() {
      this.pdfOpen = true;
      PdfModal.open(this.examId, this.examTitle || `Questão ${this.questionNumber}`, () => { this.pdfOpen = false; });
    },
    changeZoom(d) {
      this.zoom = Math.min(4, Math.max(1, Math.round((this.zoom + d) * 100) / 100));
      this.$nextTick(() => this.aplicarFoco());
    },
    toggleFixa() {
      const el = this.faixaEl;
      if (!el) return;
      const isActive = el.classList.contains("ativa");
      window.clearTimeout(this.faixaTimer);
      if (isActive) {
        el.classList.remove("ativa");
        this.faixaFixa = false;
      } else {
        this.faixaFixa = true;
        this.aplicarFoco();
        setTimeout(() => window.clearTimeout(this.faixaTimer), 60);
      }
    },
    pointerDown(e) {
      const container = this.viewportEl;
      if (!container) return;
      this.drag = { x: e.clientX, y: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop };
      this.dragging = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    pointerMove(e) {
      const container = this.viewportEl;
      const start = this.drag;
      if (!container || !start) return;
      container.scrollLeft = start.scrollLeft - (e.clientX - start.x);
      container.scrollTop = start.scrollTop - (e.clientY - start.y);
    },
    pointerUp(e) {
      this.drag = null;
      this.dragging = false;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    },
  }));

  function stopClock() {}
  Alpine.data("examClock", () => ({
    time: "00:00:00",
    startedAt: 0,
    timer: null,
    init() {
      const el = this.$el;
      this.startedAt = performance.now();
      const tick = () => { this.time = formatTimer(Math.floor((performance.now() - this.startedAt) / 1000)); };
      tick();
      const id = window.setInterval(tick, 250);
      this.timer = id;
      const obs = new MutationObserver(() => {
        if (!document.contains(el)) {
          window.clearInterval(id);
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      el._clockCleanup = () => { window.clearInterval(id); obs.disconnect(); };
    },
  }));
Alpine.start();

// ---- exam card (HTML + wiring, estado local por cartão) ----
function examCardHtml(item) {
  const answered = Number(item.answered_count ?? 0);
  const correct = Number(item.correct_count ?? 0);
  const wrong = Number(item.wrong_count ?? 0);
  const total = Number(item.question_count ?? 0);
  const progress = total ? Math.min(100, Math.round((answered / total) * 100)) : 0;
  const completed = total > 0 && answered >= total;
  return `
    <article class="exam-card-v2${completed ? " is-completed" : ""}" data-id="${item.id}">
      <div class="exam-card-visual">
        ${item.logo ? `<img class="exam-card-logo" src="${assetURL(item.logo)}" alt="" />` : `<div class="exam-card-icon ecv2-teal">${ICONS.fileText}</div>`}
        <div class="exam-card-visual-title"><h3>${esc(item.title)}</h3><span>${item.cargo_count ? `${item.cargo_count} cargos` : ""}</span></div>
      </div>
      <div class="exam-card-content"><div class="exam-card-content-inner">
        <div class="exam-card-info-box">
          ${item.created_at ? `<span><b>Prova:</b> <strong class="card-number">${new Date(item.created_at).toLocaleDateString("pt-BR")}</strong></span>` : ""}
          ${item.board ? `<span><b>Banca:</b> ${esc(item.board)}</span>` : ""}
        </div>
        <div class="exam-card-progress-area"><div class="exam-card-progress-top">
          <span class="exam-card-progress-text"><strong>${answered}</strong> de <span class="progress-total">${total}</span> <small>resolvidas</small></span>
          <span class="exam-card-status">${completed ? "Concluído" : "Em andamento"}</span></div>
          <div class="exam-card-progress-bar"><i style="width: ${progress}%"></i></div></div>
        <div class="exam-card-stats">
          <div class="exam-card-stat"><div class="exam-card-stat-icon ecv2-teal">${ICONS.clipboard}</div><div class="exam-card-stat-info"><strong>${answered}</strong><span>Resolvidas</span></div></div>
          <div class="exam-card-stat"><div class="exam-card-stat-icon ecv2-green">${ICONS.check}</div><div class="exam-card-stat-info"><strong>${correct}</strong><span>Acertos</span></div></div>
          <div class="exam-card-stat"><div class="exam-card-stat-icon ecv2-red">${ICONS.x}</div><div class="exam-card-stat-info"><strong>${wrong}</strong><span>Erros</span></div></div>
        </div></div>
        <div class="exam-card-details" hidden>
          ${item.board ? `<div class="exam-card-detail"><strong>Banca:</strong> ${esc(item.board)}</div>` : ""}
          ${item.created_at ? `<div class="exam-card-detail"><strong>Prova:</strong> ${new Date(item.created_at).toLocaleDateString("pt-BR")}</div>` : ""}
        </div>
      </div>
      <footer class="exam-card-footer"><div class="exam-card-actions">
        <button class="exam-card-edit" aria-label="Editar" data-act="edit">${ICONS.pencil}</button>
        <button class="exam-card-remove" aria-label="Remover" data-act="remove">${ICONS.trash}</button>
      </div></footer>
    </article>`;
}

function wireExamCards(box) {
  box.onclick = async (e) => {
    const card = e.target.closest(".exam-card-v2");
    if (!card) return;
    const id = Number(card.dataset.id);
    const app = Alpine.store("app");
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "remove") {
      e.stopPropagation();
      await app.removeExam(id);
      return;
    }
    if (act === "edit") {
      e.stopPropagation();
      openEditModal(id);
      return;
    }
    if (e.target.closest(".exam-card-actions")) return;
    app.openExam(id, "solve");
  };
}

function openEditModal(id) {
  const app = Alpine.store("app");
  const item = app.exams.find((x) => x.id === id);
  if (!item) return;
  const overlay = document.createElement("div");
  overlay.className = "exam-edit-overlay";
  overlay.innerHTML = `
    <div class="exam-edit-modal">
      <div class="exam-edit-header"><h3>Editar prova</h3><button class="exam-edit-close" aria-label="Fechar">${ICONS.x}</button></div>
      <div class="exam-edit-body">
        <div class="exam-edit-field"><label>Título</label><input type="text" data-f="title" value="${esc(item.title)}" /></div>
        <div class="exam-edit-field"><label>Banca</label><input type="text" data-f="board" value="${esc(item.board ?? "")}" placeholder="Ex: FCC, CESPE, VUNESP..." /></div>
        <div class="exam-edit-field"><label>Logo da prova</label><div class="exam-edit-logo-area">
          <img data-role="preview" ${item.logo ? `src="${assetURL(item.logo)}"` : "hidden"} alt="Logo" class="exam-edit-logo-preview" />
          <label class="exam-edit-upload"><input type="file" accept="image/*" hidden /><span>Selecionar imagem</span></label>
        </div></div>
      </div>
      <div class="exam-edit-footer"><button class="exam-edit-cancel">Cancelar</button><button class="exam-edit-save">Salvar</button></div>
    </div>`;
  let logoFile = null;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".exam-edit-close").onclick = close;
  overlay.querySelector(".exam-edit-cancel").onclick = close;
  const fileInput = overlay.querySelector('input[type="file"]');
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    logoFile = f;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = overlay.querySelector('[data-role="preview"]');
      img.src = ev.target?.result;
      img.hidden = false;
      overlay.querySelector(".exam-edit-upload span").textContent = "Trocar imagem";
    };
    reader.readAsDataURL(f);
  };
  const saveBtn = overlay.querySelector(".exam-edit-save");
  const syncSave = () => {
    const title = overlay.querySelector('[data-f="title"]').value;
    saveBtn.disabled = !title.trim() || saveBtn.dataset.busy === "1";
  };
  overlay.querySelector('[data-f="title"]').oninput = syncSave;
  saveBtn.onclick = async () => {
    saveBtn.dataset.busy = "1";
    saveBtn.textContent = "Salvando...";
    syncSave();
    try {
      const fd = new FormData();
      fd.append("title", overlay.querySelector('[data-f="title"]').value);
      fd.append("board", overlay.querySelector('[data-f="board"]').value);
      if (logoFile) fd.append("logo", logoFile);
      const response = await fetch(`${API}/exams/${id}`, { method: "PUT", body: fd });
      if (!response.ok) throw new Error("Erro ao salvar");
      close();
      await app.refresh();
    } catch {
      alert("Erro ao salvar alterações");
    } finally {
      saveBtn.dataset.busy = "";
      saveBtn.textContent = "Salvar";
      syncSave();
    }
  };
  document.body.appendChild(overlay);
}
