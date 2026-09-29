<script lang="ts">
  // Cronômetro de importação via $effect com cleanup de intervalo.
  import { app } from './store.svelte';
  import { formatTimer, importExams } from './bridge';

  let examFile = $state<File | null>(null);
  let answerFile = $state<File | null>(null);
  let secs = $state(0);

  $effect(() => {
    if (!app.loading) {
      secs = 0;
      return;
    }
    const startedAt = performance.now();
    const update = () => {
      secs = Math.floor((performance.now() - startedAt) / 1000);
    };
    update();
    const id = window.setInterval(update, 250);
    return () => window.clearInterval(id);
  });

  function pickExam(e: Event): void {
    examFile = (e.target as HTMLInputElement).files?.[0] ?? null;
  }

  function pickAnswer(e: Event): void {
    answerFile = (e.target as HTMLInputElement).files?.[0] ?? null;
  }

  async function send(): Promise<void> {
    if (!examFile || !answerFile) return;
    app.loading = true;
    app.error = '';
    try {
      const data = await importExams(examFile, answerFile);
      if (data.status !== 200 && !(data.status >= 200 && data.status < 300)) {
        // 409 = PDF já importado: abre a prova existente em vez de duplicar.
        if (data.status === 409 && data.id) {
          await app.refresh();
          await app.openExam(data.id, 'review');
          return;
        }
        throw new Error(data.error || 'Não foi possível importar');
      }
      await app.refresh();
      if (data.id) await app.openExam(data.id, 'review');
    } catch (e) {
      app.error = e instanceof Error ? e.message : 'Falha ao importar';
    } finally {
      app.loading = false;
    }
  }
</script>

<div class="panel import-panel">
  <div class="steps">
    <span class="current">1</span><i class:done={!!examFile}></i>
    <span class:current={!!answerFile}>2</span><i class:done={!!answerFile}></i>
    <span>3</span>
  </div>
  <div class="center-title">
    <span class="eyebrow">PROVA + GABARITO</span>
    <h2>Crie uma prova completa</h2>
    <p>Envie os dois PDFs. O título, as questões e as respostas serão identificados automaticamente.</p>
  </div>
  <div class="upload-grid">
    <label class:dropzone={!examFile} class:selected={!!examFile}>
      <input type="file" accept="application/pdf" onchange={pickExam} />
      <span class="upload-label">1. PDF da prova</span>
      <div class="upload-icon">
        {#if examFile}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16l-4-4-4 4"/><path d="M12 12v9"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
        {/if}
      </div>
      <h3>{examFile ? examFile.name : 'Selecionar PDF'}</h3>
      <p>{examFile ? `${(examFile.size / 1024 / 1024).toFixed(2)} MB` : 'Questões e alternativas'}</p>
      <span>PDF • máximo 20 MB</span>
    </label>
    <label class:dropzone={!answerFile} class:selected={!!answerFile}>
      <input type="file" accept="application/pdf" onchange={pickAnswer} />
      <span class="upload-label">2. PDF do gabarito</span>
      <div class="upload-icon">
        {#if answerFile}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16l-4-4-4 4"/><path d="M12 12v9"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
        {/if}
      </div>
      <h3>{answerFile ? answerFile.name : 'Selecionar PDF'}</h3>
      <p>{answerFile ? `${(answerFile.size / 1024 / 1024).toFixed(2)} MB` : 'Respostas oficiais'}</p>
      <span>PDF • máximo 20 MB</span>
    </label>
  </div>
  <div class="smart-note">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 5.8L19.7 10l-5.8 1.9L12 17.7l-1.9-5.8L4.3 10l5.8-1.9z"/></svg>
    <div>
      <strong>{app.loading ? (secs < 8 ? 'Lendo os PDFs' : 'Aplicando OCR quando necessário') : 'Título inteligente'}</strong>
      <span>{app.loading ? `Processamento em andamento • ${formatTimer(secs)}` : 'Vamos analisar o conteúdo da prova e criar um nome organizado para ela.'}</span>
    </div>
  </div>
  <button class="primary wide" disabled={!examFile || !answerFile || app.loading} onclick={send}>
    {app.loading ? 'Processando prova e gabarito...' : 'Gerar minha prova'}
  </button>
  <small class="privacy">{app.loading ? 'Mantenha esta página aberta. PDFs escaneados podem levar alguns minutos.' : 'A prova só será criada depois que os dois arquivos forem enviados.'}</small>
</div>
