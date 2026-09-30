<script lang="ts">
  // Trava de 120 frames, scroll por mutação direta do DOM e faixa em px
  // derivada de % em runtime.
  import { onDestroy, onMount, tick } from 'svelte';
  import type { FocusEntry, Question } from './solve-types';
  import { API, fetchPageSrc, openPdfModal, warmPdf } from './bridge';

  let viewportEl = $state<HTMLElement | null>(null);
  let paginaEl = $state<HTMLElement | null>(null);
  let faixaEl = $state<HTMLElement | null>(null);

  let zoom = $state(1);
  let src = $state<string | null>(null);
  let dragging = $state(false);
  let page = $state(0);

  // Sem reatividade: só lidos dentro de handlers/APIs externas.
  let examId = 0;
  let questionNumber = 0;
  let focus: FocusEntry | undefined = undefined;
  let examTitle = '';
  let pdfOpen = false;
  let faixaFixa = false;
  let faixaTimer: number | undefined = undefined;
  let focoTentativas = 0;
  let drag: { x: number; y: number; scrollLeft: number; scrollTop: number } | null = null;
  let alive = true;
  let isFullscreen = $state(false);

  onMount(() => {
    const sync = () => { isFullscreen = !!document.fullscreenElement; };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  });

  onDestroy(() => {
    alive = false;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  });

  export function load(
    nextExamId: number,
    nextPage: number | undefined,
    question: Question,
    nextFocus: FocusEntry | undefined,
    title: string,
  ): void {
    examId = nextExamId;
    page = nextPage ?? 0;
    questionNumber = question.number;
    focus = nextFocus;
    examTitle = title || `Questão ${question.number}`;
    focoTentativas = 0;
    src = null;
    alive = true;
    fetchPageSrc(nextExamId, page).then(
      (value) => { if (alive) src = value; },
      () => { if (alive) src = `${API}/exams/${nextExamId}/pages/${page}`; },
    );
    warmPdf(nextExamId);
    void tick().then(() => aplicarFoco());
  }

  export function destroy(): void {
    alive = false;
  }

  function aplicarFoco(): void {
    const container = viewportEl;
    const pagina = paginaEl;
    if (!container || !pagina) return;
    if (!pagina.clientHeight) {
      if (focoTentativas < 120) {
        focoTentativas += 1;
        requestAnimationFrame(() => aplicarFoco());
      }
      return;
    }
    focoTentativas = 0;
    const faixa = faixaEl;
    if (focus?.y_inicio == null) {
      if (faixa) faixa.classList.remove('ativa');
      return;
    }
    const alvo = ((focus.y_inicio as number) / 100) * pagina.clientHeight;
    const alvoTop = Math.max(0, alvo - container.clientHeight * 0.22);
    const alvoLeft = Number.isFinite(focus.x_center as number)
      ? Math.max(0, pagina.offsetLeft + ((focus.x_center as number) / 100) * pagina.clientWidth - container.clientWidth * 0.5)
      : container.scrollLeft;
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isLaggy = navigator.deviceMemory !== undefined && (navigator as unknown as { deviceMemory: number }).deviceMemory < 4;
    if (prefersReduced || isLaggy) {
      container.scrollTop = alvoTop;
      container.scrollLeft = alvoLeft;
    } else if ('scrollBehavior' in document.documentElement.style) {
      try {
        container.scrollTo({ top: alvoTop, left: alvoLeft, behavior: 'smooth' });
      } catch {
        container.scrollTop = alvoTop;
        container.scrollLeft = alvoLeft;
      }
    } else {
      const startTop = container.scrollTop;
      const startLeft = container.scrollLeft;
      const dTop = alvoTop - startTop;
      const dLeft = alvoLeft - startLeft;
      const dur = 260;
      let t0: number | null = null;
      const step = (t: number) => {
        if (t0 === null) t0 = t;
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        container.scrollTop = startTop + dTop * e;
        container.scrollLeft = startLeft + dLeft * e;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    if (faixa) {
      const alturaPrecisa =
        Number.isFinite(focus.focus_height as number) && focus.focus_height
          ? (focus.focus_height as number) / 100
          : null;
      const alturaBloco = focus.focus_scale ? Math.min(0.34, Math.max(0.16, 0.86 / (focus.focus_scale as number))) : 0.24;
      const alturaBase = Math.max(88, Math.round((alturaPrecisa ?? alturaBloco) * pagina.clientHeight));
      const limiteEstimado = alturaPrecisa ? pagina.clientHeight : Math.round(container.clientHeight * 0.86);
      const base = Math.min(alturaBase, Math.max(88, limiteEstimado), Math.max(88, pagina.clientHeight - alvo));
      const alturaFaixa = Math.min(pagina.clientHeight - Math.max(0, alvo - 4), base + 12);
      faixa.style.top = `${Math.max(0, alvo - 4)}px`;
      faixa.style.height = `${alturaFaixa}px`;
      if (Number.isFinite(focus.x_center as number)) {
        if ((focus.x_center as number) > 45 && (focus.x_center as number) < 55) {
          faixa.style.left = '0';
          faixa.style.right = '0';
        } else {
          // Meia-banda esquerda cobre 90% da página: o texto da questão
          // vai até ~85% e a faixa precisa ir junto (máscara dissolve a ponta).
          const ladoEsquerdo = (focus.x_center as number) < 50;
          faixa.style.left = ladoEsquerdo ? '0' : '50%';
          faixa.style.right = ladoEsquerdo ? '10%' : '0';
        }
      } else {
        faixa.style.left = '0';
        faixa.style.right = '0';
      }
      const rot = (((questionNumber * 13) % 7) - 3) * 0.09;
      faixa.style.setProperty('--faixa-rotate', `${rot.toFixed(2)}deg`);
      window.clearTimeout(faixaTimer);
      faixa.classList.remove('ativa');
      void faixa.offsetWidth;
      faixa.classList.add('ativa');
      if (!faixaFixa) {
        faixaTimer = window.setTimeout(() => faixa.classList.remove('ativa'), 1800);
      }
    }
  }

  function warm(): void {
    warmPdf(examId, true);
  }

  function openPdf(): void {
    pdfOpen = true;
    openPdfModal(examId, examTitle || `Questão ${questionNumber}`, () => { pdfOpen = false; });
  }

  // Tela cheia real do navegador na página inteira (mesmo efeito do F11).
  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      /* Fullscreen API indisponível: sem efeito. */
    }
  }

  function changeZoom(d: number): void {
    zoom = Math.min(4, Math.max(1, Math.round((zoom + d) * 100) / 100));
    void tick().then(() => aplicarFoco());
  }

  function toggleFixa(): void {
    const el = faixaEl;
    if (!el) return;
    const isActive = el.classList.contains('ativa');
    window.clearTimeout(faixaTimer);
    if (isActive) {
      el.classList.remove('ativa');
      faixaFixa = false;
    } else {
      faixaFixa = true;
      aplicarFoco();
      setTimeout(() => window.clearTimeout(faixaTimer), 60);
    }
  }

  function pointerDown(e: PointerEvent): void {
    const container = viewportEl;
    if (!container) return;
    drag = { x: e.clientX, y: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop };
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function pointerMove(e: PointerEvent): void {
    const container = viewportEl;
    const start = drag;
    if (!container || !start) return;
    container.scrollLeft = start.scrollLeft - (e.clientX - start.x);
    container.scrollTop = start.scrollTop - (e.clientY - start.y);
  }

  function pointerUp(e: PointerEvent): void {
    drag = null;
    dragging = false;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
  }
</script>

<!-- Sem <style>: o CSS global (focus.css/styles.css) já foi portado para
     src/*.css. Escopar aqui alteraria especificidade e quebraria o visual. -->

{#if page}
  <figure class="page-reference">
    <div
      bind:this={viewportEl}
      class:dragging
      class="image-viewport"
      onpointerdown={pointerDown}
      onpointermove={pointerMove}
      onpointerup={pointerUp}
      onpointercancel={pointerUp}
    >
      <div
        bind:this={paginaEl}
        class="pagina-pdf"
        style:--pdf-zoom-percent="{zoom * 100}%"
        style:--pdf-zoom-width="{Math.round(960 * zoom)}px"
      >
        <img
          draggable="false"
          loading="lazy"
          decoding="async"
          src={src}
          alt="Página {page} do PDF original"
          onload={() => requestAnimationFrame(() => aplicarFoco())}
        />
        <div bind:this={faixaEl} class="faixa-questao" aria-hidden="true"></div>
      </div>
    </div>
    <div class="image-toolbar">
      <div class="toolbar-group toolbar-zoom">
        <button aria-label="Diminuir zoom" title="Diminuir zoom" onclick={() => changeZoom(-0.25)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
        <span title="Nível de zoom">Zoom {Math.round(zoom * 100)}%</span>
        <button aria-label="Aumentar zoom" title="Aumentar zoom" onclick={() => changeZoom(0.25)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
        <button aria-label="Redefinir imagem" title="Redefinir zoom" onclick={() => { zoom = 1; }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
      </div>
      <div class="toolbar-group">
        <button class="fit-button" onclick={openPdf} onmouseenter={warm} onfocus={warm}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg> PDF</button>
        <button class="fit-button" onclick={toggleFullscreen}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg> {isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}</button>
        <button class="fit-button" onclick={toggleFixa}>Foco</button>
      </div>
    </div>
  </figure>
{:else}
  <div class="pdf-empty"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>Página original indisponível</span></div>
{/if}
