<script>
  export let state;
  export let resourceIndex;

  const fmt = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(n % 1 === 0 ? 0 : 1));
  const fmtRate = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

  let hover = null; // { r, left, top }
  function enter(e, r) {
    const rect = e.currentTarget.getBoundingClientRect();
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - 250));
    hover = { r, left, top: rect.bottom + 4 };
  }
  function leave() { hover = null; }
</script>

<div class="px-4 py-2 bg-stone-950/90 backdrop-blur border-b border-stone-800">
  <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
    <span class="flex items-center gap-1 {state.popTrend === 'shrinking' ? 'text-red-400' : ''}" title={state.popReason || 'Bevölkerung / Wohnraum'}>
      <span>👥</span>
      <span class="font-mono">{Math.floor(state.population)}/{state.housing}</span>
      {#if state.popTrend === 'shrinking'}<span>📉</span>{:else if state.popTrend === 'growing'}<span class="text-emerald-500">📈</span>{/if}
    </span>
    <span class="flex items-center gap-1" title="Freie Arbeiter">
      <span>💪</span>
      <span class="font-mono">{state.workers.idle}</span>
      <span class="text-stone-500">frei</span>
    </span>
    <span class="w-px h-4 bg-stone-700"></span>
    {#each state.resources as r (r.id)}
      {@const def = resourceIndex[r.id]}
      <span
        class="flex items-center gap-1 cursor-help"
        on:mouseenter={(e) => enter(e, r)}
        on:mouseleave={leave}
      >
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

{#if hover}
  {@const def = resourceIndex[hover.r.id]}
  <div
    class="fixed z-[60] w-60 max-w-[80vw] rounded-lg border border-stone-700 bg-stone-900/97 backdrop-blur shadow-xl p-2.5 text-xs text-stone-200 pointer-events-none"
    style="left: {hover.left}px; top: {hover.top}px;"
  >
    <div class="flex items-center gap-1.5 font-semibold text-stone-100">
      <span>{def?.icon || '📦'}</span>
      <span>{def?.name?.de || hover.r.id}</span>
      <span class="ml-auto font-mono text-stone-400">
        {fmt(hover.r.amount)}{#if hover.r.capacity != null}<span class="text-stone-600">/{fmt(hover.r.capacity)}</span>{/if}
      </span>
    </div>

    {#if hover.r.flow?.length}
      <div class="mt-2 pt-1.5 border-t border-stone-800 space-y-1">
        {#each hover.r.flow as f}
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-stone-400 truncate">{f.amount >= 0 ? '▲' : '▼'} {f.label}</span>
            <span class="font-mono shrink-0 {f.amount >= 0 ? 'text-emerald-400' : 'text-red-400'}">{fmtRate(f.amount)}</span>
          </div>
        {/each}
        <div class="flex items-baseline justify-between gap-2 pt-1 mt-0.5 border-t border-stone-800 font-semibold">
          <span class="text-stone-300">Netto / Tick</span>
          <span class="font-mono {hover.r.ratePerTick >= 0 ? 'text-emerald-400' : 'text-red-400'}">{fmtRate(hover.r.ratePerTick)}</span>
        </div>
      </div>
    {:else}
      <div class="mt-2 pt-1.5 border-t border-stone-800 text-stone-500">
        Wird derzeit weder produziert noch verbraucht.
      </div>
    {/if}
  </div>
{/if}
