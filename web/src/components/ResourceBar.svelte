<script>
  export let state;
  export let resourceIndex;

  const fmt = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(n % 1 === 0 ? 0 : 1));
  const fmtRate = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
</script>

<div class="px-4 py-2 bg-stone-950/90 backdrop-blur border-b border-stone-800">
  <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
    <span class="flex items-center gap-1" title="Bevölkerung / Wohnraum">
      <span>👥</span>
      <span class="font-mono">{Math.floor(state.population)}/{state.housing}</span>
    </span>
    <span class="flex items-center gap-1" title="Freie Arbeiter">
      <span>💪</span>
      <span class="font-mono">{state.workers.idle}</span>
      <span class="text-stone-500">frei</span>
    </span>
    <span class="w-px h-4 bg-stone-700"></span>
    {#each state.resources as r (r.id)}
      {@const def = resourceIndex[r.id]}
      <span class="flex items-center gap-1" title={def?.name?.de || r.id}>
        <span>{def?.icon || '📦'}</span>
        <span class="font-mono">{fmt(r.amount)}</span>
        {#if r.capacity != null}<span class="text-stone-600 text-xs">/{fmt(r.capacity)}</span>{/if}
        <span class="text-xs font-mono {r.ratePerTick >= 0 ? 'text-emerald-500' : 'text-red-400'}">
          {fmtRate(r.ratePerTick)}
        </span>
      </span>
    {/each}
    <span class="ml-auto text-xs text-stone-600 font-mono" title="Tick">⏱ {state.tick}</span>
  </div>
</div>
