<script lang="ts">
  let { query = $bindable(''), board = $bindable(''), status = $bindable(''), year = $bindable(''), sort = $bindable('recent'), boards = [], years = [], reset } = $props<{
    query?: string; board?: string; status?: string; year?: string; sort?: string;
    boards?: string[]; years?: string[]; reset: () => void;
  }>();
  let open = $state(false);
</script>

<div class="gran-filters" class:open>
  <div class="gran-filters-head">
    <h3>Filtros</h3>
    <div>
      <button class="gran-filters-toggle" onclick={() => (open = !open)} aria-expanded={open}>{open ? 'Ocultar' : 'Exibir'}</button>
      <button class="gran-clear" onclick={reset}>Limpar</button>
    </div>
  </div>
  <div class="gran-filters-body">
  <label class="gran-field"><span>Palavra-chave</span><input type="search" placeholder="Buscar prova..." bind:value={query} /></label>
  <label class="gran-field"><span>Banca</span><select bind:value={board}><option value="">Todas</option>{#each boards as item}<option value={item}>{item}</option>{/each}</select></label>
  <label class="gran-field"><span>Situação</span><select bind:value={status}><option value="">Todas</option><option value="todo">Não iniciadas</option><option value="doing">Em andamento</option><option value="done">Concluídas</option></select></label>
  <label class="gran-field"><span>Ano</span><select bind:value={year}><option value="">Todos</option>{#each years as item}<option value={item}>{item}</option>{/each}</select></label>
  <label class="gran-field"><span>Ordenar por</span><select bind:value={sort}><option value="recent">Mais recentes</option><option value="progress">Mais progresso</option><option value="name">Nome (A–Z)</option></select></label>
  </div>
</div>
