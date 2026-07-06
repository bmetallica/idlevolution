<script>
  import { createEventDispatcher } from 'svelte';

  export let buildings = [];
  export let state;
  export let resourceIndex = {};
  export let activeId = null; // aktuell gewähltes Bau-Gebäude
  export let newPackIds = new Set();

  const dispatch = createEventDispatcher();

  const CAT_LABEL = { housing: '🏠 Wohnen', storage: '📦 Lager', civic: '🏛️ Gemeinwesen' };
  const resIcon = (rid) => (rid === '*' ? '📦' : resourceIndex[rid]?.icon || '📦');
  const resName = (rid) => (rid === '*' ? 'alle' : resourceIndex[rid]?.name?.de || rid);

  $: byId = Object.fromEntries(buildings.map((b) => [b.id, b]));
  // Produzent je Ressource (erstes Gebäude mit diesem Output)
  $: producerOf = (() => {
    const m = {};
    for (const b of buildings) for (const rid of Object.keys(b.production?.outputs || {})) if (!(rid in m)) m[rid] = b.id;
    return m;
  })();

  // Wurzel-Rohstoff einer Kette: verfolgt den ersten Input rückwärts bis zum
  // Rohstoff-Erzeuger. So landen Holzfäller UND Sägewerk in der "Holz"-Kette.
  function rootRid(b, seen = new Set()) {
    if (!b?.production) return null;
    const ins = Object.keys(b.production.inputs || {});
    if (!ins.length) return Object.keys(b.production.outputs || {})[0] || null; // Rohstoff-Erzeuger
    const firstIn = ins[0];
    const prod = byId[producerOf[firstIn]];
    if (prod && prod.id !== b.id && !seen.has(prod.id)) { seen.add(b.id); return rootRid(prod, seen) || firstIn; }
    return firstIn;
  }
  // Ketten-Tiefe für die Reihenfolge innerhalb eines Reiters
  function chainLevel(b, seen = new Set()) {
    const ins = Object.keys(b?.production?.inputs || {});
    if (!ins.length || seen.has(b.id)) return 0;
    seen.add(b.id);
    let lvl = 0;
    for (const rid of ins) { const p = byId[producerOf[rid]]; if (p && p.id !== b.id) lvl = Math.max(lvl, 1 + chainLevel(p, seen)); }
    return lvl;
  }

  $: groupOf = (b) => (b.category === 'production' ? 'chain:' + (rootRid(b) || 'x') : b.category);
  $: levelOf = Object.fromEntries(buildings.map((b) => [b.id, chainLevel(b)]));

  // Reiter aufbauen: Ketten-Gruppen (nach Rohstoff-Wert) + Wohnen/Lager/Gemeinwesen
  $: tabs = (() => {
    const groups = new Map();
    for (const b of buildings) {
      const key = groupOf(b);
      if (!groups.has(key)) {
        if (key.startsWith('chain:')) {
          const rid = key.slice(6);
          groups.set(key, { key, label: `${resIcon(rid)} ${resName(rid)}`, order: (resourceIndex[rid]?.baseValue ?? 99), n: 0 });
        } else {
          groups.set(key, { key, label: CAT_LABEL[key] || key, order: 1000 + (key === 'housing' ? 0 : key === 'storage' ? 1 : 2), n: 0 });
        }
      }
      groups.get(key).n++;
    }
    return [...groups.values()].sort((a, b) => a.order - b.order);
  })();

  let activeTab = null;
  $: if (tabs.length && !tabs.some((t) => t.key === activeTab)) activeTab = tabs[0].key;

  $: shown = buildings
    .filter((b) => groupOf(b) === activeTab)
    .sort((a, b) => (levelOf[a.id] - levelOf[b.id]) || (a.name?.de || a.id).localeCompare(b.name?.de || b.id));

  const affordable = (def) => Object.entries(def.cost || {}).every(([rid, amt]) => (state.resources.find((r) => r.id === rid)?.amount ?? 0) >= amt);
  const unlocked = (def) => state.unlocks[def.id]?.unlocked ?? true;

  function describe(def) {
    if (def.description?.de) return def.description.de;
    const p = def.production;
    if (p && Object.keys(p.outputs || {}).length) {
      const outs = Object.keys(p.outputs).map(resName).join(', ');
      const ins = Object.keys(p.inputs || {});
      return ins.length ? `Verarbeitet ${ins.map(resName).join(', ')} zu ${outs}.` : `Gewinnt ${outs}.`;
    }
    if (def.housing?.capacity) return `Bietet Wohnraum für ${def.housing.capacity} Siedler.`;
    if (def.storage) return 'Erhöht die Lagerkapazität.';
    return '';
  }
  function flowOf(def) {
    const p = def.production;
    if (!p || !Object.keys(p.outputs || {}).length) return null;
    return { ins: Object.keys(p.inputs || {}), outs: Object.keys(p.outputs) };
  }

  function selectBuilding(def) {
    if (!unlocked(def)) return;
    dispatch('pick', { def: activeId === def.id ? null : def });
  }
