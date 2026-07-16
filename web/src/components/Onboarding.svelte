<script>
  // E: Onboarding — 5 Schritte für Erstspieler, mechanisch aus dem Spielstand
  // validiert (kein Skript-Theater: erledigt ist, was wirklich im State steht).
  // Erscheint nur, solange die Siedlung jung ist; ✕ oder Abschluss beendet es dauerhaft.
  import { createEventDispatcher } from 'svelte';

  export let state;
  export let buildings = []; // Content-Defs (für Nahrungs-/Wohn-Erkennung)
  export let resourceIndex = {};
  export let mobile = false;

  const dispatch = createEventDispatcher();

  $: builtCount = (id) => (state?.buildings || []).find((b) => b.id === id)?.count ?? 0;
  $: hasFoodBuilding = buildings.some((d) => builtCount(d.id) > 0 && Object.keys(d.production?.outputs || {}).some((rid) => resourceIndex[rid]?.category === 'food'));
  $: hasHousing = buildings.some((d) => builtCount(d.id) > 0 && d.housing?.capacity > 0);

  $: steps = [
    { icon: '🍖', text: 'Baue ein Nahrungsgebäude (🏗️ Bau-Menü, Reiter „Nahrung")', done: hasFoodBuilding },
    { icon: '👷', text: 'Weise dem Gebäude Arbeiter zu (anklicken oder 👷-Panel)', done: (state?.workers?.assigned ?? 0) > 0 },
    { icon: '🏠', text: 'Baue eine Hütte — mehr Wohnraum lässt die Siedlung wachsen', done: hasHousing },
    { icon: '🛤️', text: 'Ziehe eine Straße zwischen deinen Gebäuden (+Produktion)', done: (state?.logistics?.roadTiles ?? 0) > 0 },
    { icon: '🏛️', text: 'Erfülle die Aufstiegsbedingungen im Epochen-Banner', done: (state?.epoch?.order ?? 0) > 0 || !!state?.epoch?.ready },
  ];
  $: current = steps.findIndex((s) => !s.done);
  $: allDone = current === -1;
</script>

<div class="{mobile ? 'fixed left-2 right-2 bottom-20' : 'absolute left-3 bottom-3 w-80'} z-40 rounded-lg border border-emerald-800 bg-stone-900/95 backdrop-blur shadow-2xl p-3">
  <div class="flex items-center gap-2">
    <span class="text-sm font-semibold text-emerald-200">{allDone ? '🎉 Grundlagen gemeistert!' : '🧭 Erste Schritte'}</span>
    <button class="ml-auto text-stone-500 hover:text-stone-200" on:click={() => dispatch('dismiss')} title="Tutorial ausblenden">✕</button>
  </div>
  {#if allDone}
    <p class="mt-1 text-xs text-stone-300">Deine Siedlung steht — ab jetzt führen Bedürfnisse, Epochen und Nachbarn die Geschichte weiter.</p>
    <button class="mt-2 text-xs bg-emerald-700 hover:bg-emerald-600 rounded px-3 py-1.5 text-white" on:click={() => dispatch('dismiss')}>Los geht's</button>
  {:else}
    <div class="mt-2 space-y-1">
      {#each steps as s, i}
        <div class="flex items-start gap-2 text-xs rounded px-2 py-1 {i === current ? 'bg-emerald-950/50 border border-emerald-800 text-emerald-100' : s.done ? 'text-stone-500 line-through decoration-stone-600' : 'text-stone-500'}">
          <span class="shrink-0">{s.done ? '✅' : i === current ? s.icon : '·'}</span>
          <span>{s.text}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>
