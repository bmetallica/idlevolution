<script>
  // B3: Arbeiter-Management — alle Gebäudetypen auf einen Blick, ±-Zuweisung,
  // kettenbewusstes Auto-Verteilen (nutzt serverseitig die KI-Logik).
  import { createEventDispatcher } from 'svelte';
  import { setWorkers, autoWorkers } from '../lib/api.js';

  export let state;
  export let defIndex = {};
  export let resourceIndex = {};

  const dispatch = createEventDispatcher();
  let busy = false;

  $: workforce = state?.workers?.total ?? 0;
  $: idle = state?.workers?.idle ?? 0;

  // Nur besetzbare Typen (workers > 0) mit mindestens einem fertigen Gebäude
  $: rows = (state?.buildings || [])
    .filter((b) => b.count > 0 && (defIndex[b.id]?.workers ?? 0) > 0)
    .map((b) => {
      const def = defIndex[b.id] || {};
      const max = (def.workers ?? 0) * b.count;
      const outs = Object.keys(def.production?.outputs || {});
      return {
        id: b.id,
        name: def.name?.de || b.id,
        icon: def.icon || '🏠',
        count: b.count,
        workers: b.workers ?? 0,
        max,
        frac: max > 0 ? (b.workers ?? 0) / max : 0,
        food: outs.some((rid) => resourceIndex[rid]?.category === 'food'),
        empty: (b.workers ?? 0) === 0,
      };
    })
    // Nahrung zuerst (überlebenswichtig), dann unbesetzte, dann nach Name
    .sort((a, b) => (b.food - a.food) || (b.empty - a.empty) || a.name.localeCompare(b.name));

  async function change(id, delta) {
    if (busy) return;
    busy = true;
    try {
      const r = await setWorkers(id, delta);
      if (!r.ok) throw new Error(r.error);
      dispatch('changed', {});
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    busy = false;
  }
  async function auto() {
    if (busy) return;
    busy = true;
    try {
      const r = await autoWorkers();
      if (!r.ok) throw new Error(r.error);
      dispatch('changed', { msg: r.placed > 0 ? `⚡ ${r.placed} Arbeiter verteilt (Nahrung → Bedarfs-Kette → Rest)` : 'Keine freien Arbeiter zu verteilen', ok: true });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    busy = false;
  }
</script>

<div class="flex items-center gap-2 mb-2">
  <span class="text-sm font-semibold text-emerald-200">👷 Arbeiter</span>
  <span class="text-[11px] text-stone-400 font-mono">{workforce - idle}/{workforce} zugewiesen · <b class="{idle > 0 ? 'text-emerald-300' : 'text-stone-500'}">{idle} frei</b></span>
  <button class="ml-auto text-stone-500 hover:text-stone-200" on:click={() => dispatch('close')}>✕</button>
</div>

<button
  class="w-full mb-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-3 py-1.5 text-sm text-white"
  on:click={auto}
  disabled={busy || idle <= 0}
  title="Freie Arbeiter kettenbewusst verteilen: Nahrung → Bedarfs-Vorketten → Baumaterial → Rest"
>⚡ Auto-verteilen ({idle} frei)</button>

{#if rows.length}
  <div class="space-y-1">
    {#each rows as r (r.id)}
      <div class="rounded border px-2 py-1.5 {r.empty ? 'border-amber-800/70 bg-amber-950/20' : 'border-stone-700 bg-stone-800/50'}">
        <div class="flex items-center gap-1.5 text-xs">
          <span>{r.icon}</span>
          <span class="text-stone-200 truncate flex-1" title="{r.name} × {r.count}">{r.name} <span class="text-stone-500">×{r.count}</span></span>
          {#if r.food}<span title="Nahrungskette">🍖</span>{/if}
          {#if r.empty}<span class="text-[10px] text-amber-400" title="Keine Arbeiter — Gebäude steht still">⚠ unbesetzt</span>{/if}
          <span class="font-mono text-stone-300">{r.workers}/{r.max}</span>
          <button class="w-6 h-6 grid place-items-center rounded bg-stone-900 border border-stone-700 hover:border-stone-500 disabled:opacity-30" disabled={busy || r.workers <= 0} on:click={() => change(r.id, -1)} title="Arbeiter abziehen">−</button>
          <button class="w-6 h-6 grid place-items-center rounded bg-stone-900 border border-stone-700 hover:border-stone-500 disabled:opacity-30" disabled={busy || r.workers >= r.max || idle <= 0} on:click={() => change(r.id, 1)} title="Arbeiter zuweisen">+</button>
        </div>
        <div class="mt-1 h-1 rounded bg-stone-900 overflow-hidden">
          <div class="h-full {r.frac >= 1 ? 'bg-emerald-500' : r.frac > 0 ? 'bg-amber-500' : 'bg-red-700'}" style="width: {Math.round(r.frac * 100)}%"></div>
        </div>
      </div>
    {/each}
  </div>
{:else}
  <p class="text-xs text-stone-500">Noch keine besetzbaren Gebäude gebaut.</p>
{/if}
