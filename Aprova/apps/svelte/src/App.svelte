<script lang="ts">
  // Shell + dashboard — porte do store "app" (init/setView/openExam),
  // dashboardComponent e topbar — app.js:51-296 + index.html:28-188.
  import { onMount } from 'svelte';
  import ExamCard from './lib/ExamCard.svelte';
  import ExamFilters from './lib/ExamFilters.svelte';
  import Heatmap from './lib/Heatmap.svelte';
  import PerformanceView from './lib/PerformanceView.svelte';
  import ImportView from './lib/ImportView.svelte';
  import ReviewView from './lib/ReviewView.svelte';
  import SolveView from './lib/SolveView.svelte';
  import { app, type View } from './lib/store.svelte';
  import type { Exam } from './lib/types';
  import { assetURL, formatStudyTime, updateExamMeta } from './lib/bridge';

  let navOpen = $state(false);

  // ---- dashboard (filtros/paginação/edição) ----
  let q = $state('');
  let fBoard = $state('');
  let fStatus = $state('');
  let fYear = $state('');
  let fSort = $state('recent');
  let page = $state(1);
  const perPage = 12;

  type Editing = { id: number; title: string; board: string; preview: string; file: File | null };
  let editing = $state<Editing | null>(null);
  let editSaving = $state(false);

  function statusOf(item: Exam): string {
    const answered = Number(item.answered_count ?? 0);
    const total = Number(item.question_count ?? 0);
    if (total > 0 && answered >= total) return 'done';
    if (answered > 0) return 'doing';
    return 'todo';
  }

  let exams = $derived(app.exams);
  let answered = $derived(exams.reduce((s, i) => s + Number(i.answered_count ?? 0), 0));
  let correct = $derived(exams.reduce((s, i) => s + Number(i.correct_count ?? 0), 0));
  let studySeconds = $derived(exams.reduce((s, i) => s + Number(i.study_seconds ?? 0), 0));
  let accuracy = $derived(answered ? Math.round((correct / answered) * 100) : 0);
  let tone = $derived(accuracy >= 70 ? 'green' : accuracy >= 50 ? 'amber' : 'red');
  let studyTime = $derived(formatStudyTime(studySeconds));
  let boards = $derived([...new Set(exams.map((e) => e.board).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  let years = $derived(
    [...new Set(exams.map((e) => (e.created_at ? String(new Date(e.created_at).getFullYear()) : '')).filter(Boolean))]
      .sort()
      .reverse(),
  );
  let filtered = $derived(
    [...exams
      .filter((item) => {
        if (q.trim() && !String(item.title ?? '').toLowerCase().includes(q.trim().toLowerCase())) return false;
        if (fBoard && (item.board ?? '') !== fBoard) return false;
        if (fStatus && statusOf(item) !== fStatus) return false;
        if (fYear && (item.created_at ? String(new Date(item.created_at).getFullYear()) : '') !== fYear) return false;
        return true;
      })
      .sort((a, b) => {
        if (fSort === 'name') return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'pt-BR');
        if (fSort === 'progress') {
          const pa = Number(a.question_count ?? 0) ? Number(a.answered_count ?? 0) / Number(a.question_count ?? 0) : 0;
          const pb = Number(b.question_count ?? 0) ? Number(b.answered_count ?? 0) / Number(b.question_count ?? 0) : 0;
          return pb - pa;
        }
        return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
      })],
  );
  let resume = $derived(
    exams.find((e) => {
      const t = Number(e.question_count ?? 0);
      const a = Number(e.answered_count ?? 0);
      return t > 0 && a > 0 && a < t;
    }) ?? null,
  );
  let totalPages = $derived(Math.max(1, Math.ceil(filtered.length / perPage)));
  let paged = $derived(filtered.slice((page - 1) * perPage, page * perPage));
  let pages = $derived.by(() => {
    const total = totalPages;
    const cur = page;
    const out: { num?: number; dots?: boolean; key: string }[] = [];
    const push = (num: number) => out.push({ num, key: `p${num}` });
    if (total <= 7) {
      for (let i = 1; i <= total; i++) push(i);
      return out;
    }
    push(1);
    if (cur > 3) out.push({ dots: true, key: 'd1' });
    for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) push(i);
    if (cur < total - 2) out.push({ dots: true, key: 'd2' });
    push(total);
    return out;
  });

  // $watch dos filtros → volta à página 1; clamp quando a lista encolhe.
  $effect(() => {
    void [q, fBoard, fStatus, fYear, fSort].join('|');
    page = 1;
  });
  $effect(() => {
    void filtered.length;
    if (page > totalPages) page = totalPages;
  });

  function setPage(n: number): void {
    page = Math.min(totalPages, Math.max(1, n));
    const head = document.querySelector('.gran-list-head');
    if (head) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: head.getBoundingClientRect().top + window.scrollY - 96, behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  function clearFilters(): void {
    q = '';
    fBoard = '';
    fStatus = '';
    fYear = '';
    fSort = 'recent';
  }

  function startEdit(item: Exam): void {
    editing = {
      id: item.id,
      title: item.title ?? '',
      board: item.board ?? '',
      preview: item.logo ? assetURL(item.logo) : '',
      file: null,
    };
    editSaving = false;
  }

  function cancelEdit(): void {
    editing = null;
  }

  function onLogoFile(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f || !editing) return;
    editing.file = f;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (editing) editing.preview = String(ev.target?.result ?? '');
    };
    reader.readAsDataURL(f);
  }

  async function saveEdit(): Promise<void> {
    if (!editing || !editing.title.trim() || editSaving) return;
    editSaving = true;
    try {
      const ok = await updateExamMeta(editing.id, editing.title, editing.board, editing.file);
      if (!ok) throw new Error('Erro ao salvar');
      editing = null;
      await app.refresh();
    } catch {
      alert('Erro ao salvar alterações');
    } finally {
      editSaving = false;
    }
  }

  function go(view: View): void {
    navOpen = false;
    app.setView(view);
  }

  onMount(() => app.initRouter());
