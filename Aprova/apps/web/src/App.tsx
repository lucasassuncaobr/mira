import { useEffect, useRef, useState } from "react";
import { BarChart3, BookOpen, Check, ChevronLeft, ChevronRight, Clock3, ClipboardCheck, FileText, Maximize2, Menu, Move, Pencil, RotateCcw, Sparkles, Trash2, UploadCloud, X, ZoomIn, ZoomOut } from "lucide-react";

const API = "http://localhost:3333/api";
type Alternative = { label: string; text: string };
type Question = { id: number; number: number; statement: string; alternatives: Alternative[]; correct_answer: string | null; subject: string | null; topic: string | null; page_number?: number | null; context?: string | null };
type Exam = { id: number; title: string; filename: string; board?: string | null; status: string; created_at?: string; question_count?: number; answered_count?: number; correct_count?: number; wrong_count?: number; study_seconds?: number; logo?: string | null; questions?: Question[] };
type View = "dashboard" | "exams" | "performance" | "import" | "review" | "solve";

export function App() {
  const [view, setView] = useState<View>("exams");
  const [exams, setExams] = useState<Exam[]>([]);
  const [exam, setExam] = useState<Exam | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const historyReady = useRef(false);
  const historyView = useRef<View | null>(null);

  async function refresh() {
    const response = await fetch(`${API}/exams`);
    setExams(await response.json());
    setError("");
  }
  useEffect(() => { refresh().catch(() => setError("A API não está disponível.")); }, []);
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    const match = hash.match(/^(solve)(?:\/(\d+))?$/);
    const plainView = ["exams", "performance", "import", "review", "solve"].includes(hash);
    const initialView: View = match ? "solve" : (plainView ? hash as View : "exams");
    const examId = match?.[2];
    historyView.current = initialView;
    setView(initialView);
    historyReady.current = true;
    if (examId) {
      fetch(`${API}/exams/${examId}`).then(r => r.json()).then(setExam).catch(() => undefined);
    }
    window.history.replaceState({ view: initialView, examId: examId ? Number(examId) : undefined }, "", `${window.location.pathname}#${initialView}${examId ? "/" + examId : ""}`);
    const restore = (event: PopStateEvent) => {
      const state = event.state as { view?: View; examId?: number } | null;
      const target = state?.view;
      const restoredView = target && ["exams", "performance", "import", "review", "solve"].includes(target) ? target : "exams";
      historyView.current = restoredView;
      setView(restoredView);
      if (state?.examId && restoredView === "solve") {
        fetch(`${API}/exams/${state.examId}`).then(r => r.json()).then(setExam).catch(() => undefined);
      } else {
        setExam(null);
      }
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!historyReady.current) return;
    if (historyView.current === view) return;
    const currentHash = window.location.hash.replace("#", "");
    const hashMatch = currentHash.match(/^(solve)(?:\/(\d+))?$/);
    const examId = hashMatch?.[2];
    window.history.pushState({ view, examId: examId ? Number(examId) : undefined }, "", `${window.location.pathname}#${view}${examId ? "/" + examId : ""}`);
    historyView.current = view;
  }, [view]);
  const fallbackAttempted = useRef(false);
  const examsRef = useRef(exams);
  examsRef.current = exams;
  useEffect(() => {
    if (view !== "solve" || exam || fallbackAttempted.current) return;
    fallbackAttempted.current = true;
    refresh().then(() => {
      const currentExams = examsRef.current;
      if (currentExams.length > 0) {
        const fallbackId = currentExams[0].id;
        window.history.replaceState({ view: "solve", examId: fallbackId }, "", `${window.location.pathname}#solve/${fallbackId}`);
        fetch(`${API}/exams/${fallbackId}`).then(r => r.json()).then(setExam).catch(() => undefined);
      }
    });
  }, [view]);
  async function openExam(id: number, nextView: View) {
    const response = await fetch(`${API}/exams/${id}`); setExam(await response.json()); setView(nextView);
    window.history.replaceState({ view: nextView, examId: id }, "", `${window.location.pathname}#${nextView}/${id}`);
    historyView.current = nextView;
  }
  async function removeExam(id: number) {
    if (!window.confirm("Remover esta prova e todo o histórico dela?")) return;
    const response = await fetch(`${API}/exams/${id}`, { method: "DELETE" });
    if (!response.ok) return setError("Não foi possível remover a prova.");
    await refresh();
  }

  return <div className={`app-shell view-${view}`}>
    <div className="topbar"><div className="topbar-inner">
      <div className="brand"><div className="brand-lockup"><span className="brand-name">Mira</span><small>estudos</small></div></div>
      <nav>
        <Nav active={view === "exams"} icon={<BookOpen/>} label="Provas" onClick={() => setView("exams")}/>
        <Nav active={view === "performance"} icon={<BarChart3/>} label="Desempenho" onClick={() => setView("performance")}/>
      </nav>
      <button className="primary compact top-import" onClick={() => setView("import")}><UploadCloud size={18}/> Importar prova</button>
      <div className="profile"><div className="avatar">LA</div><div><strong>Lucas</strong></div><Menu size={18}/></div>
    </div></div>
    <main>
      <header><div><span className="eyebrow">PLATAFORMA DE ESTUDOS</span><h1>{titles[view]}</h1></div></header>
      {error && <div className="alert"><X size={18}/>{error}</div>}
      {(view === "dashboard" || view === "exams") && <Dashboard exams={exams} onImport={() => setView("import")} onOpen={(id) => openExam(id, "solve")} onReview={(id) => openExam(id, "review")} onRemove={removeExam} onRefresh={refresh}/>} 
      {view === "performance" && <Performance exams={exams} onOpen={(id) => openExam(id, "solve")}/>} 
      {view === "import" && <Import loading={loading} setLoading={setLoading} onDone={async (id) => { await refresh(); await openExam(id, "review"); }} onError={setError}/>} 
      {view === "review" && exam?.questions && <Review exam={exam} onChange={setExam} onSolve={() => setView("solve")}/>} 
      {view === "solve" && (exam ? <Solve key={exam.id} exam={exam} onFinish={() => setView("performance")}/> : <div className="panel" style={{padding: 40, textAlign: "center", color: "#6C7480"}}>Carregando prova...</div>)} 
    </main>
  </div>;
}

