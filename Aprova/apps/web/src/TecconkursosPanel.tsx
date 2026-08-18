import { useState, useEffect } from "react";
import { Sparkles, BookOpen, Clock3, Award, Target, Github, Library, ChevronRight, Trash2, Search, Quote, Star, Users, BarChart3, FileText, CheckCircle, ClipboardCheck, Check, X, ArrowRight, Pencil } from "lucide-react";

const API = "http://localhost:3333/api";

type Exam = {
  id: number;
  title: string;
  filename: string;
  board?: string | null;
  status: string;
  created_at?: string;
  question_count?: number;
  answered_count?: number;
  correct_count?: number;
  wrong_count?: number;
  study_seconds?: number;
  logo?: string | null;
};

type Concurso = {
  name: string;
  logo: string;
  logoAlt: string;
  description: string;
  href: string;
  initials: string;
  logoBg: string;
};

type Guia = {
  name: string;
  cargos: string;
  prova: string;
  banca: string;
  logo: string;
  href: string;
};

type Depoimento = {
  nome: string;
  cargo: string;
  texto: string;
  cor: string;
};

const concursos: Concurso[] = [
  { name: "Concursos Públicos", logo: "https://cdn.tecconcursos.com.br/img/home2/mundos/bandeira-38.png", logoAlt: "Bandeira do Brasil", description: "Prepare-se para os concursos mais disputados do país", href: "#concursos", initials: "CP", logoBg: "#00467A" },
  { name: "Ordem dos Advogados", logo: "https://cdn.tecconcursos.com.br/img/home2/mundos/oab.jpg", logoAlt: "Logo OAB", description: "Estude para o exame da OAB", href: "#concursos", initials: "OAB", logoBg: "#002C4D" },
  { name: "ENEM e Vestibulares", logo: "https://cdn.tecconcursos.com.br/img/home2/mundos/enem.jpg", logoAlt: "Logo ENEM", description: "Domine o ENEM e os vestibulares", href: "#concursos", initials: "ENEM", logoBg: "#1FB40B" },
  { name: "Concursos Militares", logo: "https://cdn.tecconcursos.com.br/img/home2/mundos/forcas-armadas.png", logoAlt: "Logo Forças Armadas", description: "Conquiste sua vaga nas forças armadas", href: "#concursos", initials: "CM", logoBg: "#001321" },
  { name: "Conselho de Contabilidade", logo: "https://cdn.tecconcursos.com.br/img/home2/mundos/cfc.png", logoAlt: "Logo CFC", description: "Prepare-se para o CFC", href: "#concursos", initials: "CFC", logoBg: "#00A0E8" },
];