</script>

<svelte:head><title>{app.titleOf(app.view)} — Mira</title></svelte:head>

<svelte:window onkeydown={(e) => {
  // Os dois atalhos de Escape (modal + drawer) disparam juntos.
  if (e.key !== 'Escape') return;
  if (editing) cancelEdit();
  navOpen = false;
}} />

<div id="root" class="notranslate app-shell view-{app.view}" translate="no">
  <div class="topbar" class:nav-open={navOpen}>
    <div class="topbar-inner">
      <button class="nav-toggle" type="button" aria-label="Abrir menu de navegação" aria-expanded={navOpen} class:open={navOpen} onclick={() => (navOpen = !navOpen)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {#if navOpen}
            <path fill-rule="evenodd" clip-rule="evenodd" d="M18.278 16.864a1 1 0 0 1-1.414 1.414l-4.829-4.828-4.828 4.828a1 1 0 0 1-1.414-1.414l4.828-4.829-4.828-4.828a1 1 0 0 1 1.414-1.414l4.829 4.828 4.828-4.828a1 1 0 1 1 1.414 1.414l-4.828 4.829 4.828 4.828z" />
          {:else}
            <path fill-rule="evenodd" d="M4 5h16a1 1 0 0 1 0 2H4a1 1 0 1 1 0-2zm0 6h16a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2zm0 6h16a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2z" />
          {/if}
        </svg>
      </button>
      <div class="brand"><div class="brand-lockup"><span class="brand-name">Mira</span><small>estudos</small></div></div>
      <div class="nav-menu" class:open={navOpen}>
        <nav>
          <button class={app.view === 'exams' ? 'nav active' : 'nav'} onclick={() => go('exams')}><span>Provas</span></button>
          <button class={app.view === 'performance' ? 'nav active' : 'nav'} onclick={() => go('performance')}><span>Desempenho</span></button>
          <button class={app.view === 'import' ? 'nav active' : 'nav'} onclick={() => go('import')}><span>Importar</span></button>
        </nav>
        <div class="profile"><div class="avatar">LA</div><div><strong>Lucas</strong></div></div>
      </div>
    </div>
  </div>

  <main>
    <header><div><span class="eyebrow">PLATAFORMA DE ESTUDOS</span><h1>{app.titleOf(app.view)}</h1></div></header>
    {#if app.error}
      <div class="alert"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>{app.error}</span></div>
    {/if}

    {#if app.view === 'dashboard' || app.view === 'exams'}
      <section class="gran-provas">
        <div class="gran-hero">
          <div class="gran-hero-inner">
            <nav class="gran-crumbs" aria-label="Navegação estrutural"><button onclick={() => go('exams')}>Início</button><span aria-hidden="true">/</span><strong>Provas</strong></nav>
            <div class="gran-hero-row">
              <h2>Provas de Concursos</h2>
              <div class="gran-hero-action">
                <p>A ferramenta definitiva e sem custo nenhum para você subir provas com gabarito e ver sua evolução.</p>
                <button class="gran-hero-cta" onclick={() => go('import')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/></svg>
                  Enviar prova e gabarito
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="stats">
          <div class="stat stat-blue"><div class="stat-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><div><strong>{exams.length}</strong><span>Provas importadas</span></div></div>
          <div class="stat stat-green"><div class="stat-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></div><div><strong>{answered}</strong><span>Questões resolvidas</span></div></div>
          <div class="stat stat-neutral"><div class="stat-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div><strong>{studyTime}</strong><span>Tempo de estudo</span></div></div>
          <div class="stat stat-{tone}"><div class="stat-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg></div><div><strong>{answered ? `${accuracy}%` : '—'}</strong><span>Taxa de acerto</span></div></div>
        </div>
        <div class="gran-cols">
          <aside class="gran-side">
            <ExamFilters bind:query={q} bind:board={fBoard} bind:status={fStatus} bind:year={fYear} bind:sort={fSort} {boards} {years} reset={clearFilters} />
            <section class="side-card quick-performance glance-performance">
              <div class="side-title"><div><span class="eyebrow">DESEMPENHO</span><h3>Resumo atual</h3></div></div>
              <strong>{answered ? `${accuracy}%` : '—'}</strong><span>Aproveitamento geral</span>
              <div class="quick-track"><i style:width="{accuracy}%"></i></div>
              <small>{correct} acertos em {answered} resoluções</small>
            </section>
          </aside>
          <div class="gran-main">
            <div class="gran-list-head">
              <div><span class="eyebrow">BIBLIOTECA</span><h3>Suas provas</h3></div>
              <div class="gran-list-side">
                <span class="gran-count">{filtered.length === 1 ? '1 prova encontrada' : `${filtered.length} provas encontradas`}</span>
                {#if resume}
                  <button class="gran-continue" onclick={() => void app.openExam(resume.id, 'solve')}>Continuar <b>{resume.title}</b> · <span>{resume.answered_count}/{resume.question_count}</span> ›</button>
                {/if}
              </div>
            </div>
            <div class="exam-list gran-list dashboard-exams">
              {#each paged as exam (exam.id)}
                <ExamCard
                  {exam}
                  onOpen={() => void app.openExam(exam.id, 'solve')}
                  onEdit={() => startEdit(exam)}
                  onRemove={() => void app.removeExam(exam.id)}
                />
              {/each}
            </div>
            {#if editing}
              <div class="exam-edit-overlay" onclick={(e) => { if (e.target === e.currentTarget) cancelEdit(); }}>
                <div class="exam-edit-modal">
                  <div class="exam-edit-header">
                    <h3>Editar prova</h3>
                    <button class="exam-edit-close" aria-label="Fechar" onclick={cancelEdit}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                  </div>
                  <div class="exam-edit-body">
                    <div class="exam-edit-field"><label>Título</label><input type="text" bind:value={editing.title} /></div>
                    <div class="exam-edit-field"><label>Banca</label><input type="text" bind:value={editing.board} placeholder="Ex: FCC, CESPE, VUNESP..." /></div>
                    <div class="exam-edit-field">
                      <label>Logo da prova</label>
                      <div class="exam-edit-logo-area">
                        {#if editing.preview}
                          <img src={editing.preview} alt="Logo" class="exam-edit-logo-preview" loading="lazy" decoding="async" />
                        {/if}
                        <label class="exam-edit-upload"><input type="file" accept="image/*" hidden onchange={onLogoFile} /><span>{editing.preview ? 'Trocar imagem' : 'Selecionar imagem'}</span></label>
                      </div>
                    </div>
                  </div>
                  <div class="exam-edit-footer">
                    <button class="exam-edit-cancel" onclick={cancelEdit}>Cancelar</button>
                    <button class="exam-edit-save" onclick={saveEdit} disabled={!editing.title.trim() || editSaving}>{editSaving ? 'Salvando...' : 'Salvar'}</button>
                  </div>
                </div>
              </div>
            {/if}
            {#if filtered.length > 0}
              <nav class="gran-pagination" aria-label="Paginação das provas">
                <button class="gran-page-nav" onclick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Página anterior">
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
                  <span>Anterior</span>
                </button>
                {#each pages as p (p.key)}
                  {#if p.dots}
                    <button class="gran-page" disabled aria-label="Mais páginas">…</button>
                  {:else}
                    <button
                      class="gran-page"
                      class:on={p.num === page}
                      onclick={() => p.num !== undefined && setPage(p.num)}
                      aria-label="Página {p.num}"
                      aria-current={p.num === page ? 'page' : undefined}
                    >{p.num}</button>
                  {/if}
                {/each}
                <button class="gran-page-nav" onclick={() => setPage(page + 1)} disabled={page >= totalPages} aria-label="Próxima página">
                  <span>Próxima</span>
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
                </button>
              </nav>
            {/if}
            {#if !exams.length}
              <div class="empty provas-empty">
                <div class="empty-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
                <h3>Nenhuma prova ainda</h3>
                <p>Importe uma prova com gabarito para criar seu primeiro caderno e começar a acompanhar desempenho.</p>
                <button class="primary" onclick={() => go('import')}>Importar primeira prova</button>
              </div>
            {/if}
            {#if exams.length && !filtered.length}
              <div class="empty">
                <div class="empty-icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
                <h3>Nenhuma prova encontrada</h3>
                <p>Nenhuma prova corresponde aos filtros aplicados.</p>
                <button class="secondary" onclick={clearFilters}>Limpar filtros</button>
              </div>
            {/if}
            <div class="gran-ritmo"><Heatmap /></div>
            <footer class="gran-footer">
              <div class="gran-footer-grid">
                <div><strong class="gran-footer-brand">Mira <span>estudos</span></strong><p>Suas provas, questões e desempenho em um só lugar. Dados salvos localmente.</p></div>
                <nav aria-label="Estudar"><strong>Estudar</strong><button onclick={() => go('exams')}>Provas</button><button onclick={() => go('performance')}>Desempenho</button><button onclick={() => go('import')}>Importar</button></nav>
                <div><strong>Sobre</strong><p>Plataforma de estudos com cadernos de questões interativos.</p></div>
              </div>
              <small>© Mira Estudos — uso local</small>
            </footer>
          </div>
        </div>
      </section>
    {:else if app.view === 'performance'}
      <PerformanceView />
    {:else if app.view === 'import'}
      <ImportView />
    {:else if app.view === 'review'}
      {#if app.exam?.questions}
        <ReviewView />
      {/if}
    {:else if app.view === 'solve'}
      {#if app.exam}
        {#key app.exam.id}
          <SolveView exam={app.exam} onFinish={() => go('performance')} onBack={() => go('exams')} />
        {/key}
      {:else}
        <div class="panel" style="padding: 40px; text-align: center; color: #6C7480">Carregando prova...</div>
      {/if}
    {/if}
  </main>
</div>
