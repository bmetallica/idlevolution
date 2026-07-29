<script>
  // Nachbarn / KI-Spieler: Rangliste, Verschiffen (Stufe 4), Krieg (Stufe 6 v2),
  // Online-Nachbarn. Aus App.svelte herausgelöst — Panel und die zugehörigen
  // Aktionen lagen dort über 70 Zeilen Skript und 110 Zeilen Markup verteilt.
  import { createEventDispatcher } from 'svelte';
  import { enableAi, disableAi, sendShip, attack, cancelAttack } from '../lib/api.js';
  import { isMobile } from '../lib/device.js';
  import OnlineSection from './OnlineSection.svelte';

  export let players = null;
  export let resourceIndex = {};
  export let ownResources = []; // state.resources
  export let topBarH = 0;

  const dispatch = createEventDispatcher();

  let busy = false;
  let sendTo = null, sendRes = '', sendAmt = 50;
  let atkTo = null, atkSoldiers = 10;

  // Rangliste: nach Bevölkerung, dann Gebäudezahl
  $: ranked = players ? [...players.players].sort((a, b) => (b.population - a.population) || (b.buildings - a.buildings)) : [];
  $: human = (players?.players || []).find((p) => p.id === 0);
  $: humanHarbor = human?.harbor;
  $: humanArmy = human?.army ?? 0;

  /** Sperren → aufrufen → melden → Eltern zum Neuladen anstoßen. */
  async function act(fn, okMsg) {
    if (busy) return;
    busy = true;
    try {
      const r = await fn();
      if (r && r.ok === false) throw new Error(r.error);
      dispatch('changed', { msg: typeof okMsg === 'function' ? okMsg(r) : okMsg, ok: true });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    busy = false;
  }

  async function addAi() {
    if (busy) return;
    busy = true;
    try {
      const r = await enableAi();
      dispatch('changed', { msg: `KI-Spieler „${r.player.name}" auf Insel ${r.player.islandId} zugeschaltet`, ok: true });
      dispatch('focusIsland', { islandId: r.player.islandId }); // Kamera zur neuen Insel
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    busy = false;
  }
  const removeAi = (id) => act(() => disableAi(id), 'KI-Spieler abgeschaltet');
  const sendGoods = () =>
    sendTo && sendRes && sendAmt > 0 &&
    act(() => sendShip(sendTo, sendRes, sendAmt), `📦 ${sendAmt}× ${resourceIndex[sendRes]?.name?.de || sendRes} verschifft`);
  const launchAttack = () =>
    atkTo && atkSoldiers > 0 &&
    act(() => attack(atkTo, atkSoldiers), (r) => `⚔️ Krieg erklärt — ${r.soldiers} Soldaten schlagen in der kommenden Nacht zu`);
  const withdrawAttack = (defenderId) =>
    act(() => cancelAttack(defenderId), (r) => `↩️ Kriegserklärung zurückgezogen — ${r.soldiers} Soldaten kehren zurück`);
</script>

<!-- scrollbar: auf kleinen Displays war der untere Teil sonst unerreichbar -->
<div
  class={$isMobile ? 'mobile-sheet p-3' : 'absolute right-3 z-30 w-80 max-w-[92vw] rounded-lg border border-sky-800 bg-stone-900/95 backdrop-blur shadow-xl p-3 overflow-y-auto'}
  style={$isMobile ? '' : `top: ${topBarH + 52}px; max-height: calc(100vh - ${topBarH + 64}px)`}
>
  <div class="flex items-center gap-2 mb-2">
    <span class="text-sm font-semibold text-sky-200">🌍 Nachbarn</span>
    <button class="ml-auto text-stone-500 hover:text-stone-200" on:click={() => dispatch('close')}>✕</button>
  </div>
  {#if players}
    <div class="space-y-1.5">
      {#each ranked as p, i}
        <div class="flex items-center gap-2 rounded border px-2 py-1.5 text-sm {p.kind === 'human' ? 'border-emerald-800/70 bg-emerald-950/30' : 'border-stone-700 bg-stone-800/60'}">
          <span class="text-xs font-mono text-stone-500 w-4 text-right">{i + 1}</span>
          <span>{p.kind === 'human' ? '🧑' : '🤖'}</span>
          <button class="text-left flex-1 min-w-0" title="Zur Insel springen" on:click={() => dispatch('focusIsland', { islandId: p.islandId })}>
            <div class="text-stone-200 truncate">{p.name}{p.kind === 'human' ? ' (du)' : ''}{#if p.personality}<span class="text-[10px] text-sky-400/80"> · {p.personality}</span>{/if}</div>
            <div class="text-[11px] text-stone-500">Insel {p.islandId} · 👥 {p.population} · {p.epoch || '—'} · 🏠 {p.buildings}{#if p.army || p.defense} · <span title="Armee / Verteidigung">⚔️{p.army} 🛡️{p.defense}</span>{/if}</div>
            {#if p.strategy}<div class="text-[11px] text-sky-300/80 truncate" title={p.strategy}>🎯 {p.strategy}</div>{/if}
            {#if p.chronicle}<div class="text-[11px] text-stone-400 italic truncate" title={p.chronicle}>„{p.chronicle}"</div>{/if}
          </button>
          {#if p.kind === 'ai'}
            <button class="text-xs text-stone-500 hover:text-red-300" title="KI abschalten" on:click={() => removeAi(p.id)} disabled={busy}>⏻</button>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Ware verschiffen (Stufe 4) -->
    <div class="mt-2.5 pt-2 border-t border-stone-800">
      {#if humanHarbor}
        {@const dests = players.players.filter((p) => p.id !== 0 && p.active && p.harbor)}
        {#if dests.length}
          <div class="text-[11px] text-stone-400 mb-1">📦 Ware verschiffen</div>
          <div class="flex gap-1">
            <select bind:value={sendTo} class="min-w-0 flex-1 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200">
              <option value={null}>Ziel…</option>
              {#each dests as p}<option value={p.islandId}>{p.name}</option>{/each}
            </select>
            <select bind:value={sendRes} class="min-w-0 flex-1 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200">
              <option value="">Ware…</option>
              {#each ownResources.filter((r) => r.amount >= 1 && resourceIndex[r.id]?.category !== 'special') as r}<option value={r.id}>{resourceIndex[r.id]?.icon || ''} {resourceIndex[r.id]?.name?.de || r.id}</option>{/each}
            </select>
            <input type="number" min="1" bind:value={sendAmt} class="w-14 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200" />
            <button class="rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 px-2 text-white" on:click={sendGoods} disabled={busy || !sendTo || !sendRes} title="Verschiffen">➤</button>
          </div>
        {:else}
          <p class="text-[11px] text-stone-500">Kein Nachbar mit ⚓ Hafen — noch kein Ziel zum Verschiffen.</p>
        {/if}
      {:else}
        <p class="text-[11px] text-stone-500">Baue einen ⚓ <b>Hafen</b>, um Waren zu anderen Inseln zu verschiffen.</p>
      {/if}
    </div>

    <!-- Krieg (Stufe 6 v2): tagsüber erklären, Schlacht in der Nacht — kein Erobern, nur Beute -->
    {#if humanArmy > 0}
      {@const targets = players.players.filter((p) => p.id !== 0 && p.active)}
      {#if targets.length}
        <div class="mt-2.5 pt-2 border-t border-stone-800">
          <div class="text-[11px] text-red-300/90 mb-1">⚔️ Raubzug erklären <span class="text-stone-600">({humanArmy} Soldaten · Schlacht in der kommenden Nacht · Sieger plündert Beute)</span></div>
          <div class="flex gap-1">
            <select bind:value={atkTo} class="min-w-0 flex-1 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200">
              <option value={null}>Ziel…</option>
              {#each targets as p}<option value={p.islandId}>{p.name} (🛡️{p.defense})</option>{/each}
            </select>
            <input type="number" min="1" max={humanArmy} bind:value={atkSoldiers} class="w-14 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200" />
            <button class="rounded bg-red-800 hover:bg-red-700 disabled:opacity-40 px-2 text-white" on:click={launchAttack} disabled={busy || !atkTo || !(atkSoldiers > 0)} title="Krieg erklären — Schlacht in der kommenden Nacht">⚔️</button>
          </div>
        </div>
      {/if}
    {/if}

    <!-- Offene Kriegserklärungen (öffentlich — Schlacht in der kommenden Nacht) -->
    {#if players.warDeclarations?.length}
      <div class="mt-2 space-y-0.5">
        {#each players.warDeclarations as d}
          <div class="flex items-center gap-1 text-[11px] {d.defenderId === 0 ? 'text-red-300' : 'text-amber-300/90'}">
            <span>{d.retaliation ? '🔥' : '⚔️'} {d.attacker} → {d.defender} ({d.soldiers} Soldaten, heute Nacht)</span>
            {#if d.attackerId === 0}
              <button class="ml-auto text-stone-500 hover:text-stone-200" title="Zurückziehen" on:click={() => withdrawAttack(d.defenderId)} disabled={busy}>↩️</button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Kriegs-Protokoll -->
    {#if players.warLog?.length}
      <div class="mt-2.5 pt-2 border-t border-stone-800 space-y-0.5">
        <div class="text-[11px] text-stone-400">📜 Kriegs-Protokoll</div>
        {#each players.warLog as w}
          <p class="text-[11px] text-stone-500">{w.report}</p>
        {/each}
      </div>
    {/if}

    {#if (players.players.filter((p) => p.kind === 'ai').length) < (players.maxAi ?? 4)}
      <button class="mt-2.5 w-full rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white" on:click={addAi} disabled={busy || !(players.freeSlots || []).length}>
        ➕ KI-Spieler zuschalten
      </button>
    {:else}
      <p class="mt-2 text-[11px] text-stone-500">Maximal {players.maxAi} KI-Spieler.</p>
    {/if}
    <p class="mt-2 text-[11px] text-stone-500">KI-Inseln entwickeln sich in Echtzeit mit. Klick auf einen Namen springt hin.</p>
    <OnlineSection on:visit />
  {:else}
    <p class="text-xs text-stone-500">Lade…</p>
  {/if}
</div>
