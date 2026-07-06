<script>
  import { createEventDispatcher } from 'svelte';
  import { build, setWorkers } from '../lib/api.js';

  export let def;
  export let state;
  export let resourceIndex;
  export let buildings;
  export let epochs;
  export let isNew = false;

  const dispatch = createEventDispatcher();

  $: built = state.buildings.find((b) => b.id === def.id);
  $: unlock = state.unlocks[def.id] || { unlocked: true, missing: [] };
  $: affordable = Object.entries(def.cost || {}).every(
    ([rid, amount]) => (state.resources.find((r) => r.id === rid)?.amount ?? 0) >= amount
  );
  $: buildingIndex = Object.fromEntries((buildings || []).map((b) => [b.id, b]));
  $: epochIndex = Object.fromEntries((epochs || []).map((e) => [e.id, e]));
  $: maxWorkers = (def.workers || 0) * (built?.count || 0);

  const resName = (rid) => (rid === '*' ? 'alle' : resourceIndex[rid]?.name?.de || rid);
  const resIcon = (rid) => (rid === '*' ? '📦' : resourceIndex[rid]?.icon || '📦');

  const missingLabel = (m) => {
    if (m.type === 'epoch') return `Epoche ${epochIndex[m.need]?.name?.de || m.need}`;
    if (m.type === 'building') return `${buildingIndex[m.id]?.name?.de || m.id} ×${m.need}`;
    if (m.type === 'resource') return `${resName(m.id)} ${m.have}/${m.need}`;
    if (m.type === 'population') return `Bevölkerung ${m.have}/${m.need}`;
    return '';
  };

  async function doBuild() {
    try {
      await build(def.id);
      dispatch('action', { ok: true, msg: `${def.name?.de || def.id} wird gebaut 🏗️` });
    } catch (e) {
      dispatch('action', { ok: false, msg: e.message });
    }
  }
  async function workers(delta) {
    try {
      await setWorkers(def.id, delta);
      dispatch('action', { ok: true, msg: `Arbeiter angepasst` });
    } catch (e) {
      dispatch('action', { ok: false, msg: e.message });
    }
  }
</script>

<div
  class="rounded-lg border bg-stone-900 p-4 flex flex-col gap-2 transition
  {unlock.unlocked ? 'border-stone-700' : 'border-stone-800 opacity-60'}"
>
  <div class="flex items-start gap-3">
    <span class="text-3xl leading-none">{def.icon || '🏠'}</span>
    <div class="flex-1">
      <div class="flex items-center gap-2">
        <h3 class="font-semibold text-stone-100">{def.name?.de || def.id}</h3>
        {#if isNew}<span class="text-xs bg-violet-800/70 border border-violet-600 rounded-full px-2">Neu ✨</span>{/if}
        {#if built?.count}<span class="text-xs bg-stone-800 rounded-full px-2 font-mono">×{built.count}</span>{/if}
        {#if built?.pending}<span class="text-xs bg-amber-900/60 rounded-full px-2 font-mono" title="im Bau">🏗️ {built.pending}</span>{/if}
      </div>
      {#if def.description?.de}
        <p class="text-xs text-stone-500 mt-0.5">{def.description.de}</p>
      {/if}
    </div>
  </div>

  <div class="text-xs space-y-1 text-stone-400">
    {#if def.production && Object.keys(def.production.outputs || {}).length}
      <div>
        {#if Object.keys(def.production.inputs || {}).length}
          {#each Object.entries(def.production.inputs) as [rid, rate]}
            <span class="mr-1">{resIcon(rid)}−{rate}</span>
          {/each}
          <span class="mx-1 text-stone-600">→</span>
        {/if}
        {#each Object.entries(def.production.outputs) as [rid, rate]}
          <span class="mr-1 text-emerald-400">{resIcon(rid)}+{rate}</span>
        {/each}
        <span class="text-stone-600">/Tick</span>
        {#if def.workers}<span class="ml-2">💪{def.workers}</span>{/if}
      </div>
    {/if}
    {#if def.storage}
      <div>Lager: {#each Object.entries(def.storage) as [rid, cap]}<span class="mr-2">{resIcon(rid)}+{cap}</span>{/each}</div>
    {/if}
    {#if def.housing?.capacity}
      <div>Wohnraum: 👥+{def.housing.capacity}</div>
    {/if}
    <div class="text-stone-500">
      Kosten:
      {#each Object.entries(def.cost || {}) as [rid, amount]}
        {@const have = state.resources.find((r) => r.id === rid)?.amount ?? 0}
        <span class="mr-2 {have >= amount ? '' : 'text-red-400'}">{resIcon(rid)}{amount}</span>
      {/each}
      {#if def.buildTimeTicks}<span class="text-stone-600">⏱{def.buildTimeTicks} Ticks</span>{/if}
    </div>
  </div>

  {#if !unlock.unlocked}
    <div class="text-xs text-amber-600/80 mt-auto">
      🔒 {unlock.missing.map(missingLabel).filter(Boolean).join(' · ')}
    </div>
  {:else}
    <div class="flex items-center gap-2 mt-auto pt-1">
      <button
        class="text-sm rounded px-3 py-1 font-medium transition
        {affordable ? 'bg-amber-700 hover:bg-amber-600 text-white' : 'bg-stone-800 text-stone-500 cursor-not-allowed'}"
        disabled={!affordable}
        on:click={doBuild}
      >
        Bauen
      </button>
      {#if def.workers > 0 && built?.count}
        <div class="ml-auto flex items-center gap-1 text-sm">
          <button class="w-6 h-6 rounded bg-stone-800 hover:bg-stone-700" on:click={() => workers(-1)}>−</button>
          <span class="font-mono w-12 text-center" title="Arbeiter zugewiesen / maximal">
            {built.workers}/{maxWorkers}
          </span>
          <button class="w-6 h-6 rounded bg-stone-800 hover:bg-stone-700" on:click={() => workers(1)}>+</button>
        </div>
      {/if}
    </div>
  {/if}
</div>