</script>

<div class="absolute left-0 top-12 bottom-0 z-30 w-72 flex flex-col bg-stone-950/92 backdrop-blur border-r border-stone-700 pointer-events-auto">
  <div class="px-3 py-2 border-b border-stone-800 flex items-center justify-between">
    <span class="text-sm font-semibold text-amber-200">🏗️ Bauen</span>
    <span class="text-[10px] text-stone-500"><kbd class="px-1 bg-stone-800 rounded">R</kbd> drehen</span>
  </div>

  <!-- Ketten- & Kategorie-Reiter -->
  <div class="flex flex-wrap gap-1 px-2 py-2 border-b border-stone-800 shrink-0">
    {#each tabs as tab}
      <button
        class="text-[11px] px-2 py-1 rounded transition {activeTab === tab.key ? 'bg-amber-800 text-amber-100' : 'bg-stone-800/70 text-stone-300 hover:bg-stone-700'}"
        on:click={() => (activeTab = tab.key)}
        title={tab.label}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <!-- Gebäudeliste der aktiven Kette -->
  <div class="flex-1 overflow-y-auto px-2 py-2 space-y-2">
    {#each shown as def (def.id)}
      {@const lock = !unlocked(def)}
      {@const canAfford = affordable(def)}
      {@const flow = flowOf(def)}
      <button
        class="relative w-full text-left rounded-lg border p-2.5 transition
          {activeId === def.id ? 'border-amber-400 bg-amber-900/30' : lock ? 'border-stone-800 bg-stone-900/50 opacity-70' : 'border-stone-700 bg-stone-900 hover:border-stone-500'}"
        on:click={() => selectBuilding(def)}
        disabled={lock}
      >
        {#if newPackIds.has(def._pack)}
          <span class="absolute -top-1 -right-1 text-[10px] bg-violet-700 rounded-full px-1">✨</span>
        {/if}
        <div class="flex items-start gap-2">
          <span class="text-2xl leading-none mt-0.5">{def.icon || '🏠'}</span>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-stone-100 leading-tight">{def.name?.de || def.id}</div>
            {#if flow}
              <div class="flex items-center gap-0.5 text-[11px] leading-none mt-0.5">
                {#each flow.ins as rid}<span class="text-red-300/90" title={resName(rid)}>{resIcon(rid)}</span>{/each}
                {#if flow.ins.length}<span class="text-stone-600">→</span>{/if}
                {#each flow.outs as rid}<span class="text-emerald-300" title={resName(rid)}>{resIcon(rid)}</span>{/each}
              </div>
            {/if}
          </div>
        </div>
        <p class="mt-1 text-[10px] text-stone-400 leading-snug">{describe(def)}</p>
        <div class="mt-1 flex flex-wrap items-center gap-1 text-[10px] {canAfford ? 'text-stone-400' : 'text-red-400'}">
          <span class="text-stone-600">Kosten:</span>
          {#each Object.entries(def.cost || {}) as [rid, amt]}
            <span title={resName(rid)}>{resIcon(rid)}{amt}</span>
          {/each}
          {#if def.workers}<span class="text-stone-600 ml-1">👷{def.workers}</span>{/if}
        </div>
        {#if lock}<div class="text-[10px] text-amber-600/80 mt-0.5">🔒 gesperrt</div>{/if}
      </button>
    {/each}
    {#if !shown.length}<p class="text-xs text-stone-600 px-1">Keine Gebäude in dieser Kette.</p>{/if}
  </div>
</div>