const guias: Guia[] = [
  { name: "Pref Santos", cargos: "1 cargo", prova: "11/10/2026", banca: "IBAM", logo: "https://cdn.tecconcursos.com.br/figuras/db7355d6-176a-4bd3-ae63-0fbfcb2f6040", href: "#guias" },
  { name: "CAER", cargos: "9 cargos", prova: "27/11/2026", banca: "AJURI", logo: "https://cdn.tecconcursos.com.br/figuras/fc8b1d4e-3d6c-4bfc-be7f-c33d6b86c6a3", href: "#guias" },
  { name: "UNICAMP", cargos: "1 cargo", prova: "27/09/2026", banca: "FUNCAMP", logo: "https://cdn.tecconcursos.com.br/figuras/1cd9b9fb-b501-47a4-b1ca-a73d5c2212fe", href: "#guias" },
  { name: "POLITEC MA", cargos: "9 cargos", prova: "10/01/2027", banca: "CEBRASPE (CESPE)", logo: "https://cdn.tecconcursos.com.br/figuras/c1a2afdc-54a7-4631-bdbb-595a66cd7f97", href: "#guias" },
  { name: "PROCON AL", cargos: "3 cargos", prova: "29/11/2026", banca: "CEBRASPE (CESPE)", logo: "https://cdn.tecconcursos.com.br/figuras/0f7ab444-fcf8-4f45-a85c-2c94f6e45d99", href: "#guias" },
  { name: "PC MA", cargos: "1 cargo", prova: "01/11/2026", banca: "CEBRASPE (CESPE)", logo: "https://cdn.tecconcursos.com.br/figuras/bbb6bd94-f639-4b49-b15b-58babf80e606", href: "#guias" },
  { name: "PM SC", cargos: "1 cargo", prova: "02/08/2026", banca: "MS (SARMENTO)", logo: "https://cdn.tecconcursos.com.br/figuras/be18e1aa-95b2-40c8-a5ae-2073d0954ef1", href: "#guias" },
  { name: "CM Nilópolis", cargos: "6 cargos", prova: "20/09/2026", banca: "Instituto Seleção", logo: "https://cdn.tecconcursos.com.br/figuras/86f9efc6-f204-419e-9734-be69d299e09b", href: "#guias" },
  { name: "PC MA (2)", cargos: "1 cargo", prova: "06/12/2026", banca: "CEBRASPE (CESPE)", logo: "https://cdn.tecconcursos.com.br/figuras/bbb6bd94-f639-4b49-b15b-58babf80e606", href: "#guias" },
  { name: "CREA MG", cargos: "7 cargos", prova: "20/09/2026", banca: "FUMARC", logo: "https://cdn.tecconcursos.com.br/figuras/fc8b1d4e-3d6c-4bfc-be7f-c33d6b86c6a3", href: "#guias" },
  { name: "CBM RR", cargos: "1 cargo", prova: "20/09/2026", banca: "IDECAN", logo: "https://cdn.tecconcursos.com.br/figuras/c1a2afdc-54a7-4631-bdbb-595a66cd7f97", href: "#guias" },
  { name: "PM MA", cargos: "2 cargos", prova: "11/10/2026", banca: "CEBRASPE (CESPE)", logo: "https://cdn.tecconcursos.com.br/figuras/be18e1aa-95b2-40c8-a5ae-2073d0954ef1", href: "#guias" },
  { name: "Pref Manaus", cargos: "1 cargo", prova: "20/09/2026", banca: "FCC", logo: "https://cdn.tecconcursos.com.br/figuras/1cd9b9fb-b501-47a4-b1ca-a73d5c2212fe", href: "#guias" },
  { name: "Pref Salvador", cargos: "2 cargos", prova: "27/09/2026", banca: "FGV", logo: "https://cdn.tecconcursos.com.br/figuras/86f9efc6-f204-419e-9734-be69d299e09b", href: "#guias" },
  { name: "CBM MA", cargos: "2 cargos", prova: "18/10/2026", banca: "CEBRASPE (CESPE)", logo: "https://cdn.tecconcursos.com.br/figuras/be18e1aa-95b2-40c8-a5ae-2073d0954ef1", href: "#guias" },
  { name: "TC DF", cargos: "1 cargo", prova: "22/11/2026", banca: "CEBRASPE (CESPE)", logo: "https://cdn.tecconcursos.com.br/figuras/c1a2afdc-54a7-4631-bdbb-595a66cd7f97", href: "#guias" },
  { name: "CFC", cargos: "1 cargo", prova: "27/09/2026", banca: "FGV", logo: "https://cdn.tecconcursos.com.br/figuras/db7355d6-176a-4bd3-ae63-0fbfcb2f6040", href: "#guias" },
  { name: "DATAPREV", cargos: "13 cargos", prova: "11/10/2026", banca: "FGV", logo: "https://cdn.tecconcursos.com.br/figuras/0f7ab444-fcf8-4f45-a85c-2c94f6e45d99", href: "#guias" },
  { name: "TCE SP", cargos: "6 cargos", prova: "11/10/2026", banca: "VUNESP", logo: "https://cdn.tecconcursos.com.br/figuras/1cd9b9fb-b501-47a4-b1ca-a73d5c2212fe", href: "#guias" },
  { name: "PM SP", cargos: "1 cargo", prova: "30/08/2026", banca: "FCC", logo: "https://cdn.tecconcursos.com.br/figuras/be18e1aa-95b2-40c8-a5ae-2073d0954ef1", href: "#guias" },
];

