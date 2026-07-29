<script>
  import { createEventDispatcher } from 'svelte';
  import { advanceEpoch, claimQuest, generateQuests } from '../lib/api.js';
  import { sfxChime, sfxCoin } from '../lib/sound.js';
  import Sparkline from './Sparkline.svelte';

  export let state;
  export let epochs;
  export let resourceIndex;
  export let buildings;
  export let history = []; // D2: Verlaufspuffer [{t, pop, sat, food}]

  const dispatch = createEventDispatcher();

  // B1: Aufstieg ist eine bewusste Entscheidung — Button statt 3-Uhr-Überraschung
  let advancing = false;
  async function doAdvance() {
    if (advancing) return;
    advancing = true;
    try {
      const r = await advanceEpoch();
      if (!r.ok) throw new Error(r.error);
      sfxChime();
      dispatch('changed', { msg: '🎉 Aufstieg vollzogen — willkommen in der neuen Epoche!', ok: true });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    advancing = false;
  }

  // E1: Tagesziele — Einlösen + einmalige Erst-Generierung
  let questBusy = false;
  async function onClaim(id) {
    if (questBusy) return;
    questBusy = true;
    try {
      const r = await claimQuest(id);
      if (!r.ok) throw new Error(r.error);
      sfxCoin();
      dispatch('changed', { msg: `🎯 Ziel erreicht — Belohnung eingelöst!`, ok: true });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    questBusy = false;
  }
  async function onGenerateQuests() {
    if (questBusy) return;
    questBusy = true;
    try {
      const r = await generateQuests();
      if (!r.ok) throw new Error(r.error);
      dispatch('changed', { msg: `🎯 ${r.count} neue Tagesziele erhalten`, ok: true });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    questBusy = false;
  }

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
    {:else if state.popTrend === 'capped'}
      <span class="text-xs text-amber-100 bg-amber-900/70 border border-amber-700 rounded px-2 py-0.5 font-medium" title={state.popReason}>🏠 Wohnraum voll</span>
    {/if}
    {#if state.epoch.ready}
      <span class="text-xs text-amber-100 bg-amber-700/80 border border-amber-500 rounded px-2 py-0.5 font-medium animate-pulse" title="Alle Aufstiegsbedingungen erfüllt — Details unten">⬆ Aufstieg bereit</span>
    {/if}
    {#if state.activeEvent}
      <span
        class="text-xs text-indigo-200 bg-indigo-900/60 border border-indigo-700 rounded px-2 py-0.5"
        title="{state.activeEvent.description || 'Tages-Ereignis'} — noch ~{Math.max(1, Math.round((state.activeEvent.endsInTicks * (state.tickSeconds || 5)) / 60))} min"
      >{state.activeEvent.icon} {state.activeEvent.name}</span>
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
    <!-- B1: Aufstiegs-Vorschau + bewusster Klick (statt Auto-Aufstieg) -->
    {#if state.epoch.ready && state.epoch.preview}
      {@const pv = state.epoch.preview}
      <div class="mt-2 pt-2 border-t border-amber-700/50">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-semibold text-amber-200">⬆ Bereit für: {state.epoch.next.name?.de || state.epoch.next.id}</span>
          <span class="text-[11px] text-stone-400">
            Produktion ×{pv.multiplier.from} → <b class="text-emerald-300">×{pv.multiplier.to}</b>
            {#if pv.tier}· 👥 {pv.tier}{/if}
            {#if pv.newBuildings?.length}· 🏗️ {pv.newBuildings.length} neue Gebäude{/if}
          </span>
        </div>
        {#if pv.needs?.length}
          <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span class="text-stone-500">Neue Bedürfnisse:</span>
            {#each pv.needs as n}
              <span
                class="rounded-full px-2 py-0.5 border {n.ok ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300' : 'border-amber-700 bg-amber-950/50 text-amber-300'}"
                title={!n.hasProducer
                  ? 'Kein Produzent bekannt — dieses Gut kann derzeit niemand herstellen!'
                  : n.ok
                    ? `Vorkette bindet ~${n.workersNeeded} Arbeiter (leistbar)`
                    : `Vorkette bindet ~${n.workersNeeded} Arbeiter — mehr als 15 % der Bevölkerung. Erst Produktion ausbauen!`}
              >
                {resourceIndex[n.id]?.icon || '📦'} {n.name} <span class="font-mono">{n.needPerTick}/t</span> {n.ok ? '✓' : '⚠'}
              </span>
            {/each}
          </div>
        {/if}
        {#if pv.newBuildings?.length}
          <div class="mt-1 text-[11px] text-stone-400 truncate" title={pv.newBuildings.map((b) => b.name).join(', ')}>
            Neu: {#each pv.newBuildings.slice(0, 8) as b}{b.icon} {/each}{#if pv.newBuildings.length > 8}…{/if}
          </div>
        {/if}
        <div class="mt-2 flex items-center gap-2">
          <button
            class="rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-3 py-1.5 text-sm font-semibold text-stone-950"
            on:click={doAdvance}
            disabled={advancing}
          >{advancing ? '…' : '⬆ Jetzt aufsteigen'}</button>
          <span class="text-[11px] text-stone-500">Die neuen Bedürfnisse gelten sofort — {#if pv.needs?.some((n) => !n.ok)}<b class="text-amber-300">⚠ mindestens ein Gut ist noch nicht leistbar</b>{:else}deine Wirtschaft ist bereit ✓{/if}</span>
        </div>
      </div>
    {/if}

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

    <!-- D2: Verlaufs-Sparklines (10-h-Fenster) — Trends sichtbar, bevor sie kippen -->
    {#if history.length > 5}
      {@const spanH = Math.round(((history[history.length - 1].t - history[0].t) / 3600000) * 10) / 10}
      <div class="mt-2 pt-2 border-t border-stone-800/70 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-stone-500">
        <span class="flex items-center gap-1.5" title="Bevölkerung (Verlauf)">👥 <Sparkline data={history.map((x) => x.pop)} color="#7dd3fc" label="Bevölkerung" /></span>
        <span class="flex items-center gap-1.5" title="Zufriedenheit (Verlauf)">😊 <Sparkline data={history.map((x) => x.sat)} color="#fcd34d" label="Zufriedenheit" /></span>
        <span class="flex items-center gap-1.5" title="Nahrung netto pro Tick (Verlauf; gestrichelt = Null-Linie)">🍖 <Sparkline data={history.map((x) => x.food)} color="#86efac" zeroLine label="Nahrung netto/Tick" /></span>
        <span>letzte {spanH} h</span>
      </div>
    {/if}

    <!-- Bedürfnisse -->
    {#if state.epoch.needs?.length}
      <div class="mt-2 pt-2 border-t border-stone-800/70 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span class="text-stone-500">Bedarf:</span>
        {#each state.epoch.needs as n}
          <span
            class="rounded-full px-2 py-0.5 border {!n.ok
              ? 'border-red-800 bg-red-950/40 text-red-300'
              : n.draining
                ? 'border-amber-700 bg-amber-950/40 text-amber-300'
                : 'border-emerald-800 bg-emerald-950/40 text-emerald-300'}"
            title={n.draining && n.ok ? 'Vorrat schrumpft — Produktion deckt den Verbrauch nicht' : 'Güterbedarf dieser Bevölkerungsstufe'}
          >
            {resourceIndex[n.id]?.icon || '📦'} {n.name || resourceIndex[n.id]?.name?.de || n.id}
            <span class="font-mono">{n.have}/{n.need}</span>
            {#if n.rate != null}<span class="font-mono opacity-80">({n.rate > 0 ? '+' : ''}{n.rate}/t)</span>{/if}
            {n.ok ? (n.draining ? '📉' : '✓') : '⚠️'}
          </span>
        {/each}
      </div>
    {/if}

    <!-- E1: Tagesziele (LLM-generiert, mechanisch validiert) -->
    {#if state.quests?.items?.length}
      <div class="mt-2 pt-2 border-t border-stone-800/70">
        <div class="text-xs text-stone-500 mb-1">🎯 Tagesziele <span class="text-stone-600">(täglich neu vom KI-Questgeber)</span></div>
        <div class="space-y-1">
          {#each state.quests.items as q (q.id)}
            <div class="flex items-center gap-2 text-xs rounded border px-2 py-1 {q.claimed ? 'border-stone-800 text-stone-600' : q.done ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-stone-700 bg-stone-900/50 text-stone-300'}">
              <span class="flex-1 min-w-0 truncate {q.claimed ? 'line-through' : ''}" title={q.title}>{q.title}</span>
              <span class="font-mono shrink-0 {q.done ? 'text-emerald-300' : 'text-stone-500'}">{q.have}/{q.need}</span>
              {#if q.claimed}
                <span class="shrink-0">✅</span>
              {:else if q.done}
                <button class="shrink-0 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-2 py-0.5 text-white" on:click={() => onClaim(q.id)} disabled={questBusy} title="Belohnung: +{q.reward?.amount} {q.rewardName}">
                  {q.rewardIcon} +{q.reward?.amount}
                </button>
              {:else}
                <span class="shrink-0 text-stone-600" title="Belohnung bei Abschluss: +{q.reward?.amount} {q.rewardName}">{q.rewardIcon} +{q.reward?.amount}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else if state.quests === null}
      <div class="mt-2 pt-2 border-t border-stone-800/70">
        <button class="text-xs text-stone-400 hover:text-amber-200 underline decoration-dotted" on:click={onGenerateQuests} disabled={questBusy}>
          🎯 Tagesziele vom KI-Questgeber holen
        </button>
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
        {#each (state.epoch.needs || []).filter((n) => !n.ok || n.draining) as n}
          <div class="mt-1 text-red-300/90">
            {resourceIndex[n.id]?.icon || '📦'} {n.name || n.id}: <span class="font-mono">{n.have}</span> vorhanden, Verbrauch <span class="font-mono">{n.need}</span>/Tick, Netto <span class="font-mono">{n.rate > 0 ? '+' : ''}{n.rate}</span>/Tick{#if n.ok && n.draining} — <b>Vorrat läuft leer</b>{/if}.
            <br>→ Baue/verstärke die Produktionskette für {n.name || n.id} und weise Arbeiter zu.
          </div>
        {/each}
      </div>
    {:else if state.popTrend === 'capped'}
      <!-- Wohnraum-Deckel: alles gesund, aber das Wachstum steht still -->
      <div class="mt-2 pt-2 border-t border-amber-900/60 text-xs text-amber-200">
        <div>🏠 <b>Wohnraum voll:</b> {Math.floor(state.population)} von {state.housing} Plätzen belegt.</div>
        <div class="mt-1 text-amber-300/90">→ Baue Wohngebäude, sonst wächst die Siedlung nicht weiter — Nahrung und Bedürfnisse sind gedeckt.</div>
      </div>
    {/if}
  {/if}
</div>