const titles: Record<View, string> = { dashboard: "Sua preparação, em um só lugar", exams: "Suas provas", performance: "Seu desempenho", import: "Importar nova prova", review: "Revisar questões", solve: "Resolver prova" };
function Nav({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) { return <button className={active ? "nav active" : "nav"} onClick={onClick}>{icon}<span>{label}</span></button>; }

function Dashboard({ exams, onImport, onOpen, onReview, onRemove, onRefresh }: { exams: Exam[]; onImport: () => void; onOpen: (id: number) => void; onReview: (id: number) => void; onRemove: (id: number) => void; onRefresh: () => void }) {
  const answered = exams.reduce((sum, item) => sum + Number(item.answered_count ?? 0), 0);
  const correct = exams.reduce((sum, item) => sum + Number(item.correct_count ?? 0), 0);
  const studySeconds = exams.reduce((sum, item) => sum + Number(item.study_seconds ?? 0), 0);
  const accuracy = answered ? Math.round((correct / answered) * 100) : 0;
  return <section>
    <div className="stats"><Stat tone="blue" icon={<FileText/>} value={String(exams.length)} label="Provas importadas"/><Stat tone="green" icon={<BookOpen/>} value={String(answered)} label="Questões resolvidas"/><Stat tone="neutral" icon={<Clock3/>} value={formatStudyTime(studySeconds)} label="Tempo de estudo"/><Stat tone={accuracy >= 70 ? "green" : accuracy >= 50 ? "amber" : "red"} icon={<BarChart3/>} value={answered ? `${accuracy}%` : "—"} label="Taxa de acerto"/></div>
    <div className="dashboard-study-grid"><div className="dashboard-study-main"><div className="study-create dashboard-study-create"><div><span className="eyebrow">MEUS ESTUDOS</span><h2>Prova</h2><p>Resolva questões, acompanhe seu desempenho e continue exatamente de onde parou.</p></div><div className="notebook-actions"><button className="secondary" onClick={() => exams[0] && onOpen(exams[0].id)} disabled={!exams.length}>Continuar estudo</button><button className="primary" onClick={onImport}>Criar nova prova</button></div></div><div className="section-head"><div><span className="eyebrow">BIBLIOTECA</span><h3>Provas recentes</h3></div></div>{!exams.length ? <div className="empty provas-empty"><div className="empty-icon"><FileText/></div><h3>Nenhuma prova ainda</h3><p>Importe uma prova com gabarito para criar seu primeiro caderno e começar a acompanhar desempenho.</p><button className="primary" onClick={onImport}><UploadCloud size={17}/> Importar primeira prova</button></div> : <div className="exam-list dashboard-exams">{exams.map(item => <ExamCard key={item.id} item={item} onOpen={onOpen} onReview={onReview} onRemove={onRemove} onRefresh={onRefresh}/>)}</div>}</div><aside className="dashboard-side"><StudyHeatmap/><section className="side-card quick-performance glance-performance"><div className="side-title"><div><span className="eyebrow">DESEMPENHO</span><h3>Resumo atual</h3></div></div><strong>{answered ? `${accuracy}%` : "—"}</strong><span>Aproveitamento geral</span><div className="quick-track"><i style={{ width: `${accuracy}%` }}/></div><small>{correct} acertos em {answered} resoluções</small></section></aside></div>
  </section>;
}
function Stat({ icon, value, label, tone = "blue" }: { icon: React.ReactNode; value: string; label: string; tone?: "blue" | "green" | "neutral" | "amber" | "red" }) { return <div className={`stat stat-${tone}`}><div className="stat-icon">{icon}</div><div><strong>{value}</strong><span>{label}</span></div></div>; }
function formatStudyTime(seconds: number) { if (seconds < 60) return "0min"; if (seconds < 3600) return `${Math.floor(seconds / 60)}min`; return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min`; }

type ActivityDay = { date: string; label: string; count: number };
function StudyHeatmap() {
  const [activity, setActivity] = useState<ActivityDay[]>([]);
  useEffect(() => { fetch(`${API}/activity`).then((response) => response.json()).then(setActivity).catch(() => setActivity([])); }, []);
  const visibleActivity = activity.slice(-84);
  const heatmapCells: Array<ActivityDay | null> = [...Array(Math.max(0, 84 - visibleActivity.length)).fill(null), ...visibleActivity].slice(-84);
  const activeDays = visibleActivity.filter((day) => day.count > 0).length; const total = visibleActivity.reduce((sum, day) => sum + day.count, 0);
  return <section className="side-card consistency modern-heatmap"><div className="side-title"><div><span className="eyebrow">CONSTÂNCIA</span><h3>Ritmo de estudo</h3></div><span className="activity-total">{total} questões</span></div><div className="heatmap-scroll"><div className="consistency-grid compact-heatmap">{heatmapCells.map((day, index) => <i key={day?.date ?? `empty-${index}`} className={`level-${Math.min(4, day?.count ?? 0)}`} title={day ? `${day.label}: ${day.count} ${day.count === 1 ? "questão" : "questões"}` : "Sem registro"}/>)}</div></div><div className="heatmap-footer"><span>{activeDays} dias ativos</span><div><small>Menos</small>{[0,1,2,3,4].map((level) => <i className={`level-${level}`} key={level}/>)}<small>Mais</small></div></div></section>;
}

type DailyPerformance = { day: string; answered: number; correct: number; wrong: number; seconds: number };
function Performance({ exams, onOpen }: { exams: Exam[]; onOpen: (id: number) => void }) {
  const [days, setDays] = useState<DailyPerformance[]>([]);
  const [scoreMode, setScoreMode] = useState<"normal" | "liquid">("normal");
  useEffect(() => { fetch(`${API}/performance`).then((response) => response.json()).then(setDays).catch(() => setDays([])); }, []);
  const total = exams.reduce((sum, item) => sum + Number(item.question_count ?? 0), 0); const answered = exams.reduce((sum, item) => sum + Number(item.answered_count ?? 0), 0); const correct = exams.reduce((sum, item) => sum + Number(item.correct_count ?? 0), 0); const wrong = exams.reduce((sum, item) => sum + Number(item.wrong_count ?? 0), 0); const blank = Math.max(0, total - answered); const seconds = exams.reduce((sum, item) => sum + Number(item.study_seconds ?? 0), 0); const accuracy = answered ? Math.round(correct / answered * 100) : 0; const liquidScore = answered ? Math.max(0, Math.round((correct - wrong) / answered * 100)) : 0; const displayedScore = scoreMode === "normal" ? accuracy : liquidScore; const completion = total ? Math.round(answered / total * 100) : 0; const averageSeconds = answered ? Math.round(seconds / answered) : 0; const maxDay = Math.max(1, ...days.map((day) => day.answered));
  return <section className="performance-page"><div className="performance-controls"><div><b>Exibir</b><span className="control-active">Todas as questões</span></div><div><b>Pontuação</b><button className={scoreMode === "normal" ? "active" : ""} onClick={() => setScoreMode("normal")}>Normal</button><button className={scoreMode === "liquid" ? "active" : ""} onClick={() => setScoreMode("liquid")}>Líquida</button></div></div><div className="notebook-analytics"><aside className="notebook-totals"><h2>Resumo dos cadernos</h2><dl><div><dt>Questões</dt><dd>{total}</dd></div><div><dt>Resolvidas</dt><dd>{answered}</dd></div><div className="correct-row"><dt>Acertos</dt><dd>{correct}</dd></div><div className="wrong-row"><dt>Erros</dt><dd>{wrong}</dd></div><div><dt>Em branco</dt><dd>{blank}</dd></div></dl><div className="time-totals"><span>Tempo total <b>{formatTimer(seconds)}</b></span><span>Tempo médio por questão <b>{formatTimer(averageSeconds)}</b></span></div><div className="completion-block"><div><span>Progresso de estudo</span><b>{completion}%</b></div><div className="completion-bar"><i style={{ width: `${completion}%` }}/></div></div></aside><div className="donut-area"><PerformanceDonut title="Seu desempenho" value={displayedScore} correct={accuracy} wrong={answered ? 100 - accuracy : 0}/><PerformanceDonut title="Meta de aprovação" value={75} correct={75} wrong={25} goal/><div className="mastery"><strong>Índice de domínio</strong><div><i style={{ left: `${Math.min(100, Math.round((accuracy + completion) / 2))}%` }}/></div><span>{Math.round((accuracy + completion) / 2)}%</span></div></div></div><div className="performance-grid"><article className="performance-panel"><div className="panel-heading"><div><span className="eyebrow">ÚLTIMOS 7 DIAS</span><h2>Evolução</h2></div><span>{days.reduce((sum, day) => sum + day.answered, 0)} resoluções</span></div><div className="weekly-chart">{days.map((day) => <div className="day-column" key={day.day}><div className="bar-track"><i style={{ height: `${Math.max(day.answered ? 8 : 2, day.answered / maxDay * 100)}%` }}/></div><strong>{day.answered}</strong><span>{day.day}</span></div>)}</div></article><article className="performance-panel comparison"><div className="panel-heading"><div><span className="eyebrow">POR PROVA</span><h2>Seus cadernos</h2></div></div><div className="exam-ranking">{exams.map((item) => { const done = Number(item.answered_count ?? 0); const hits = Number(item.correct_count ?? 0); const rate = done ? Math.round(hits / done * 100) : 0; return <button key={item.id} onClick={() => onOpen(item.id)}><div><strong>{item.title}</strong><span>{done} resolvidas • {hits} acertos</span></div><div className="rank-rate"><b>{done ? `${rate}%` : "—"}</b><ChevronRight/></div></button>; })}</div></article></div></section>;
}

function PerformanceDonut({ title, value, correct, wrong, goal = false }: { title: string; value: number; correct: number; wrong: number; goal?: boolean }) { return <div className="donut-card"><h3>{title}</h3><div className="performance-donut" style={{ "--donut": `${correct * 3.6}deg` } as React.CSSProperties}><div><strong>{value}%</strong><span>{goal ? "Referência" : "Pontuação"}</span></div></div><div className="donut-legend"><span><i className="green"/>Acertos {correct}%</span><span><i className="red"/>Erros {wrong}%</span></div></div>; }

function ExamLibrary({ exams, onImport, onOpen, onReview, onRemove, onRefresh }: { exams: Exam[]; onImport: () => void; onOpen: (id: number) => void; onReview: (id: number) => void; onRemove: (id: number) => void; onRefresh: () => void }) {
  const [query, setQuery] = useState(""); const [order, setOrder] = useState("recent");
  const visible = exams.filter((item) => item.title.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR"))).sort((a, b) => order === "title" ? a.title.localeCompare(b.title, "pt-BR") : b.id - a.id);
  const answered = exams.reduce((sum, item) => sum + Number(item.answered_count ?? 0), 0); const correct = exams.reduce((sum, item) => sum + Number(item.correct_count ?? 0), 0); const accuracy = answered ? Math.round(correct / answered * 100) : 0;
  return <section className="library portal-library"><div className="library-portal-grid"><div className="library-main"><section className="content-library"><div className="content-title"><div><h3>Adicionar conteúdo para estudo</h3><p>Suas provas importadas e prontas para resolução.</p></div><span>{exams.length} {exams.length === 1 ? "caderno" : "cadernos"}</span></div><div className="library-tools"><label><span>Buscar</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, cidade ou cargo"/></label><label><span>Organizar</span><select value={order} onChange={(event) => setOrder(event.target.value)}><option value="recent">Recentes</option><option value="title">A–Z</option></select></label></div>{!exams.length ? <div className="empty"><h3>Nenhuma prova</h3><p>Importe prova e gabarito para começar.</p></div> : visible.length ? <div className="exam-grid portal-exams">{visible.map(item => <ExamCard key={item.id} item={item} onOpen={onOpen} onReview={onReview} onRemove={onRemove} onRefresh={onRefresh}/>)}</div> : <div className="empty compact-empty"><h3>Nenhuma prova encontrada</h3></div>}</section></div><aside className="library-aside"><StudyHeatmap/><section className="portal-performance"><div><span className="eyebrow">DESEMPENHO</span><h3>Resumo dos estudos</h3></div><strong>{answered ? `${accuracy}%` : "—"}</strong><span>{answered} questões resolvidas</span><div><i style={{ width: `${accuracy}%` }}/></div></section></aside></div></section>;
}

function ExamCard({ item, onOpen, onReview: _onReview, onRemove, onRefresh }: { item: Exam; onOpen: (id: number) => void; onReview: (id: number) => void; onRemove: (id: number) => void; onRefresh?: () => void }) {
  const answered = Number(item.answered_count ?? 0);
  const correct = Number(item.correct_count ?? 0);
  const wrong = Number(item.wrong_count ?? 0);
  const total = Number(item.question_count ?? 0);
  const progress = total ? Math.min(100, Math.round((answered / total) * 100)) : 0;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item.title);
  const [editBoard, setEditBoard] = useState(item.board ?? "");
  const [editLogo, setEditLogo] = useState<File | null>(null);
  const [editLogoPreview, setEditLogoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function handleCardClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('.exam-card-actions') || (e.target as HTMLElement).closest('.exam-card-chevron')) return;
    onOpen(item.id);
  }

  function handleChevronClick(e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded(!expanded);
  }

  function handleEditClick(e: React.MouseEvent) {
    e.stopPropagation();
    setEditTitle(item.title);
    setEditBoard(item.board ?? "");
    setEditLogo(null);
    setEditLogoPreview(null);
    setEditing(true);
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setEditLogo(file);
      const reader = new FileReader();
      reader.onload = (ev) => setEditLogoPreview(ev.target?.result as string);
      reader.readAsDataURL(file);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append("title", editTitle);
      formData.append("board", editBoard);
      if (editLogo) formData.append("logo", editLogo);
      const response = await fetch(`${API}/exams/${item.id}`, { method: "PUT", body: formData });
      if (!response.ok) throw new Error("Erro ao salvar");
      setEditing(false);
      onRefresh?.();
    } catch (err) {
      alert("Erro ao salvar alterações");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <article className={`exam-card-v2 ${expanded ? 'exam-card-expanded' : ''}`} onClick={handleCardClick}>
      <div className="exam-card-visual">
        <div className="exam-card-icon ecv2-teal"><FileText size={24} strokeWidth={1.5} /></div>
      </div>

      <div className="exam-card-content">
        <div className="exam-card-content-inner">
          <div className="exam-card-header">
            <div className="exam-card-header-text">
              <h3>{item.title}</h3>
              {item.board && <span className="exam-card-board">{item.board}</span>}
            </div>
            <button className={`exam-card-chevron ${expanded ? 'expanded' : ''}`} onClick={handleChevronClick} aria-label="Expandir">
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="exam-card-progress-area">
            <div className="exam-card-progress-top">
              <span className="exam-card-progress-text">
                <strong>{answered}</strong> de <span className="progress-total">{total}</span>
                <small>resolvidas</small>
              </span>
              <span className="exam-card-status">
                {answered ? "Concluído" : "Aguardando respostas"}
              </span>
            </div>
            <div className="exam-card-progress-bar">
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="exam-card-stats">
            <div className="exam-card-stat">
              <div className="exam-card-stat-icon ecv2-teal"><ClipboardCheck size={16} strokeWidth={2} /></div>
              <div className="exam-card-stat-info">
                <strong>{answered}</strong>
                <span>Resolvidas</span>
              </div>
            </div>
            <div className="exam-card-stat">
              <div className="exam-card-stat-icon ecv2-green"><Check size={16} strokeWidth={2} /></div>
              <div className="exam-card-stat-info">
                <strong>{correct}</strong>
                <span>Acertos</span>
              </div>
            </div>
            <div className="exam-card-stat">
              <div className="exam-card-stat-icon ecv2-red"><X size={16} strokeWidth={2} /></div>
              <div className="exam-card-stat-info">
                <strong>{wrong}</strong>
                <span>Erros</span>
              </div>
            </div>
          </div>
        </div>

        {expanded && (
          <div className="exam-card-details">
            {item.board && <div className="exam-card-detail"><strong>Banca:</strong> {item.board}</div>}
            {item.created_at && <div className="exam-card-detail"><strong>Prova:</strong> {new Date(item.created_at).toLocaleDateString('pt-BR')}</div>}
          </div>
        )}
      </div>

      <footer className="exam-card-footer">
        <div className="exam-card-actions">
          <button className="exam-card-edit" aria-label="Editar" onClick={handleEditClick}>
            <Pencil size={14} />
          </button>
          <button className="exam-card-remove" aria-label="Remover" onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}>
            <Trash2 size={14} />
          </button>
        </div>
      </footer>
    </article>

    {editing && (
      <div className="exam-edit-overlay" onClick={() => setEditing(false)}>
        <div className="exam-edit-modal" onClick={(e) => e.stopPropagation()}>
          <div className="exam-edit-header">
            <h3>Editar prova</h3>
            <button className="exam-edit-close" onClick={() => setEditing(false)}><X size={18}/></button>
          </div>
          <div className="exam-edit-body">
            <div className="exam-edit-field">
              <label>Título</label>
              <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div className="exam-edit-field">
              <label>Banca</label>
              <input type="text" value={editBoard} onChange={(e) => setEditBoard(e.target.value)} placeholder="Ex: FCC, CESPE, VUNESP..." />
            </div>
            <div className="exam-edit-field">
              <label>Logo da prova</label>
              <div className="exam-edit-logo-area">
                {(editLogoPreview || item.logo) && (
                  <img src={editLogoPreview ?? `${API}${item.logo}`} alt="Logo" className="exam-edit-logo-preview" />
                )}
                <label className="exam-edit-upload">
                  <input type="file" accept="image/*" onChange={handleLogoChange} />
                  <UploadCloud size={18} />
                  <span>{editLogoPreview ? "Trocar imagem" : "Selecionar imagem"}</span>
                </label>
              </div>
            </div>
          </div>
          <div className="exam-edit-footer">
            <button className="exam-edit-cancel" onClick={() => setEditing(false)}>Cancelar</button>
            <button className="exam-edit-save" onClick={handleSave} disabled={saving || !editTitle.trim()}>
              {saving ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function Import({ loading, setLoading, onDone, onError }: { loading: boolean; setLoading: (v: boolean) => void; onDone: (id: number) => void; onError: (s: string) => void }) {
  const [examFile, setExamFile] = useState<File | null>(null); const [answerFile, setAnswerFile] = useState<File | null>(null); const [loadingSeconds, setLoadingSeconds] = useState(0);
  useEffect(() => { if (!loading) { setLoadingSeconds(0); return; } const timer = window.setInterval(() => setLoadingSeconds((value) => value + 1), 1000); return () => window.clearInterval(timer); }, [loading]);
  async function send() { if (!examFile || !answerFile) return; setLoading(true); onError(""); const body = new FormData(); body.append("exam", examFile); body.append("answerKey", answerFile); try { const response = await fetch(`${API}/exams/import`, { method: "POST", body }); const data = await response.json(); if (!response.ok) throw new Error(data.error); onDone(data.id); } catch (e) { onError(e instanceof Error ? e.message : "Falha ao importar"); } finally { setLoading(false); } }
  return <div className="panel import-panel"><div className="steps"><span className="current">1</span><i className={examFile ? "done" : ""}></i><span className={answerFile ? "current" : ""}>2</span><i className={answerFile ? "done" : ""}></i><span>3</span></div><div className="center-title"><span className="eyebrow">PROVA + GABARITO</span><h2>Crie uma prova completa</h2><p>Envie os dois PDFs. O título, as questões e as respostas serão identificados automaticamente.</p></div><div className="upload-grid"><UploadField label="1. PDF da prova" hint="Questões e alternativas" file={examFile} onChange={setExamFile}/><UploadField label="2. PDF do gabarito" hint="Respostas oficiais" file={answerFile} onChange={setAnswerFile}/></div><div className="smart-note"><Sparkles size={18}/><div><strong>{loading ? (loadingSeconds < 8 ? "Lendo os PDFs" : "Aplicando OCR quando necessário") : "Título inteligente"}</strong><span>{loading ? `Processamento em andamento • ${formatTimer(loadingSeconds)}` : "Vamos analisar o conteúdo da prova e criar um nome organizado para ela."}</span></div></div><button className="primary wide" disabled={!examFile || !answerFile || loading} onClick={send}>{loading ? "Processando prova e gabarito..." : "Gerar minha prova"}<ChevronRight size={18}/></button><small className="privacy">{loading ? "Mantenha esta página aberta. PDFs escaneados podem levar alguns minutos." : "A prova só será criada depois que os dois arquivos forem enviados."}</small></div>;
}

function UploadField({ label, hint, file, onChange }: { label: string; hint: string; file: File | null; onChange: (file: File | null) => void }) { return <label className={file ? "dropzone selected" : "dropzone"}><input type="file" accept="application/pdf" onChange={e => onChange(e.target.files?.[0] ?? null)}/><span className="upload-label">{label}</span><div className="upload-icon">{file ? <Check/> : <UploadCloud/>}</div><h3>{file ? file.name : "Selecionar PDF"}</h3><p>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : hint}</p><span>PDF • máximo 20 MB</span></label>; }

function Review({ exam, onChange, onSolve }: { exam: Exam & { questions?: Question[] }; onChange: (e: Exam) => void; onSolve: () => void }) {
  const questions = exam.questions ?? []; const [selected, setSelected] = useState(0); const question = questions[selected]; const [saving, setSaving] = useState(false);
  function patch(changes: Partial<Question>) { const copy = [...questions]; copy[selected] = { ...question, ...changes }; onChange({ ...exam, questions: copy }); }
  async function save() { setSaving(true); await fetch(`${API}/questions/${question.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statement: question.statement, alternatives: question.alternatives, correctAnswer: question.correct_answer, subject: question.subject, topic: question.topic }) }); setSaving(false); if (selected < questions.length - 1) setSelected(selected + 1); }
  if (!question) return null;
  return <div className="review-layout"><aside className="question-list"><h3>{exam.title}</h3><p>{questions.length} questões encontradas</p><div className="number-grid">{questions.map((q, index) => <button className={index === selected ? "active" : ""} onClick={() => setSelected(index)} key={q.id}>{q.number}</button>)}</div><button className="primary wide" onClick={onSolve}>Começar prova</button></aside><section className="panel editor"><div className="editor-head"><div><span className="eyebrow">QUESTÃO {question.number}</span><h2>Confira as alternativas</h2></div><span className="status">REVISÃO PENDENTE</span></div><div className="alternatives review-choices">{question.alternatives.map((alt, index) => <div className="alternative-edit" key={alt.label}><button className={question.correct_answer === alt.label ? "letter correct" : "letter"} onClick={() => patch({ correct_answer: alt.label })}>{alt.label}</button><textarea value={alt.text} onChange={e => { const alternatives = [...question.alternatives]; alternatives[index] = { ...alt, text: e.target.value }; patch({ alternatives }); }}/></div>)}</div><div className="editor-footer"><span>Clique na letra para definir o gabarito.</span><button className="primary" onClick={save}>{saving ? "Salvando..." : "Salvar e avançar"}<ChevronRight size={18}/></button></div></section></div>;
}