const depoimentos: Depoimento[] = [
  { nome: "Elias De Sousa Barbosa Neto", cargo: "270º (AC) - Analista Técnico Administrativo (MGI - 2025)", texto: "A plataforma Tec Concursos foi essencial na minha preparação, principalmente para revisar os conteúdos, fixar o que eu estudava por meio da resolução de questões e acompanhar minhas estatísticas de desempenho.", cor: "#0ea5e9" },
  { nome: "Iago da Silva Gonçalves Pacheco", cargo: "58º (AC) - Escrivão de Polícia Civil (PC SC - 2026)", texto: "A plataforma do TEC foi essencial na minha aprovação, otimizou e potencializou meus estudos.", cor: "#8b5cf6" },
  { nome: "Fernando Lopes dos Anjos", cargo: "105º (CN) - Analista Técnico Administrativo (MGI - 2025)", texto: "Tudo mudou em junho, quando assinei o Tec.", cor: "#10b981" },
  { nome: "João Pedro da Silva", cargo: "1º (CN) - Analista Judiciário (TJ RJ - 2026)", texto: "O Tec Concursos foi uma ferramenta que levou meus estudos para outro nível. É uma plataforma completa.", cor: "#f59e0b" },
  { nome: "Jeferson dos Santos Ferreira", cargo: "19º (CN) - Assistente (UFRJ - 2026)", texto: "O TEC foi fundamental para minha aprovação, recomendo-o demais.", cor: "#ef4444" },
  { nome: "Gabriel Mendonça Santana", cargo: "1º (AC) - Auditor Fiscal (SEFAZ GO - 2026)", texto: "O Tec teve um papel fundamental na minha preparação. Foi a plataforma que utilizei durante toda a minha trajetória.", cor: "#06b6d4" },
];

function LogoFallback({ initials, bgColor, style }: { initials: string; bgColor: string; style?: React.CSSProperties }) {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" style={{ background: bgColor, ...style }}>
      <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle" fill="white" fontFamily="Manrope, sans-serif" fontWeight="700" fontSize="14">{initials}</text>
    </svg>
  );
}

function ConcursoLogo({ logo, alt, initials, logoBg }: { logo: string; alt: string; initials: string; logoBg: string }) {
  const [showFallback, setShowFallback] = useState(false);
  return (
    <div className="tecconkursos-logotipo">
      {!showFallback && <img src={logo} alt={alt} onError={() => setShowFallback(true)} />}
      {showFallback && <LogoFallback initials={initials} bgColor={logoBg} style={{ width: '60px', height: '60px' }} />}
    </div>
  );
}

function GuiaLogo({ logo, name }: { logo: string; name: string }) {
  return (
    <span className="tecconkursos-card-header-logo">
      <img src={logo} alt={name} loading="lazy" />
    </span>
  );
}

function ExamCard({ item, onOpen, onRemove }: { item: Exam; onOpen: (id: number) => void; onRemove: (id: number) => void }) {
  const answered = Number(item.answered_count ?? 0);
  const correct = Number(item.correct_count ?? 0);
  const wrong = Number(item.wrong_count ?? 0);
  const total = Number(item.question_count ?? 0);
  const progress = total ? Math.min(100, Math.round((answered / total) * 100)) : 0;
  const [expanded, setExpanded] = useState(false);

  function handleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('.exam-card-actions')) return;
    setExpanded(!expanded);
  }

  return (
    <article className={`exam-card ${expanded ? 'exam-card-expanded' : ''}`} onClick={handleClick}>
      <div className="exam-card-visual">
        {item.logo ? (
          <img src={item.logo} alt={item.title} className="exam-card-logo" />
        ) : (
          <div className="exam-card-icon teal"><FileText size={24} strokeWidth={1.5} /></div>
        )}
      </div>

      <div className="exam-card-content">
        <div className="exam-card-content-inner">
          <div className="exam-card-header">
            <div className="exam-card-header-text">
              <h3>{item.title}</h3>
              {item.board && <span className="exam-card-board">{item.board}</span>}
            </div>
            <div className={`exam-card-chevron ${expanded ? 'expanded' : ''}`}>
              <ChevronRight size={16} />
            </div>
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
              <div className="exam-card-stat-icon teal"><ClipboardCheck size={16} strokeWidth={2} /></div>
              <div className="exam-card-stat-info">
                <strong>{answered}</strong>
                <span>Resolvidas</span>
              </div>
            </div>
            <div className="exam-card-stat">
              <div className="exam-card-stat-icon green"><Check size={16} strokeWidth={2} /></div>
              <div className="exam-card-stat-info">
                <strong>{correct}</strong>
                <span>Acertos</span>
              </div>
            </div>
            <div className="exam-card-stat">
              <div className="exam-card-stat-icon red"><X size={16} strokeWidth={2} /></div>
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
          <button className="exam-card-edit" aria-label="Editar" onClick={(e) => { e.stopPropagation(); }}>
            <Pencil size={14} />
          </button>
          <button className="exam-card-remove" aria-label="Remover" onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}>
            <Trash2 size={14} />
          </button>
        </div>
      </footer>
    </article>
  );
}

