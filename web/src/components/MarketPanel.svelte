<script>
  // Handelsmarkt (Stufe 5) + Online-Handel (Multiplayer M3).
  // Aus App.svelte herausgelöst: Panel, Formularzustand und die zugehörigen
  // API-Aufrufe gehören zusammen — in App.svelte waren sie über 60 Zeilen
  // Skript und 110 Zeilen Markup verteilt.
  import { createEventDispatcher } from 'svelte';
  import {
    createOffer, acceptOffer, cancelOffer,
    onlineTradeOffer, onlineTradeAccept, onlineTradeCancel,
  } from '../lib/api.js';
  import { sfxCoin } from '../lib/sound.js';
  import { isMobile } from '../lib/device.js';

  export let market = null;
  export let oTrade = null;
  export let resourceIndex = {};
  export let ownResources = []; // state.resources
  export let allResources = []; // content.resources
  export let topBarH = 0;

  const dispatch = createEventDispatcher();

  let busy = false;
  let offGive = '', offGiveAmt = 50, offWant = '', offWantAmt = 50;

  // ⚖ Fairness aus Sicht des Annehmers: Wert(bekomme) / Wert(zahle) nach baseValue
  function fairness(o) {
    const gv = resourceIndex[o.give.resourceId]?.baseValue, wv = resourceIndex[o.want.resourceId]?.baseValue;
    if (!gv || !wv) return null;
    const ratio = (gv * o.give.amount) / (wv * o.want.amount);
    return ratio >= 1.15 ? { icon: '🟢', label: 'günstig' } : ratio <= 0.85 ? { icon: '🔴', label: 'teuer' } : { icon: '⚖️', label: 'fair' };
  }

  /** Kapselt das gemeinsame Muster: sperren → aufrufen → melden → neu laden. */
  async function act(fn, okMsg, sound = false) {
    if (busy) return;
    busy = true;
    try {
      const r = await fn();
      if (r && r.ok === false) throw new Error(r.error);
      if (sound) sfxCoin();
      if (okMsg) dispatch('changed', { msg: okMsg, ok: true });
      else dispatch('changed', {});
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    busy = false;
  }

  const canSubmit = () => offGive && offWant && offGive !== offWant;
  const submitOffer = () => canSubmit() && act(() => createOffer(offGive, offGiveAmt, offWant, offWantAmt), 'Angebot eingestellt', true);
  const submitOnlineOffer = () => canSubmit() && act(() => onlineTradeOffer(offGive, offGiveAmt, offWant, offWantAmt), '🌐 Online-Angebot eingestellt — wird veröffentlicht');
  const takeOffer = (id) => act(() => acceptOffer(id), '📦 Angenommen — Schiffe unterwegs', true);
  const dropOffer = (id) => act(() => cancelOffer(id), null);
  const takeOnlineOffer = (owner, id) => act(() => onlineTradeAccept(owner, id), '🌐 Angenommen — die Gegenseite bucht beim nächsten Sync');
  const dropOnlineOffer = (id) => act(() => onlineTradeCancel(id), 'Online-Angebot zurückgezogen');
</script>

<div
  class={$isMobile ? 'mobile-sheet p-3' : 'absolute right-3 z-30 w-80 max-w-[92vw] rounded-lg border border-amber-800 bg-stone-900/95 backdrop-blur shadow-xl p-3 overflow-y-auto'}
  style={$isMobile ? '' : `top: ${topBarH + 52}px; max-height: calc(100vh - ${topBarH + 64}px)`}
>
  <div class="flex items-center gap-2 mb-2">
    <span class="text-sm font-semibold text-amber-200">🪙 Handelsmarkt</span>
    <button class="ml-auto text-stone-500 hover:text-stone-200" on:click={() => dispatch('close')}>✕</button>
  </div>
  {#if market}
    {#if !market.hasHarbor}
      <p class="text-[11px] text-stone-500 mb-2">Baue einen ⚓ <b>Hafen</b>, um zu handeln.</p>
    {/if}
    {#if market.offers.length}
      <div class="space-y-1.5">
        {#each market.offers as o}
          {@const g = resourceIndex[o.give.resourceId]}
          {@const w = resourceIndex[o.want.resourceId]}
          <div class="rounded border border-stone-700 bg-stone-800/60 px-2 py-1.5 text-sm">
            <div class="flex items-center gap-1 flex-wrap">
              <span class="text-emerald-300">{g?.icon || ''} {o.give.amount} {g?.name?.de || o.give.resourceId}</span>
              <span class="text-stone-500">→</span>
              <span class="text-amber-300">{w?.icon || ''} {o.want.amount} {w?.name?.de || o.want.resourceId}</span>
            </div>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-[11px] text-stone-500">von {o.ownerName}</span>
              {#if o.mine}
                <button class="ml-auto text-[11px] text-stone-400 hover:text-red-300" on:click={() => dropOffer(o.id)} disabled={busy}>zurücknehmen</button>
              {:else}
                <button class="ml-auto text-[11px] rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 px-2 py-0.5 text-white" on:click={() => takeOffer(o.id)} disabled={busy || !market.hasHarbor}>annehmen</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="text-[11px] text-stone-500">Noch keine Angebote am Markt.</p>
    {/if}
    {#if market.hasHarbor}
      <div class="mt-2.5 pt-2 border-t border-stone-800">
        <div class="text-[11px] text-stone-400 mb-1">Angebot einstellen (gebe → nehme)</div>
        <div class="flex items-center gap-1">
          <input type="number" min="1" bind:value={offGiveAmt} class="w-12 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200" />
          <select bind:value={offGive} class="min-w-0 flex-1 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200">
            <option value="">gebe…</option>
            {#each ownResources.filter((r) => r.amount >= 1 && resourceIndex[r.id]?.category !== 'special') as r}<option value={r.id}>{resourceIndex[r.id]?.icon || ''} {resourceIndex[r.id]?.name?.de || r.id}</option>{/each}
          </select>
        </div>
        <div class="flex items-center gap-1 mt-1">
          <input type="number" min="1" bind:value={offWantAmt} class="w-12 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200" />
          <select bind:value={offWant} class="min-w-0 flex-1 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200">
            <option value="">nehme…</option>
            {#each allResources.filter((r) => r.category !== 'special') as r}<option value={r.id}>{r.icon || ''} {r.name?.de || r.id}</option>{/each}
          </select>
          <button class="rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 px-2 text-white text-sm" on:click={submitOffer} disabled={busy || !offGive || !offWant}>+</button>
          {#if oTrade?.connected}
            <button class="rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 px-2 text-white text-sm" on:click={submitOnlineOffer} disabled={busy || !offGive || !offWant} title="Als ONLINE-Angebot für andere Spieler veröffentlichen">🌐</button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Online-Handel (Multiplayer M3) -->
    {#if oTrade && (oTrade.marketOffers.length || oTrade.offers.length || oTrade.accepts.length)}
      <div class="mt-2.5 pt-2 border-t border-stone-800">
        <div class="text-[11px] text-sky-300 mb-1">🌐 Online-Angebote <span class="text-stone-600">(Abwicklung beim nächsten Sync)</span></div>
        {#each oTrade.marketOffers as o (o.owner + o.id)}
          {@const g = resourceIndex[o.give.resourceId]}
          {@const w = resourceIndex[o.want.resourceId]}
          {@const fair = fairness(o)}
          <div class="rounded border border-sky-900/70 bg-stone-800/60 px-2 py-1.5 text-sm mb-1.5">
            <div class="flex items-center gap-1 flex-wrap">
              <span class="text-emerald-300">{g?.icon || '❓'} {o.give.amount} {g?.name?.de || o.give.resourceId}</span>
              <span class="text-stone-500">→</span>
              <span class="text-amber-300">{w?.icon || '❓'} {o.want.amount} {w?.name?.de || o.want.resourceId}</span>
              {#if fair}<span class="text-[10px] text-stone-400 ml-1" title="Einschätzung nach Warenwert (baseValue)">{fair.icon} {fair.label}</span>{/if}
            </div>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-[11px] text-stone-500">von 🌐 {o.owner}</span>
              {#if o.accepted}
                <span class="ml-auto text-[11px] text-sky-400">⏳ angenommen — wartet auf Gegenseite</span>
              {:else if !o.giveKnown}
                <span class="ml-auto text-[11px] text-stone-500" title="Erst die Inhalte dieses Nachbarn übernehmen (✨ beim Besuchen)">❓ unbekannte Ware</span>
              {:else}
                <button class="ml-auto text-[11px] rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 px-2 py-0.5 text-white" on:click={() => takeOnlineOffer(o.owner, o.id)} disabled={busy || !oTrade.connected}>annehmen</button>
              {/if}
            </div>
          </div>
        {/each}
        {#each oTrade.offers as o (o.id)}
          {@const g = resourceIndex[o.give.resourceId]}
          {@const w = resourceIndex[o.want.resourceId]}
          <div class="rounded border border-stone-700 bg-stone-800/40 px-2 py-1.5 text-sm mb-1.5">
            <div class="flex items-center gap-1 flex-wrap">
              <span class="text-emerald-300">{g?.icon || ''} {o.give.amount} {g?.name?.de || o.give.resourceId}</span>
              <span class="text-stone-500">→</span>
              <span class="text-amber-300">{w?.icon || ''} {o.want.amount} {w?.name?.de || o.want.resourceId}</span>
              <span class="text-[10px] text-stone-500 ml-1">dein 🌐-Angebot</span>
              <button class="ml-auto text-[11px] text-stone-400 hover:text-red-300" on:click={() => dropOnlineOffer(o.id)} disabled={busy}>zurückziehen</button>
            </div>
          </div>
        {/each}
        {#each oTrade.accepts as a (a.offerId)}
          <p class="text-[11px] text-stone-500 mb-1">⏳ {a.want.amount} {resourceIndex[a.want.resourceId]?.name?.de || a.want.resourceId} an 🌐 {a.offerOwner} gezahlt — Ware kommt mit dem nächsten Sync beider Seiten.</p>
        {/each}
      </div>
    {/if}
  {:else}
    <p class="text-xs text-stone-500">Lade…</p>
  {/if}
</div>
