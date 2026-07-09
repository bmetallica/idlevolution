<script>
  export let state;
  export let epochs;
  export let resourceIndex;
  export let buildings;

  $: buildingIndex = Object.fromEntries((buildings || []).map((b) => [b.id, b]));
  $: sat = state.satisfaction ?? 1;
  $: satClass = sat >= 0.8 ? 'text-emerald-300' : sat >= 0.4 ? 'text-amber-300' : 'text-red-300';

  // Einklapp-Zustand über Reloads merken
  let collapsed = false;
  try { collapsed = localStorage.getItem('epochCollapsed') === '1'; } catch {}
  function toggle() {
    collapsed = !collapsed;
    try { localStorage.setItem('epochCollapsed', collapsed ? '1' : '0'); } catch {}
  }

  const label = (item) => {
    if (item.type === 'resource') return `${resourceIndex[item.id]?.icon || ''} ${resourceIndex[item.id]?.name?.de || item.id}`;
    if (item.type === 'building') return `${buildingIndex[item.id]?.icon || ''} ${buildingIndex[item.id]?.name?.de || item.id}`;
    if (item.type === 'population') return '👥 Bevölkerung';
    return item.id || item.type;
  };
</script>

<div class="rounded-lg border border-amber-900/50 bg-gradient-to-r from-amber-950/40 to-stone-900 px-4 py-2 mb-3 shadow-lg">
  <!-- Kopfzeile: immer sichtbar -->
  <div class="flex items-center gap-3">
    <div class="shrink-0">
      <div class="text-[10px] text-stone-500 uppercase tracking-widest leading-none">Epoche {state.epoch.order + 1}</div>
      <div class="text-lg font-semibold text-amber-200 leading-tight">{state.epoch.name?.de || state.epoch.id}</div>
    </div>
    {#if state.epoch.tier}
      <span class="text-xs text-stone-300 border-l border-stone-700 pl-3">👥 {state.epoch.tier.de || state.epoch.tier}</span>
    {/if}
    <span class="text-xs {satClass}" title="Zufriedenheit der Bevölkerung">😊 {Math.round(sat * 100)}%</span>
    {#if state.popTrend === 'shrinking'}
      <span class="text-xs text-red-100 bg-red-800/80 border border-red-600 rounded px-2 py-0.5 font-medium" title={state.popReason}>📉 schrumpft</span>
    {/if}
    {#if collapsed && state.epoch.next}
      <span class="text-[11px] text-stone-500 truncate hidden sm:inline">→ {state.epoch.next.name?.de || state.epoch.next.id}</span>
    {/if}
    <button
      class="ml-auto shrink-0 w-6 h-6 grid place-items-center rounded text-stone-400 hover:text-amber-200 hover:bg-stone-800"
      on:click={toggle}
      title={collapsed ? 'Ausklappen' : 'Einklappen'}
      aria-label={collapsed ? 'Ausklappen' : 'Einklappen'}
    >
      <span class="text-xs transition-transform {collapsed ? '' : 'rotate-180'}">▾</span>
    </button>
  </div>

  {#if !collapsed}
    <!-- Aufstiegs-Fortschritt -->
    {#if state.epoch.next && state.epoch.progress?.length}
      <div class="mt-2">
        <div class="text-xs text-stone-500 mb-1">
          Nächste Epoche: <span class="text-stone-300">{state.epoch.next.name?.de || state.epoch.next.id}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          {#each state.epoch.progress as item}
            <span
              class="text-xs rounded-full px-2 py-0.5 border {item.ok
                ? 'border-emerald-700 bg-emerald-900/40 text-emerald-300'
                : 'border-stone-700 bg-stone-900 text-stone-400'}"
            >
              {label(item)}: <span class="font-mono">{item.have}/{item.need}</span> {item.ok ? '✓' : ''}
            </span>
          {/each}
        </div>
      </div>
    {:else if !state.epoch.next}
      <div class="mt-2 text-sm text-stone-500 italic">
        Dies ist die jüngste Epoche — die KI erweitert die Geschichte über Nacht. 🌙
      </div>
    {/if}

    <!-- Bedürfnisse -->
    {#if state.epoch.needs?.length}
      <div class="mt-2 pt-2 border-t border-stone-800/70 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span class="text-stone-500">Bedarf:</span>
        {#each state.epoch.needs as n}
          <span
            class="rounded-full px-2 py-0.5 border {n.ok
              ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
              : 'border-red-800 bg-red-950/40 text-red-300'}"
            title="Güterbedarf dieser Bevölkerungsstufe"
          >
            {resourceIndex[n.id]?.icon || '📦'} {resourceIndex[n.id]?.name?.de || n.id}
            <span class="font-mono">{n.have}/{n.need}</span> {n.ok ? '✓' : '⚠️'}
          </span>
        {/each}
      </div>
    {/if}

    <!-- Schrumpf-Grund + Nahrungsdetails -->
    {#if state.popTrend === 'shrinking'}
      <div class="mt-2 pt-2 border-t border-red-900/60 text-xs text-red-200">
        <div>📉 <b>Bevölkerung schrumpft:</b> {state.popReason}.</div>
        {#if state.food && !state.food.sufficient}
          <div class="mt-1 text-red-300/90">
            🍖 Nahrung: <span class="font-mono">{state.food.available}</span> vorhanden, Bedarf <span class="font-mono">{state.food.needPerTick}</span>/Tick, Produktion <span class="font-mono">{state.food.rate}</span>/Tick.
            <br>→ Baue/verstärke Nahrungsgebäude (Sammlerhütte, Garten, Fischer) und weise ihnen Arbeiter zu.
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