function FeaturesSection() {
  return (
    <section className="tecconkursos-features">
      <div className="tecconkursos-container">
        <div className="tecconkursos-features-grid">
          <div className="tecconkursos-feature-card">
            <div className="tecconkursos-feature-icon" style={{ background: "#ecfdf5", color: "#059669" }}>
              <FileText size={24} />
            </div>
            <h3>O melhor em <strong>questões</strong></h3>
            <p><strong>1.763.227</strong> questões comentadas por PROFESSORES. <strong>4.041.113</strong> questões cadastradas.</p>
          </div>
          <div className="tecconkursos-feature-card">
            <div className="tecconkursos-feature-icon" style={{ background: "#eff6ff", color: "#2563eb" }}>
              <BookOpen size={24} />
            </div>
            <h3>O melhor em <strong>teoria</strong></h3>
            <p>Aulas teóricas sempre atualizadas, feitas por professores especializados, totalmente customizável.</p>
          </div>
          <div className="tecconkursos-feature-card">
            <div className="tecconkursos-feature-icon" style={{ background: "#fef3c7", color: "#d97706" }}>
              <BarChart3 size={24} />
            </div>
            <h3>O melhor em <strong>apoio</strong></h3>
            <p>Monitore seu desempenho e sua evolução, saiba o que é mais cobrado e controle seus estudos.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DepoimentosSection() {
  const [visible, setVisible] = useState(3);
  const [autoIdx, setAutoIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setAutoIdx((prev) => (prev + 1) % depoimentos.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="tecconkursos-depoimentos">
      <div className="tecconkursos-container">
        <div className="tecconkursos-caixa-titulo">
          <h2 className="tecconkursos-titulo">Milhares de alunos aprovados todos os anos</h2>
        </div>
        <div className="tecconkursos-depoimentos-grid">
          {depoimentos.slice(0, visible).map((d, i) => (
            <div className={`tecconkursos-depoimento-card ${i === 0 ? "tecconkursos-depoimento-destaque" : ""}`} key={i}>
              <div className="tecconkursos-depoimento-quote" style={{ color: d.cor }}>
                <Quote size={28} />
              </div>
              <p>{d.texto}</p>
              <div className="tecconkursos-depoimento-author">
                <div className="tecconkursos-depoimento-avatar" style={{ background: d.cor }}>
                  {d.nome.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                </div>
                <div>
                  <strong>{d.nome}</strong>
                  <span>{d.cargo}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        {visible < depoimentos.length && (
          <div className="tecconkursos-depoimentos-more">
            <button className="tecconkursos-cta-secondary" onClick={() => setVisible(depoimentos.length)}>
              Ver todos os depoimentos <ArrowRight size={14} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function PartnersSection() {
  return (
    <section className="tecconkursos-partners">
      <div className="tecconkursos-container">
        <div className="tecconkursos-caixa-titulo">
          <h2 className="tecconkursos-titulo">Usado por quem entende de aprovação</h2>
        </div>
        <div className="tecconkursos-partners-grid">
          <div className="tecconkursos-partner-card">
            <div className="tecconkursos-partner-icon" style={{ background: "#ecfdf5", color: "#059669" }}>
              <CheckCircle size={24} />
            </div>
            <p>"O Tec é superior em tudo. Recomendamos sempre!"</p>
            <strong>Leandro Souza</strong>
            <span>LS Concursos</span>
          </div>
          <div className="tecconkursos-partner-card">
            <div className="tecconkursos-partner-icon" style={{ background: "#eff6ff", color: "#2563eb" }}>
              <Star size={24} />
            </div>
            <p>"Comentários por professores e sempre atualizados"</p>
            <strong>Prof. Ana Silva</strong>
            <span>Estratégia Educacional</span>
          </div>
          <div className="tecconkursos-partner-card">
            <div className="tecconkursos-partner-icon" style={{ background: "#fef3c7", color: "#d97706" }}>
              <Users size={24} />
            </div>
            <p>"A melhor plataforma de questões do Brasil!"</p>
            <strong>Carlos Mendes</strong>
            <span>Direção Concursos</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export function TecconkursosPanel({ onOpenExam }: { onOpenExam: (id: number, view: "solve" | "review") => void }) {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [examSearch, setExamSearch] = useState("");

  async function refresh() {
    try {
      const response = await fetch(`${API}/exams`);
      const data = await response.json();
      setExams(data);
    } catch {
      setExams([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function openExam(id: number) {
    onOpenExam(id, "solve");
  }

  async function removeExam(id: number) {
    if (!window.confirm("Remover esta prova e todo o histórico dela?")) return;
    const response = await fetch(`${API}/exams/${id}`, { method: "DELETE" });
    if (!response.ok) return alert("Não foi possível remover a prova.");
    await refresh();
  }

  const recentExams = exams.slice().sort((a, b) => b.id - a.id);
  const filteredExams = recentExams.filter((e) =>
    e.title.toLocaleLowerCase("pt-BR").includes(examSearch.toLocaleLowerCase("pt-BR")) ||
    (e.board && e.board.toLocaleLowerCase("pt-BR").includes(examSearch.toLocaleLowerCase("pt-BR")))
  );

  return (
    <div className="tecconkursos-panel">
      <section className="tecconkursos-banner">
        <div className="tecconkursos-banner-bg" />
        <div className="tecconkursos-container">
          <div className="tecconkursos-banner-content">
            <h1>Seja aprovado e <em>mude de vida</em></h1>
            <h2>Prepare-se com a ferramenta preferida dos aprovados nos concursos e exames mais concorridos do País.</h2>
            <a href="#cadastro" className="tecconkursos-cta">CRIE SUA CONTA E ESTUDE DE GRAÇA <ChevronRight size={16} /></a>
          </div>
        </div>
      </section>



      <section className="tecconkursos-concursos">
        <div className="tecconkursos-container">
          <h2 className="tecconkursos-subtitulo">A sua chave para os concursos e exames mais disputados do país</h2>
          <div className="tecconkursos-linha">
            {concursos.map((c) => (
              <div className="tecconkursos-coluna" key={c.name}>
                <ConcursoLogo logo={c.logo} alt={c.logoAlt} initials={c.initials} logoBg={c.logoBg} />
                <div className="tecconkursos-descricao">
                  <span>{c.name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="tecconkursos-guias">
        <div className="tecconkursos-container">
          <div className="tecconkursos-caixa-titulo">
            <h2 className="tecconkursos-titulo">Suas Provas</h2>
            <h3 className="tecconkursos-subtitulo" style={{ fontWeight: 400, color: "#64748b", fontSize: 15 }}>
              Provas importadas e prontas para resolução
            </h3>
          </div>
          <div className="tecconkursos-search">
            <Search size={16} />
            <input
              type="text"
              placeholder="Pesquisar provas por nome ou banca..."
              value={examSearch}
              onChange={(e) => setExamSearch(e.target.value)}
            />
          </div>
          <div className="tecconkursos-cards">
            {filteredExams.length > 0 ? filteredExams.map((exam) => (
              <ExamCard key={exam.id} item={exam} onOpen={openExam} onRemove={removeExam} />
            )) : (
              <div className="tecconkursos-search-empty">
                <Search size={24} />
                <p>{examSearch ? `Nenhuma prova encontrada para "${examSearch}"` : "Nenhuma prova importada ainda"}</p>
              </div>
            )}
          </div>
        </div>
      </section>







      <section className="tecconkursos-stats">
        <div className="tecconkursos-container">
          <div className="tecconkursos-stats-grid">
            <div className="tecconkursos-stat">
              <div className="tecconkursos-stat-icon"><Github size={20} /></div>
              <div>
                <strong>Open Source</strong>
                <span>Ferramenta open source e transparente</span>
              </div>
            </div>
            <div className="tecconkursos-stat">
              <div className="tecconkursos-stat-icon"><Target size={20} /></div>
              <div>
                <strong>Foco Total</strong>
                <span>Estudo direcionado e eficiente</span>
              </div>
            </div>
            <div className="tecconkursos-stat">
              <div className="tecconkursos-stat-icon"><Clock3 size={20} /></div>
              <div>
                <strong>24/7</strong>
                <span>Acesso ao material de estudo</span>
              </div>
            </div>
            <div className="tecconkursos-stat">
              <div className="tecconkursos-stat-icon"><Award size={20} /></div>
              <div>
                <strong>Aprovados</strong>
                <span>Ferramenta preferida dos aprovados</span>
              </div>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