function PageReference({ examId, page, questionNumber }: { examId: number; page: number; questionNumber: number }) {
  const [scale, setScale] = useState(1); const [fitWidthScale, setFitWidthScale] = useState(1); const [focus, setFocus] = useState({ x: .5, y: .15, scale: 2 }); const [position, setPosition] = useState({ x: 0, y: 0 }); const [dragging, setDragging] = useState(false); const viewport = useRef<HTMLDivElement | null>(null); const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  function reset() { setScale(1); setPosition({ x: 0, y: 0 }); }
  function fitWidth(nextScale: number = focus.scale || fitWidthScale, target: { x: number; y: number; scale: number } = focus) { const rect = viewport.current?.getBoundingClientRect(); if (!rect) return; setScale(nextScale); setPosition(clamp({ x: rect.width * nextScale * (.5 - target.x), y: rect.height * nextScale * (.5 - target.y) }, nextScale)); }
  function clamp(next: { x: number; y: number }, nextScale = scale) { const rect = viewport.current?.getBoundingClientRect(); if (!rect || nextScale <= 1) return { x: 0, y: 0 }; const maxX = rect.width * (nextScale - 1) / 2; const maxY = rect.height * (nextScale - 1) / 2; return { x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) }; }
  function zoom(delta: number, clientX?: number, clientY?: number) { const nextScale = Math.min(4, Math.max(1, Number((scale + delta).toFixed(2)))); if (nextScale === scale) return; const rect = viewport.current?.getBoundingClientRect(); if (rect && clientX !== undefined && clientY !== undefined) { const cursor = { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }; const ratio = nextScale / scale; setPosition(clamp({ x: cursor.x - (cursor.x - position.x) * ratio, y: cursor.y - (cursor.y - position.y) * ratio }, nextScale)); } else setPosition((current) => clamp(current, nextScale)); setScale(nextScale); }
  function pointerDown(event: React.PointerEvent<HTMLDivElement>) { if (scale <= 1) return; drag.current = { x: event.clientX, y: event.clientY, originX: position.x, originY: position.y }; setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }
  function pointerMove(event: React.PointerEvent<HTMLDivElement>) { if (!drag.current) return; setPosition(clamp({ x: drag.current.originX + event.clientX - drag.current.x, y: drag.current.originY + event.clientY - drag.current.y })); }
  function pointerUp(event: React.PointerEvent<HTMLDivElement>) { drag.current = null; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  useEffect(() => { fetch(`${API}/exams/${examId}/pages/${page}/focus/${questionNumber}`).then((response) => response.json()).then((target) => { const nextFocus = typeof target.x === "number" && typeof target.y === "number" ? { x: target.x, y: target.y, scale: typeof target.scale === "number" ? target.scale : 2 } : { x: .5, y: .15, scale: 2 }; setFocus(nextFocus); requestAnimationFrame(() => fitWidth(nextFocus.scale, nextFocus)); }).catch(() => { const fallback = { x: .5, y: .15, scale: 2 }; setFocus(fallback); requestAnimationFrame(() => fitWidth(fallback.scale, fallback)); }); }, [examId, page, questionNumber]);
  useEffect(() => { const element = viewport.current; if (!element) return; const handler = (event: WheelEvent) => { event.preventDefault(); zoom(event.deltaY < 0 ? .2 : -.2, event.clientX, event.clientY); }; element.addEventListener("wheel", handler, { passive: false }); return () => element.removeEventListener("wheel", handler); }, [scale, position]);
  return <figure className="page-reference"><figcaption className="image-title"><FileText size={17}/> Questão {questionNumber} no PDF</figcaption><div ref={viewport} className={dragging ? "image-viewport dragging" : "image-viewport"} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setDragging(false); }}><div className="drag-hint"><Move/> Foco automático • arraste para mover</div><img draggable={false} onLoad={(event) => { const rect = viewport.current?.getBoundingClientRect(); if (!rect) return; const renderedWidth = Math.min(rect.width, rect.height * (event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)); const fitted = Math.min(4, rect.width / renderedWidth); setFitWidthScale(fitted); requestAnimationFrame(() => fitWidth(fitted, { x: .5, y: .5, scale: fitted })); }} style={{ transition: "transform 0.15s ease-out", transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }} src={`${API}/exams/${examId}/pages/${page}`} alt={`Página ${page} do PDF original`}/></div><div className="image-toolbar"><span>Zoom {Math.round(scale * 100)}%</span><div><button className="fit-button" onClick={reset}><Maximize2/> Página inteira</button><button className="fit-button" onClick={() => fitWidth()}><FileText/> Focar questão</button><button aria-label="Diminuir zoom" onClick={() => zoom(-.25)}><ZoomOut/></button><button aria-label="Aumentar zoom" onClick={() => zoom(.25)}><ZoomIn/></button><button aria-label="Redefinir imagem" onClick={() => fitWidth()}><RotateCcw/></button></div></div></figure>;
}

