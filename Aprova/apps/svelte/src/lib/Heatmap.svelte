<script lang="ts">
  // Mapa de constância: mesma janela de 371 dias, markup declarativo.
  import { onMount } from 'svelte';
  import { fetchActivity } from './bridge';
  import type { DayActivity } from './solve-types';

  const WINDOW = 371;
  let days = $state<DayActivity[]>([]);

  let visible = $derived(days.slice(-WINDOW));
  let cells = $derived<({ day: DayActivity | null; key: string })[]>(
    [...Array(Math.max(0, WINDOW - visible.length)).fill(null), ...visible]
      .slice(-WINDOW)
      .map((day, i) => ({ day, key: day?.date ?? `empty-${i}` })),
  );
  let activeDays = $derived(visible.filter((d) => (d.count ?? 0) > 0).length);
  let total = $derived(visible.reduce((s, d) => s + (d.count ?? 0), 0));

  onMount(() => {
    fetchActivity()
      .then((list) => {
        days = list;
      })
      .catch(() => {
        days = [];
      });
  });
</script>

<section class="side-card consistency modern-heatmap github-calendar">
  <div class="side-title">
    <div><span class="eyebrow">CONSTÂNCIA</span><h3>Ritmo de estudo</h3></div>
    <span class="activity-total">{total} questões</span>
  </div>
  <div class="heatmap-scroll">
    <div class="github-months"><span>Jan</span><span>Mar</span><span>Mai</span><span>Jul</span><span>Set</span><span>Nov</span></div>
    <div class="consistency-grid compact-heatmap github-grid">
      {#each cells as cell (cell.key)}
        {@const count = cell.day?.count ?? 0}
        <i
          class="level-{Math.min(4, count)}"
          title={cell.day ? `${cell.day.label}: ${count} ${count === 1 ? 'questão' : 'questões'}` : 'Sem registro'}
        ></i>
      {/each}
    </div>
  </div>
  <div class="heatmap-footer">
    <span>{activeDays} dias ativos</span>
    <div>
      <small>Menos</small>
      {#each [0, 1, 2, 3, 4] as level (level)}<i class="level-{level}"></i>{/each}
      <small>Mais</small>
    </div>
  </div>
</section>
