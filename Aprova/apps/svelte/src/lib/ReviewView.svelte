<script lang="ts">
  // Template declarativo reage sozinho; textareas por índice
  // preservam foco entre edições.
  import { app } from './store.svelte';
  import { saveQuestion } from './bridge';

  let selected = $state(0);
  let saving = $state(false);

  let exam = $derived(app.exam);
  let questions = $derived(exam?.questions ?? []);
  let question = $derived(questions[selected]);

  function patchQuestion(patch: Partial<(typeof questions)[number]>): void {
    const current = app.exam;
    const q = question;
    if (!current || !q) return;
    const qs = [...current.questions];
    qs[selected] = { ...q, ...patch };
    app.exam = { ...current, questions: qs };
  }

  function setLetter(letter: string): void {
    patchQuestion({ correct_answer: letter });
  }

  function setAltText(i: number, text: string): void {
    const q = question;
    if (!q) return;
    const alts = [...q.alternatives];
    alts[i] = { ...alts[i], text };
    patchQuestion({ alternatives: alts });
  }

  async function save(): Promise<void> {
    const q = question;
    if (!q) return;
    saving = true;
    try {
      await saveQuestion(q);
    } finally {
      saving = false;
      if (selected < questions.length - 1) selected += 1;
    }
  }
</script>

{#if exam && question}
  <div class="review-layout">
    <aside class="question-list">
      <h3>{exam.title}</h3>
      <p>{questions.length} questões encontradas</p>
      <div class="number-grid">
        {#each questions as q, i (q.id)}
          <button class:active={i === selected} onclick={() => (selected = i)}>{q.number}</button>
        {/each}
      </div>
      <button class="primary wide" onclick={() => app.setView('solve')}>Começar prova</button>
    </aside>
    <section class="panel editor">
      <div class="editor-head">
        <div><span class="eyebrow">QUESTÃO {question.number}</span><h2>Confira as alternativas</h2></div>
        <span class="status">REVISÃO PENDENTE</span>
      </div>
      <div class="alternatives review-choices">
        {#each question.alternatives as alt, i (alt.label)}
          <div class="alternative-edit">
            <button
              class="letter"
              class:correct={question.correct_answer === alt.label}
              onclick={() => setLetter(alt.label)}
            >{alt.label}</button>
            <textarea value={alt.text} oninput={(e) => setAltText(i, (e.target as HTMLTextAreaElement).value)}></textarea>
          </div>
        {/each}
      </div>
      <div class="editor-footer">
        <span>Clique na letra para definir o gabarito.</span>
        <button class="primary" onclick={save}>{saving ? 'Salvando...' : 'Salvar e avançar'}</button>
      </div>
    </section>
  </div>
{/if}