function FormattedText({ children }: { children: string }) { return <span className="exam-text">{children}</span>; }

function Solve({ exam, onFinish }: { exam: Exam & { questions?: Question[] }; onFinish: () => void }) {
  const questions = (exam.questions ?? []).filter(
    (q, i, arr) => arr.findIndex((x) => x.number === q.number) === i
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, "correct" | "wrong">>({});
  const [elapsed, setElapsed] = useState(0);
  const [feedback, setFeedback] = useState<{ correct: boolean; correctAnswer: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const question = questions[currentIdx];
  const total = questions.length;
  const indexGridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = indexGridRef.current;
    if (!grid) return;
    const active = grid.querySelector(".index-btn.active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentIdx]);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  function formatClock(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  async function submitAnswer() {
    if (!question || !answers[question.id] || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch(`${API}/questions/${question.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: answers[question.id], elapsedSeconds: 0 }),
      });
      const data = await res.json();
      const isCorrect = data.isCorrect === true;
      setFeedback({ correct: isCorrect, correctAnswer: data.correctAnswer ?? "?" });
      setResults(prev => ({ ...prev, [question.id]: isCorrect ? "correct" : "wrong" }));
    } catch {
      setFeedback({ correct: false, correctAnswer: "?" });
      setResults(prev => ({ ...prev, [question.id]: "wrong" }));
    } finally {
      setSubmitting(false);
    }
  }

  function goNext() {
    if (currentIdx < total - 1) {
      setFeedback(null);
      setCurrentIdx(currentIdx + 1);
    }
  }

  function goPrev() {
    if (currentIdx > 0) {
      setFeedback(null);
      setCurrentIdx(currentIdx - 1);
    }
  }

  const allAnswered = questions.every(q => answers[q.id]);
  const answeredCount = questions.filter(q => answers[q.id]).length;

  function finishExam() {
    if (!allAnswered) return;
    onFinish();
  }

  if (!question) return <div className="panel" style={{ padding: 40, textAlign: "center", color: "#6C7480" }}>Nenhuma questão encontrada.</div>;

  const selected = answers[question.id] ?? null;

  return (
    <div className="solve notranslate" translate="no">
      <div className="solve-workspace">
        <aside className="pdf-column">
          {question.page_number ? (
            <PageReference examId={exam.id} page={question.page_number} questionNumber={question.number} />
          ) : (
            <div className="pdf-empty"><FileText/><span>Página original indisponível</span></div>
          )}
        </aside>
        <section className="question-panel">
          <div className="question-header">
            <h2 className="question-number">Questão {question.number}</h2>
            <div className="clock-container">
              <div className="clock-inner">
                <svg className="clock-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span className="clock-label">TEMPO DE PROVA</span>
                <span className="clock-time">{formatClock(elapsed)}</span>
              </div>
            </div>
          </div>

          <div className="question-index">
            <div className="index-header">
              <span className="index-title">ÍNDICE DE QUESTÕES</span>
              <span className="index-count">{currentIdx + 1}/{total}</span>
            </div>
            <div className="index-grid" ref={indexGridRef}>
              {questions.map((q, i) => {
                const result = results[q.id];
                const statusClass = result === "correct" ? " correct-answer" : result === "wrong" ? " wrong-answer" : "";
                return (
                  <button
                    key={q.id}
                    className={`index-btn${i === currentIdx ? " active" : ""}${statusClass}`}
                    onClick={() => { setFeedback(null); setCurrentIdx(i); }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="answer-section">
            <h3 className="answer-title">ESCOLHA UMA RESPOSTA</h3>
            {question.alternatives.map((alt) => {
              const isSelected = selected === alt.label;
              const isCorrectAnswer = feedback && feedback.correctAnswer === alt.label;
              const isWrongSelected = feedback && isSelected && !feedback.correct;
              let optionClass = "option";
              if (isSelected && !feedback) optionClass += " selected";
              if (feedback && isCorrectAnswer) optionClass += " correct-highlight";
              if (isWrongSelected) optionClass += " wrong-highlight";
              if (feedback) optionClass += " disabled";
              return (
                <div
                  key={alt.label}
                  className={optionClass}
                  onClick={() => { if (!feedback) setAnswers({ ...answers, [question.id]: alt.label }); }}
                >
                  <div className="option-letter">{alt.label}</div>
                  <div className="option-text">{alt.text}</div>
                </div>
              );
            })}
          </div>

          {feedback && (
            <div className={`feedback ${feedback.correct ? "correct" : "incorrect"}`} id="feedback">
              <div className="feedback-icon">{feedback.correct ? <Check size={18}/> : <X size={18}/>}</div>
              <div className="feedback-content">
                <div className="feedback-label">{feedback.correct ? "ACERTOU!" : "ERROU"}</div>
                <div className="feedback-text">{feedback.correct ? "Resposta correta!" : `Gabarito: ${feedback.correctAnswer}`}</div>
              </div>
            </div>
          )}

          <div className={`bottom-nav${feedback ? " feedback-active" : ""}`}>
            <div className="nav-arrows">
              <button className="nav-arrow" id="prev-btn" onClick={goPrev} disabled={currentIdx === 0}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <button className="nav-arrow" id="next-btn" onClick={goNext} disabled={currentIdx === total - 1}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
            {feedback ? (
              currentIdx === total - 1 ? (
                <button className="btn-respond btn-finish" id="finish-btn" onClick={finishExam} disabled={!allAnswered}>
                  {allAnswered ? "Finalizar prova" : `Faltam ${total - answeredCount} questões`}
                </button>
              ) : (
                <button className="btn-respond" id="respond-btn" onClick={goNext}>
                  Próxima
                </button>
              )
            ) : (
              <button className="btn-respond" id="respond-btn" onClick={submitAnswer} disabled={!selected || submitting}>
                {submitting ? "Enviando..." : "Responder"}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function formatTimer(seconds: number) { const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60; return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":"); }
