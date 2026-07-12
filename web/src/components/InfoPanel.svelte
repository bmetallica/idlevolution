<script>
  import { createEventDispatcher } from 'svelte';
  import { demolishInstance, rotateInstance, setWorkers } from '../lib/api.js';
  import { chainNeighbors } from '../lib/chains.js';

  export let selection = null; // { instance, tile, terrain } aus IsoMap
  export let defIndex = {};
  export let resourceIndex = {};
  export let instances = [];
  export let shortages = new Set();
  export let bottlenecks = new Set(); // Durchlauf-Engpässe (läuft, aber ohne Puffer)
  export let state = null;
  export let mobile = false;

  const dispatch = createEventDispatcher();

  const bIcon = (bid) => defIndex[bid]?.icon || '🏢';
  const bName = (bid) => defIndex[bid]?.name?.de || bid;
  /** Fasst Ketten-Nachbarn zu {buildingId, count} zusammen. */
  function summarize(list) {
    const m = new Map();
    for (const { inst } of list) m.set(inst.buildingId, (m.get(inst.buildingId) || 0) + 1);
    return [...m.entries()].map(([buildingId, count]) => ({ buildingId, count }));
  }

  const TERRAIN_LABEL = {
    grass: '🌱 Wiese',
    sand: '🏖️ Sand',
    forest: '🌲 Wald',
    rock: '⛰️ Fels',
    water: '🌊 Wasser',
  };
  const resIcon = (rid) => (rid === '*' ? '📦' : resourceIndex[rid]?.icon || '📦');
  const resName = (rid) => (rid === '*' ? 'alle' : resourceIndex[rid]?.name?.de || rid);

  $: inst = selection?.instance;
  $: foreign = !!inst?._owner; // Gebäude eines (KI-)Nachbarn → nur ansehen, nicht steuern
  $: def = inst ? defIndex[inst.buildingId] : null;
  $: neigh = inst && def?.production ? chainNeighbors(inst, def, instances, defIndex) : { suppliers: [], customers: [] };
  $: inputRids = def?.production ? Object.keys(def.production.inputs || {}) : [];
  $: outputRids = def?.production ? Object.keys(def.production.outputs || {}) : [];
  $: missingInputs = inputRids.filter((r) => shortages.has(r));
  $: tightInputs = inputRids.filter((r) => bottlenecks.has(r) && !shortages.has(r));
  $: unsuppliedInputs = inputRids.filter((r) => !neigh.suppliers.some((s) => s.rid === r));
  $: suppliersByB = summarize(neigh.suppliers);
  $: customersByB = summarize(neigh.customers);

  $: bstate = (state?.buildings || []).find((b) => b.id === inst?.buildingId);
  $: maxWorkers = def?.workers ? def.workers * (bstate?.count || 1) : 0;

  async function doDemolish() {
    try {
      await demolishInstance(inst.id);
      dispatch('changed', { msg: 'Gebäude abgerissen (50 % Kosten erstattet)' });
      dispatch('close');
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
  }
  async function doRotate() {
    try {
      await rotateInstance(inst.id);
      dispatch('changed', { msg: 'Gebäude gedreht' });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
  }
  async function doWorkers(delta) {
    try {
      await setWorkers(inst.buildingId, delta);
      dispatch('changed', { msg: 'Arbeiter angepasst' });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
  }
</script>

{#if selection}
  <div class={mobile ? 'mobile-sheet' : 'absolute top-16 right-3 z-30 w-72 bg-stone-900/95 backdrop-blur border border-stone-700 rounded-lg shadow-xl'}>
    <div class="flex items-center justify-between px-3 py-2 border-b border-stone-800">
      <h3 class="font-semibold text-stone-100 text-sm">
        {#if def}{def.icon} {def.name?.de}{:else}{TERRAIN_LABEL[selection.terrain] || selection.terrain}{/if}
      </h3>
      <button class="text-stone-500 hover:text-stone-200" on:click={() => dispatch('close')}>✕</button>
    </div>

    <div class="p-3 space-y-2 text-xs">
      {#if def}
        {#if foreign}
          <div class="rounded bg-sky-950/60 border border-sky-800/70 px-2 py-1 text-sky-200">
            🤖 Gehört <b>{inst._owner}</b> — Nachbarinseln kannst du nur ansehen.
          </div>
        {/if}
        {#if def.description?.de}<p class="text-stone-400">{def.description.de}</p>{/if}
        {#if !inst.done}
          <p class="text-amber-400">🏗️ Im Bau — noch {inst.ticksLeft} Ticks</p>
        {/if}
        {#if def.production && Object.keys(def.production.outputs || {}).length}
          <div class="text-stone-300">
            <span class="text-stone-500">Produktion/Tick:</span>
            {#each Object.entries(def.production.inputs || {}) as [rid, r]}
              <span class="text-red-300 mr-1">{resIcon(rid)}−{r}</span>
            {/each}
            {#if Object.keys(def.production.inputs || {}).length}<span class="text-stone-600">→</span>{/if}
            {#each Object.entries(def.production.outputs) as [rid, r]}
              <span class="text-emerald-300 mr-1">{resIcon(rid)}+{r}</span>
            {/each}
          </div>
        {/if}

        <!-- Produktionskette (nur eigene Gebäude — Ketten-/Mangeldaten sind Spielerdaten) -->
        {#if def.production && inst.done && !foreign}
          {#if missingInputs.length}
            <div class="rounded bg-red-950/70 border border-red-800 px-2 py-1 text-red-200">
              ⚠️ Rohstoff-Mangel: {missingInputs.map((r) => resName(r)).join(', ')} — Produktion steht.
            </div>
          {:else if tightInputs.length}
            <div class="rounded bg-sky-950/60 border border-sky-800/70 px-2 py-1 text-sky-200">
              🔁 {tightInputs.map((r) => resName(r)).join(', ')} wird direkt ab Produktion verbraucht — läuft, aber ohne Lager-Puffer. Mehr Produzenten erhöhen den Durchsatz.
            </div>
          {:else if unsuppliedInputs.length}
            <div class="rounded bg-amber-950/60 border border-amber-800/70 px-2 py-1 text-amber-200">
              ⚠️ Kein Zulieferer für {unsuppliedInputs.map((r) => resName(r)).join(', ')} platziert.
            </div>
          {/if}
          {#if inputRids.length}
            <div class="text-stone-400">
              <span class="text-stone-500">Beliefert von:</span>
              {#if suppliersByB.length}
                {#each suppliersByB as s}<span class="mr-1.5 text-sky-300">{bIcon(s.buildingId)} {bName(s.buildingId)}{#if s.count > 1}·{s.count}{/if}</span>{/each}
              {:else}<span class="text-stone-600">—</span>{/if}
            </div>
          {/if}
          {#if outputRids.length}
            <div class="text-stone-400">
              <span class="text-stone-500">Liefert an:</span>
              {#if customersByB.length}
                {#each customersByB as s}<span class="mr-1.5 text-emerald-300">{bIcon(s.buildingId)} {bName(s.buildingId)}{#if s.count > 1}·{s.count}{/if}</span>{/each}
              {:else}<span class="text-stone-600">Lager</span>{/if}
            </div>
          {/if}
        {/if}
        <!-- Arbeiter-Zuweisung (gilt für alle Gebäude dieses Typs) -->
        {#if inst.done && def.workers && !foreign}
          <div class="flex items-center gap-2">
            <span class="text-stone-500">👷 Arbeiter:</span>
            <button class="w-5 h-5 grid place-items-center rounded bg-stone-800 hover:bg-stone-700 disabled:opacity-40" on:click={() => doWorkers(-1)} disabled={(bstate?.workers ?? 0) <= 0}>−</button>
            <span class="font-mono text-stone-200">{bstate?.workers ?? 0}/{maxWorkers}</span>
            <button class="w-5 h-5 grid place-items-center rounded bg-stone-800 hover:bg-stone-700 disabled:opacity-40" on:click={() => doWorkers(1)} disabled={(state?.workers?.idle ?? 0) <= 0 || (bstate?.workers ?? 0) >= maxWorkers}>+</button>
            <span class="text-stone-600">{state?.workers?.idle ?? 0} frei</span>
          </div>
        {/if}
        {#if def.housing?.capacity}<div>🏠 Wohnraum: +{def.housing.capacity}</div>{/if}
        {#if def.storage}
          <div>📦 Lager: {#each Object.entries(def.storage) as [rid, c]}<span class="mr-1">{resIcon(rid)}+{c}</span>{/each}</div>
        {/if}
        {#if def.placement?.adjacent}
          <div class="text-stone-500">
            Braucht angrenzend:
            {#each Object.entries(def.placement.adjacent) as [t, n]}<span class="mr-1">{n}× {TERRAIN_LABEL[t] || t}</span>{/each}
          </div>
        {/if}
        <div class="text-stone-600">Position: {inst.x}, {inst.y} · Ausrichtung {(inst.rot ?? 0) * 90}°</div>
        {#if !foreign}
        <div class="flex gap-2 mt-2">
          <button
            class="flex-1 text-xs bg-stone-800 hover:bg-stone-700 border border-stone-600 rounded px-2 py-1.5 text-stone-100"
            on:click={doRotate}
            title="Gebäude um 90° drehen"
          >
            ↻ Drehen
          </button>
          <button
            class="flex-1 text-xs bg-red-900/70 hover:bg-red-800 border border-red-700 rounded px-2 py-1.5 text-red-100"
            on:click={doDemolish}
          >
            🔨 Abreißen
          </button>
        </div>
        {/if}
      {:else}
        <p class="text-stone-400">Leeres Feld · {TERRAIN_LABEL[selection.terrain] || selection.terrain}</p>
        <p class="text-stone-600">
          Wähle links ein Gebäude, um es hier zu platzieren — passendes Terrain vorausgesetzt.
        </p>
      {/if}
    </div>
  </div>
{/if}
