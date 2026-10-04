<script lang="ts">
  // Índice/opções em {#each} compilado (escape automático, zero overhead);
  // a troca de questão usa $effect com guarda de primeira execução.
  import { onDestroy, onMount, tick } from 'svelte';
  import PageReference from './PageReference.svelte';
  import type { Feedback, FocusEntry, Question, SolveExam } from './solve-types';
  import {
    fetchFocusMap,
    formatTimer,
    hostExamP2P,
    postAnswer,
    shutdownP2PSafe,
  } from './bridge';

  type Props = {
    exam: SolveExam;
    onFinish: () => void;
    onBack: () => void;
  };
  let { exam, onFinish, onBack }: Props = $props();

  let currentIdx = $state(0);
  let answers = $state<Record<number, string>>({});
  let eliminated = $state<Record<number, string[]>>({});
  let nightMode = $state(false);
  // Feedback por questão: ao responder, a escolha trava e o feedback
  // persiste — ao retornar na questão, ele reaparece em vez de liberar
  // nova marcação.
  let feedbacks = $state<Record<number, Feedback>>({});
  let results = $state<Record<number, 'correct' | 'wrong'>>({});
  let feedback = $state<Feedback | null>(null);
  let submitting = $state(false);
  let focusMap = $state<Record<string, FocusEntry> | null>(null);

  let indexGridEl = $state<HTMLElement | null>(null);
  let akCursorEl = $state<HTMLElement | null>(null);
  let pageRefComp = $state<PageReference | null>(null);
  let clockText = $state('00:00:00');
  let paused = $state(false);

  // Sem reatividade: flags de ciclo de vida e guardas de efeito.
  let alive = true;
  let firstIdxRun = true;
  let clockId: number | undefined = undefined;
  let clockStart = 0;
  let pauseBegin = 0;

  // Derivados — mesma ordem e semântica dos getters originais.
  let questions = $derived(
    (exam?.questions ?? []).filter((q, i, arr) => arr.findIndex((x) => x.number === q.number) === i),
  );
  let question = $derived<Question | undefined>(questions[currentIdx]);
  let total = $derived(questions.length);
  // Rótulos vindos das alternativas reais (A-D, A-E…): sem limite fixo,
  // o gabarito cresce para a direita conforme a prova.
  let altLabels = $derived([...new Set(questions.flatMap((q) => q.alternatives.map((a) => a.label)))]);
  let selected = $derived(question ? (answers[question.id] ?? null) : null);
  let allAnswered = $derived(questions.every((q) => answers[q.id]));
  let answeredCount = $derived(questions.filter((q) => answers[q.id]).length);
  let focusEntry = $derived<FocusEntry | undefined>(
    question ? focusMap?.[String(question.number)] : undefined,
  );
  let currentPage = $derived(focusEntry?.page ?? question?.page_number);

  onMount(() => {
    // Duração até 24h por sessão: zera ao sair da prova; o display
    // congela em 24:00:00.
    clockStart = performance.now();
    const updateClock = () => {
      const now = paused ? pauseBegin : performance.now();
      const elapsed = Math.floor((now - clockStart) / 1000);
      clockText = formatTimer(Math.min(86400, Math.max(0, elapsed)));
    };
    updateClock();
    clockId = window.setInterval(updateClock, 250);
    hostExamP2P(exam.id);
    fetchFocusMap(exam.id).then(
      (map) => { if (alive) focusMap = map; },
      () => undefined,
    );
    try { nightMode = localStorage.getItem('mira:solve-night') === '1'; } catch { /* sem persistência */ }
    applyNight();
  });

  onDestroy(() => {
    alive = false;
    if (clockId !== undefined) window.clearInterval(clockId);
    pageRefComp?.destroy();
    shutdownP2PSafe();
    document.getElementById('root')?.classList.remove('night');
  });

  // Modo noturno: classe no #root (escopo view-solve) + persistência.
  function applyNight(): void {
    document.getElementById('root')?.classList.toggle('night', nightMode);
    try { localStorage.setItem('mira:solve-night', nightMode ? '1' : '0'); } catch { /* sem persistência */ }
  }

  function toggleNight(): void {
    nightMode = !nightMode;
    applyNight();
  }

  // $watch("currentIdx"): scroll do índice ativo + reload da página.
  // No mount a página também é carregada; só o scrollIntoView
  // é pulado na primeira execução.
  $effect(() => {
    void currentIdx;
    const first = firstIdxRun;
    firstIdxRun = false;
    if (!first) {
      const grid = indexGridEl;
      void tick().then(() => {
        const active = grid?.querySelector('.answer-key-number.active');
        if (active) (active as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
        moveAkCursor();
      });
    } else {
      void tick().then(() => moveAkCursor());
    }
    reloadPage();
  });

  // .then do getFocusMap: recarrega a página quando o mapa chega.
  $effect(() => {
    if (focusMap) reloadPage();
  });

  function togglePause(): void {
    if (paused) {
      clockStart += performance.now() - pauseBegin;
      paused = false;
    } else {
      pauseBegin = performance.now();
      paused = true;
    }
  }

  // Cursor do gabarito: faixa vertical que desliza para a coluna ativa
  // (direita ao avançar, esquerda ao voltar). Mutação direta no DOM,
  // sem reatividade: só transform, custo de compositor.
  // Rolagem lateral do gabarito (compositor; comportada em PC fraco).
  function scrollAkGrid(dir: number): void {
    indexGridEl?.scrollBy({ left: dir * 240, behavior: 'smooth' });
  }

  function moveAkCursor(): void {
    const grid = indexGridEl;
    const cursor = akCursorEl;
    if (!grid || !cursor) return;
    const active = grid.querySelector('.answer-key-number.active') as HTMLElement | null;
    if (!active) return;
    cursor.style.width = `${active.offsetWidth}px`;
    cursor.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  function reloadPage(): void {
    const ref = pageRefComp;
    const q = question;
    if (ref && q) ref.load(exam.id, currentPage, q, focusEntry, exam.title);
  }

  function selectQuestion(i: number): void {
    if (paused) return;
    restoreFeedback(i);
    currentIdx = i;
  }

  // Restaura o feedback da questão destino (ou limpa, se não respondida).
  function restoreFeedback(i: number): void {
    const nq = questions[i];
    feedback = (nq && feedbacks[nq.id]) ?? null;
  }

  function selectAnswer(label: string): void {
    const q = question;
    if (!q || feedback || paused) return;
    // Clicar na marcada desmarca.
    if (answers[q.id] === label) {
      const next = { ...answers };
      delete next[q.id];
      answers = next;
      return;
    }
    // Clicar na alternativa riscada (sem tesoura visível) restaura.
    if (isEliminated(q.id, label)) {
      const cur = eliminated[q.id] ?? [];
      eliminated = { ...eliminated, [q.id]: cur.filter((l) => l !== label) };
      return;
    }
    answers = { ...answers, [q.id]: label };
  }

  // Tesoura: risca a alternativa (elimina visualmente). Alternativa
  // riscada não pode ser marcada; riscar a marcada limpa a seleção.
  // O estado é por questão e sobrevive à navegação entre questões.
  function isEliminated(qid: number, label: string): boolean {
    return (eliminated[qid] ?? []).includes(label);
  }

  function toggleEliminate(e: Event, qid: number, label: string, total: number): void {
    e.stopPropagation();
    if (feedback || paused) return;
    const cur = eliminated[qid] ?? [];
    // Não pode anular todas: pelo menos uma alternativa fica disponível.
    if (!cur.includes(label) && cur.length + 1 >= total) return;
    eliminated = {
      ...eliminated,
      [qid]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
    };
    if (answers[qid] === label) {
      const next = { ...answers };
      delete next[qid];
      answers = next;
    }
  }

  async function submitAnswer(): Promise<void> {
    const q = question;
    if (!q || !answers[q.id] || submitting || feedbacks[q.id] || paused) return;
    submitting = true;
    feedback = null;
    try {
      const data = await postAnswer(q.id, answers[q.id]);
      if (data.isCorrect === null || data.isCorrect === undefined) {
        feedback = { correct: false, correctAnswer: '?', unknown: true };
      } else {
        const isCorrect = data.isCorrect === true;
        feedback = { correct: isCorrect, correctAnswer: data.correctAnswer ?? '?' };
        results = { ...results, [q.id]: isCorrect ? 'correct' : 'wrong' };
      }
      if (feedback) feedbacks = { ...feedbacks, [q.id]: feedback };
    } catch {
      feedback = { correct: false, correctAnswer: '?' };
      results = { ...results, [q.id]: 'wrong' };
      feedbacks = { ...feedbacks, [q.id]: feedback };
    } finally {
      submitting = false;
    }
  }

  function goNext(): void {
    if (paused) return;
    if (currentIdx < total - 1) {
      restoreFeedback(currentIdx + 1);
      currentIdx += 1;
    }
  }

  function goPrev(): void {
    if (paused) return;
    if (currentIdx > 0) {
      restoreFeedback(currentIdx - 1);
      currentIdx -= 1;
    }
  }

  function optionClass(label: string): string {
    const q = question;
    if (!q) return 'option';
    const isSelected = selected === label;
    const isCorrectAnswer = !!feedback && feedback.correctAnswer === label;
    const isWrongSelected = !!feedback && isSelected && !feedback.correct;
    const isUnknown = feedback?.unknown === true;
    let cls = 'option';
    if (isSelected && !feedback) cls += ' selected';
    if (feedback && !isUnknown && isCorrectAnswer) cls += ' correct-highlight';
    if (!isUnknown && isWrongSelected) cls += ' wrong-highlight';
    if (feedback) cls += ' disabled';
    return cls;
  }
</script>

<!-- Sem <style>: classes vêm do CSS global já portado (styles.css etc.). -->

{#if question}
  <div class="solve-banner">
    <div class="solve-banner-inner">
      <nav class="solve-crumbs" aria-label="Navegação estrutural">
        <button onclick={onBack}>Início</button><span aria-hidden="true">/</span><button onclick={onBack}>Provas</button>
      </nav>
      <h2>{exam.title}</h2>
    </div>
  </div>
  <div class="solve notranslate" translate="no">
    <div class="solve-workspace">
      <aside class="pdf-column">
        <div class="pdf-delim">
          <div class="clock-container">
            <div class="clock-inner">
              <button class="clock-pause" aria-label={paused ? 'Continuar cronômetro' : 'Pausar cronômetro'} onclick={togglePause}>
                {#if paused}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                {:else}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
                {/if}
              </button>
              <span class="clock-time">{clockText}</span>
            </div>
          </div>
        </div>
        <PageReference bind:this={pageRefComp} disabled={paused} />
      </aside>
      <section class="question-panel">
        <div class="question-header">
          <h2 class="question-number">Questão {question.number}</h2>
          <!-- From Uiverse.io by Type-Delta -->
          <label for="themeToggle" class="themeToggle st-sunMoonThemeToggleBtn" title="Modo noturno" aria-label="Modo noturno">
            <input type="checkbox" id="themeToggle" class="themeToggleInput" checked={!nightMode} onchange={toggleNight} />
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" stroke="none" aria-hidden="true">
              <mask id="moon-mask">
                <rect x="0" y="0" width="20" height="20" fill="white"></rect>
                <circle cx="11" cy="3" r="8" fill="black"></circle>
              </mask>
              <circle class="sunMoon" cx="10" cy="10" r="8" mask="url(#moon-mask)"></circle>
              <g>
                <circle class="sunRay sunRay1" cx="18" cy="10" r="1.5"></circle>
                <circle class="sunRay sunRay2" cx="14" cy="16.928" r="1.5"></circle>
                <circle class="sunRay sunRay3" cx="6" cy="16.928" r="1.5"></circle>
                <circle class="sunRay sunRay4" cx="2" cy="10" r="1.5"></circle>
                <circle class="sunRay sunRay5" cx="6" cy="3.1718" r="1.5"></circle>
                <circle class="sunRay sunRay6" cx="14" cy="3.1718" r="1.5"></circle>
              </g>
            </svg>
          </label>
        </div>
        <div class="question-index">
          <div class="index-header">
            <span class="index-title">ÍNDICE DE QUESTÕES</span>
            <span class="index-count">{question.number}/{total}</span>
          </div>
          <div bind:this={indexGridEl} class="index-grid answer-key-grid" style:grid-template-columns={`repeat(${total}, 20px)`}>
            {#each questions as q, i (q.id)}
              <button
                class="answer-key-number"
                class:active={i === currentIdx}
                style:grid-row="1"
                style:grid-column={i + 1}
                aria-label={`Ir para questão ${q.number}`}
                onclick={() => selectQuestion(i)}
              >{String(q.number).padStart(2, '0')}</button>
            {/each}
            {#each altLabels as label, ri}
              {#each questions as q, i (q.id)}
                {@const r = results[q.id]}
                <button
                  class="answer-key-cell"
                  class:covered={answers[q.id] !== label}
                  class:selected={answers[q.id] === label}
                  class:answer-correct={answers[q.id] === label && r === 'correct'}
                  class:answer-wrong={answers[q.id] === label && r === 'wrong'}
                  class:active={i === currentIdx}
                  style:grid-row={ri + 2}
                  style:grid-column={i + 1}
                  aria-label={`Questão ${q.number}, alternativa ${label}`}
                  onclick={() => selectQuestion(i)}
                >{label}</button>
              {/each}
            {/each}
          </div>
        </div>
        <div class="answer-section">
          {#if !feedback}
            <h3 class="answer-title">ESCOLHA UMA RESPOSTA</h3>
          {/if}
          <div id="options-host">
            {#each question.alternatives as alt (alt.label)}
              {@const isMarked = selected === alt.label}
              {@const isCorrect = !!feedback && !feedback.unknown && feedback.correctAnswer === alt.label}
              {#if !feedback || isMarked || isCorrect}
                {#if feedback && isCorrect}
                  <span class="correct-flag">Resposta correta</span>
                {/if}
                {#if feedback && isMarked && !isCorrect}
                  <span class="marked-flag">Sua resposta</span>
                {/if}
                <div class={optionClass(alt.label)} class:eliminated={!feedback && isEliminated(question.id, alt.label)} data-label={alt.label} onclick={() => selectAnswer(alt.label)}>
                  {#if !feedback}
                    <button class="scissor-btn" class:on={isEliminated(question.id, alt.label)} class:scissor-hidden={selected === alt.label} title="Riscar alternativa" aria-label={'Riscar alternativa ' + alt.label} aria-pressed={isEliminated(question.id, alt.label)} onclick={(e) => toggleEliminate(e, question.id, alt.label, question.alternatives.length)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 8.5 20 20M8.5 15.5 20 4"/></svg>
                    </button>
                  {/if}
                  <div class="option-letter">
                    ({alt.label})
                  </div>
                  {#if feedback || isMarked}
                    <div class="option-text texto-questao">{alt.text}</div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        </div>
        <div class="bottom-nav" class:feedback-active={!!feedback}>
          <div class="nav-arrows">
            <button class="nav-arrow" id="prev-btn" disabled={currentIdx === 0} onclick={goPrev}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
            <button class="nav-arrow" id="next-btn" disabled={currentIdx === total - 1} onclick={goNext}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
          </div>
          {#if feedback}
            {#if currentIdx === total - 1}
              <button class="btn-respond btn-finish" id="finish-btn" onclick={onFinish} disabled={!allAnswered || paused}>
                {allAnswered ? 'Finalizar prova' : `Faltam ${total - answeredCount} questões`}
              </button>
            {:else}
              <button class="btn-respond" id="respond-btn" disabled={paused} onclick={goNext}>Próxima</button>
            {/if}
          {:else}
            <button class="btn-respond" id="respond-btn" onclick={submitAnswer} disabled={!selected || submitting || paused}>
              {submitting ? 'Enviando...' : 'Responder'}
            </button>
          {/if}
        </div>
      </section>
    </div>
  </div>
{:else}
  <div class="panel" style="padding: 40px; text-align: center; color: #6C7480">Carregando prova...</div>
{/if}
