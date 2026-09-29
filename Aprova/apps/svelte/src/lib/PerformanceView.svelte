<script lang="ts">
  // Donuts/semana/ranking em markup declarativo.
  import { onMount } from 'svelte';
  import { fetchPerformance, formatTimer } from './bridge';
  import { app } from './store.svelte';
  import type { PerfDay } from './solve-types';

  let days = $state<PerfDay[]>([]);
  let scoreMode = $state<'normal' | 'liquid'>('normal');

  let exams = $derived(app.exams);
  let total = $derived(exams.reduce((s, i) => s + Number(i.question_count ?? 0), 0));
  let answered = $derived(exams.reduce((s, i) => s + Number(i.answered_count ?? 0), 0));
  let correct = $derived(exams.reduce((s, i) => s + Number(i.correct_count ?? 0), 0));
  let wrong = $derived(exams.reduce((s, i) => s + Number(i.wrong_count ?? 0), 0));
  let blank = $derived(Math.max(0, total - answered));
  let seconds = $derived(exams.reduce((s, i) => s + Number(i.study_seconds ?? 0), 0));
  let accuracy = $derived(answered ? Math.round((correct / answered) * 100) : 0);
  let liquid = $derived(answered ? Math.max(0, Math.round(((correct - wrong) / answered) * 100)) : 0);
  let displayed = $derived(scoreMode === 'normal' ? accuracy : liquid);
  let completion = $derived(total ? Math.round((answered / total) * 100) : 0);
  let avgSeconds = $derived(answered ? Math.round(seconds / answered) : 0);
  let maxDay = $derived(Math.max(1, ...days.map((d) => d.answered ?? 0)));
  let weekTotal = $derived(days.reduce((s, d) => s + (d.answered ?? 0), 0));
  let mastery = $derived(Math.round((accuracy + completion) / 2));

  onMount(() => {
    fetchPerformance()
      .then((list) => {
        days = list;
      })
      .catch(() => {
        days = [];
      });
  });
</script>

<section class="performance-page">
  <div class="performance-controls">
    <div><b>Exibir</b><span class="control-active">Todas as questões</span></div>
    <div>
      <b>Pontuação</b>
      <button class:active={scoreMode === 'normal'} onclick={() => (scoreMode = 'normal')}>Normal</button>
      <button class:active={scoreMode === 'liquid'} onclick={() => (scoreMode = 'liquid')}>Líquida</button>
    </div>
  </div>
  <div class="notebook-analytics">
    <aside class="notebook-totals">
      <h2>Resumo dos cadernos</h2>
      <dl>
        <div><dt>Questões</dt><dd>{total}</dd></div>
        <div><dt>Resolvidas</dt><dd>{answered}</dd></div>
        <div class="correct-row"><dt>Acertos</dt><dd>{correct}</dd></div>
        <div class="wrong-row"><dt>Erros</dt><dd>{wrong}</dd></div>
        <div><dt>Em branco</dt><dd>{blank}</dd></div>
      </dl>
      <div class="time-totals">
        <span>Tempo total <b>{formatTimer(seconds)}</b></span>
        <span>Tempo médio por questão <b>{formatTimer(avgSeconds)}</b></span>
      </div>
      <div class="completion-block">
        <div><span>Progresso de estudo</span><b>{completion}%</b></div>
        <div class="completion-bar"><i style:width="{completion}%"></i></div>
      </div>
    </aside>
    <div class="donut-area">
      <div class="donut-card">
        <h3>Seu desempenho</h3>
        <div class="performance-donut" style:--donut="{accuracy * 3.6}deg">
          <div><strong>{displayed}%</strong><span>Pontuação</span></div>
        </div>
        <div class="donut-legend"><span><i class="green"></i>Acertos {accuracy}%</span><span><i class="red"></i>Erros {answered ? 100 - accuracy : 0}%</span></div>
      </div>
      <div class="donut-card">
        <h3>Meta de aprovação</h3>
        <div class="performance-donut" style:--donut="{75 * 3.6}deg">
          <div><strong>75%</strong><span>Referência</span></div>
        </div>
        <div class="donut-legend"><span><i class="green"></i>Acertos 75%</span><span><i class="red"></i>Erros 25%</span></div>
      </div>
      <div class="mastery">
        <strong>Índice de domínio</strong>
        <div><i style:left="{Math.min(100, mastery)}%"></i></div>
        <span>{mastery}%</span>
      </div>
    </div>
  </div>
  <div class="performance-grid">
    <article class="performance-panel">
      <div class="panel-heading">
        <div><span class="eyebrow">ÚLTIMOS 7 DIAS</span><h2>Evolução</h2></div>
        <span>{weekTotal} resoluções</span>
      </div>
      <div class="weekly-chart">
        {#each days as day (day.day)}
          {@const n = day.answered ?? 0}
          <div class="day-column">
            <div class="bar-track"><i style:height="{Math.max(n ? 8 : 2, (n / maxDay) * 100)}%"></i></div>
            <strong>{n}</strong><span>{day.day}</span>
          </div>
        {/each}
      </div>
    </article>
    <article class="performance-panel comparison">
      <div class="panel-heading">
        <div><span class="eyebrow">POR PROVA</span><h2>Seus cadernos</h2></div>
      </div>
      <div class="exam-ranking">
        {#each exams as item (item.id)}
          {@const done = Number(item.answered_count ?? 0)}
          {@const hits = Number(item.correct_count ?? 0)}
          {@const rate = done ? Math.round((hits / done) * 100) : 0}
          <button onclick={() => void app.openExam(item.id, 'solve')}>
            <div><strong>{item.title}</strong><span>{done} resolvidas • {hits} acertos</span></div>
            <div class="rank-rate"><b>{done ? `${rate}%` : '—'}</b><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
          </button>
        {/each}
      </div>
    </article>
  </div>
</section>
