<script lang="ts">
  // Card da prova — app.js:237-244 (statsOf/shortTitle) + index.html:99-132.
  import type { Exam } from './types';
  import { assetURL } from './bridge';

  let {
    exam,
    onOpen = () => {},
    onEdit = () => {},
    onRemove = () => {},
  } = $props<{
    exam: Exam;
    onOpen?: () => void;
    onEdit?: () => void;
    onRemove?: () => void;
  }>();

  // Título curto ("Órgão/Banca") — regra exata do app.js:225-236.
  function shortTitle(t: string | null | undefined): string {
    const full = String(t ?? '').trim().replace(/\s+/g, ' ');
    if (!full) return '';
    let s = full.split(' - ')[0].trim() || full;
    const MAX = 42;
    if (s.length > MAX) {
      const cut = s.slice(0, MAX);
      const i = cut.lastIndexOf(' ');
      s = (i > 20 ? cut.slice(0, i) : cut).trimEnd() + '…';
    }
    return s;
  }

  function pad2(n: number): string {
    return n === 0 ? '0' : String(n).padStart(2, '0');
  }

  function fmtDate(s: string): string {
    return s ? new Date(s).toLocaleDateString('pt-BR') : '';
  }

  let a = $derived(Number(exam.answered_count ?? 0));
  let c = $derived(Number(exam.correct_count ?? 0));
  let w = $derived(Number(exam.wrong_count ?? 0));
  let t = $derived(Number(exam.question_count ?? 0));
  let p = $derived(t ? Math.min(100, Math.round((a / t) * 100)) : 0);
  let done = $derived(t > 0 && a >= t);

  function onCardKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') onOpen();
  }
</script>

<article
  class="exam-card-v2"
  class:is-completed={done}
  onclick={onOpen}
  onkeydown={onCardKey}
  tabindex="0"
>
  <div class="exam-card-visual">
    {#if exam.logo}
      <img class="exam-card-logo" src={assetURL(exam.logo)} alt="" loading="lazy" decoding="async" />
    {:else}
      <div class="exam-card-icon ecv2-teal"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
    {/if}
    <div class="exam-card-visual-title"><h3 title={exam.title}>{shortTitle(exam.title)}</h3></div>
  </div>
  <div class="exam-card-content">
    <div class="exam-card-content-inner">
      <div class="exam-card-info-box">
        {#if exam.created_at}
          <span><b>Prova:</b> <strong class="card-number">{fmtDate(exam.created_at)}</strong></span>
        {/if}
        {#if exam.board}
          <span><b>Banca:</b> <span>{exam.board}</span></span>
        {/if}
      </div>
      <div class="exam-card-progress-area">
        <div class="exam-card-progress-top">
          <span class="exam-card-progress-text"><strong>{pad2(a)}</strong> de <span class="progress-total">{pad2(t)}</span> <small>resolvidas</small></span>
          <span class="exam-card-status">{done ? 'Concluído' : 'Em andamento'}</span>
        </div>
        <div class="exam-card-progress-bar"><i style:width="{p}%"></i></div>
      </div>
      <div class="exam-card-stats">
        <div class="exam-card-stat"><div class="exam-card-stat-icon ecv2-teal"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12l2 2 4-4"/></svg></div><div class="exam-card-stat-info"><strong>{a}</strong><span>Resolvidas</span></div></div>
        <div class="exam-card-stat"><div class="exam-card-stat-icon ecv2-green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div><div class="exam-card-stat-info"><strong>{c}</strong><span>Acertos</span></div></div>
        <div class="exam-card-stat"><div class="exam-card-stat-icon ecv2-red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div><div class="exam-card-stat-info"><strong>{w}</strong><span>Erros</span></div></div>
      </div>
    </div>
  </div>
  <footer class="exam-card-footer">
    <div class="exam-card-actions">
      <button class="exam-card-edit" aria-label="Editar" onclick={(e) => { e.stopPropagation(); onEdit(); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>
      <button class="exam-card-remove" aria-label="Remover" onclick={(e) => { e.stopPropagation(); onRemove(); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    </div>
    <button class="exam-card-cta" onclick={(e) => { e.stopPropagation(); onOpen(); }}>Resolver</button>
  </footer>
</article>
