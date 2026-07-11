<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchContent, fetchState, fetchMap, build, setRoad, setDeco, fetchPlayers, enableAi, disableAi, sendShip } from './lib/api.js';
  import { buildChainIndex, computeShortages } from './lib/chains.js';
  import IsoMap from './components/IsoMap.svelte';
  import ResourceBar from './components/ResourceBar.svelte';
  import EpochBanner from './components/EpochBanner.svelte';
  import BuildPalette from './components/BuildPalette.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import Chronicle from './components/Chronicle.svelte';
  import AiAssist from './components/AiAssist.svelte';

  let content = null;
  let state = null;
  let map = null;
  let error = null;
  let flash = null;
  let buildDef = null; // gewähltes Gebäude im Bau-Modus
  let buildRot = 0; // Ausrichtung im Bau-Modus (0-3)
  let selection = null; // ausgewähltes Feld/Gebäude
  let showChronicle = false;
  let showAssist = false;
  let showPlayers = false;
  let players = null; // { islands, players, freeSlots, maxAi }
  let aiBusy = false;

  async function loadPlayers() {
    try { players = await fetchPlayers(); } catch {}
  }
  async function addAi() {
    if (aiBusy) return; aiBusy = true;
    try { const r = await enableAi(); showFlash(`KI-Spieler „${r.player.name}" auf Insel ${r.player.islandId} zugeschaltet`); await loadPlayers(); mapComp?.focusIsland?.(r.player.islandId); }
    catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  async function removeAi(id) {
    aiBusy = true;
    try { await disableAi(id); await loadPlayers(); } catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  // Ware verschiffen
  let sendTo = null, sendRes = '', sendAmt = 50;
  $: humanHarbor = (players?.players || []).find((p) => p.id === 0)?.harbor;
  async function sendGoods() {
    if (!sendTo || !sendRes || !(sendAmt > 0) || aiBusy) return;
    aiBusy = true;
    try { await sendShip(sendTo, sendRes, sendAmt); showFlash(`📦 ${sendAmt}× ${resourceIndex[sendRes]?.name?.de || sendRes} verschifft`); await loadPlayers(); }
    catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  // Rangliste: nach Bevölkerung, dann Gebäudezahl (für den Vergleich im 🌍-Panel)
  $: rankedPlayers = players
    ? [...players.players].sort((a, b) => (b.population - a.population) || (b.buildings - a.buildings))
    : [];
  // Alle Instanzen (Mensch detailliert aus state + KI-Inseln aus /api/players) für die Weltansicht
  $: allInstances = [
    ...((state?.instances) || []),
    ...(((players?.players) || []).filter((p) => p.id !== 0).flatMap((p) => p.instances || [])),
  ];
  let roadMode = false; // Straßen-Malmodus
  let decoType = null; // 'tree' | 'rock' im Deko-Malmodus
  let mapComp;

  let whatsNew = null; // Zusammenfassung neuer KI-Inhalte seit letztem Besuch

  async function loadContent() {
    try {
      content = await fetchContent();
      checkWhatsNew();
    } catch (e) {
      error = e.message;
    }
  }

  function checkWhatsNew() {
    const ai = (content?.packs || []).filter((p) => p.source === 'ai' && p.createdAt);
    if (!ai.length) return;
    const newestT = Math.max(...ai.map((p) => new Date(p.createdAt).getTime()));
    let last = 0;
    try { last = Number(localStorage.getItem('lastSeenPackAt') || 0); } catch {}
    if (!last) { try { localStorage.setItem('lastSeenPackAt', String(newestT)); } catch {} return; }
    if (newestT > last) {
      const since = ai.filter((p) => new Date(p.createdAt).getTime() > last);
      const newest = ai.find((p) => new Date(p.createdAt).getTime() === newestT);
      whatsNew = { count: since.length, chronicle: newest?.chronicle?.de, newestT };
    }
  }
  function dismissWhatsNew() {
    try { localStorage.setItem('lastSeenPackAt', String(whatsNew.newestT)); } catch {}
    whatsNew = null;
  }
  async function loadMap() {
    try {
      map = await fetchMap();
    } catch (e) {
      error = e.message;
    }
  }
  async function pollState() {
    try {
      state = await fetchState();
      error = null;
      // Insel gewachsen? → Karte neu laden (Terrain re-baked automatisch)
      if (map && state.mapVersion != null && state.mapVersion !== (map.version ?? 0)) await loadMap();
    } catch (e) {
      error = e.message;
    }
  }

  function showFlash(msg, ok = true) {
    flash = { msg, ok };
    setTimeout(() => (flash = null), 2600);
  }

  async function onPlace(e) {
    const { buildingId, x, y, rot, ok, reason } = e.detail;
    if (!ok) {
      showFlash('Hier nicht baubar: ' + reason, false);
      return;
    }
    try {
      await build(buildingId, x, y, rot ?? 0);
      await pollState();
      // Bau-Modus für Reihenbau aktiv lassen; abbrechen mit ESC/Rechtsklick
    } catch (err) {
      showFlash(err.message, false);
    }
  }

  function onSelect(e) {
    if (buildDef || roadMode || decoType) return; // in Bau-/Straßen-/Deko-Modus keine Auswahl
    selection = e.detail;
  }

  async function onRoad(e) {
    const { tiles, on } = e.detail;
    try {
      await setRoad(tiles, on);
      await pollState();
    } catch (err) {
      showFlash(err.message, false);
    }
  }

  async function onDeco(e) {
    const { tiles, type, on } = e.detail;
    try {
      await setDeco(tiles, type, on);
      await pollState();
    } catch (err) {
      showFlash(err.message, false);
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      buildDef = null;
      selection = null;
      roadMode = false;
      decoType = null;
    } else if ((e.key === 'r' || e.key === 'R') && buildDef) {
      buildRot = (buildRot + 1) % 4; // Gebäude drehen
    }
  }

  onMount(() => {
    loadContent();
    loadMap();
    pollState();
    loadPlayers();
    const s = setInterval(pollState, 2000);
    const c = setInterval(loadContent, 60000);
    const pl = setInterval(loadPlayers, 3000);
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(s);
      clearInterval(c);
      clearInterval(pl);
      window.removeEventListener('keydown', onKey);
    };
  });

  $: resourceIndex = Object.fromEntries((content?.resources || []).map((r) => [r.id, r]));
  $: defIndex = Object.fromEntries((content?.buildings || []).map((b) => [b.id, b]));
  $: epochIndex = Object.fromEntries((content?.epochs || []).map((e) => [e.id, e.order]));
  $: chainIndex = buildChainIndex(content?.buildings || []);
  $: shortages = state ? computeShortages(state, chainIndex) : new Set();
  $: newPackIds = new Set(
    (content?.packs || [])
      .filter((p) => p.source === 'ai' && p.createdAt && Date.now() - new Date(p.createdAt).getTime() < 36 * 3600 * 1000)
      .map((p) => p.id)
  );
</script>

<svelte:window on:contextmenu|preventDefault={() => { buildDef = null; }} />

<main class="fixed inset-0 bg-stone-950 text-stone-200 overflow-hidden select-none">
  {#if map && content && state}
    <IsoMap
      bind:this={mapComp}
      {map}
      instances={allInstances}
      {defIndex}
      {epochIndex}
      {buildDef}
      {buildRot}
      {shortages}
      {roadMode}
      {decoType}
      ships={players?.ships || []}
      roads={state.roads}
      placed={state.placed}
      cleared={state.cleared}
      selectedInstance={selection?.instance}
      population={state.population}
      on:place={onPlace}
      on:select={onSelect}
      on:road={onRoad}
      on:deco={onDeco}
    />

    <!-- Obere HUD-Leiste (über der Werkzeugleiste, damit die Ressourcen-Tooltips
         nicht von den Buttons überlagert werden) -->
    <div class="absolute top-0 inset-x-0 z-40">
      <ResourceBar {state} {resourceIndex} />
    </div>

    <!-- Epochen-Panel oben, rechts neben der Bau-Seitenleiste -->
    <div class="absolute top-14 left-[19rem] z-20 w-[min(56vw,560px)]">
      <EpochBanner {state} epochs={content.epochs} {resourceIndex} buildings={content.buildings} />
    </div>

    <!-- Werkzeugleiste oben rechts -->
    <div class="absolute top-14 right-3 z-30 flex gap-2">
      <button
        class="border rounded px-3 py-1.5 text-sm {roadMode
          ? 'bg-amber-800 border-amber-500 text-amber-100'
          : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => { roadMode = !roadMode; decoType = null; buildDef = null; selection = null; }}
        title="Straßen bauen — auf Wiese/Sand ziehen"
      >
        🛤️
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {decoType === 'tree'
          ? 'bg-emerald-800 border-emerald-500 text-emerald-100'
          : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => { decoType = decoType === 'tree' ? null : 'tree'; roadMode = false; buildDef = null; selection = null; }}
        title="Bäume pflanzen (Wald-Nachbarschaft) — ziehen setzt, Rechtsklick entfernt/rodet"
      >
        🌲
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {decoType === 'rock'
          ? 'bg-stone-600 border-stone-400 text-stone-100'
          : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => { decoType = decoType === 'rock' ? null : 'rock'; roadMode = false; buildDef = null; selection = null; }}
        title="Felsen setzen (Fels-Nachbarschaft) — ziehen setzt, Rechtsklick entfernt"
      >
        🪨
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {showPlayers ? 'bg-sky-800 border-sky-500 text-sky-100' : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => (showPlayers = !showPlayers)}
        title="Nachbarn — KI-Spieler zuschalten/ansehen"
      >
        🌍
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {showAssist ? 'bg-indigo-800 border-indigo-500 text-indigo-100' : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => (showAssist = !showAssist)}
        title="KI-Berater — Fragen zum Spielstand stellen"
      >
        💬
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {showChronicle ? 'bg-amber-800 border-amber-500 text-amber-100' : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => (showChronicle = !showChronicle)}
        title="KI-Zentrale (Chronik, Läufe, Inhalte)"
      >
        🤖
      </button>
      <button
        class="bg-stone-900/90 border border-stone-700 rounded px-3 py-1.5 text-sm hover:border-stone-500"
        on:click={() => mapComp?.rotateView()}
        title="Ansicht drehen (90°)"
      >
        🔄
      </button>
      <button
        class="bg-stone-900/90 border border-stone-700 rounded px-3 py-1.5 text-sm hover:border-stone-500"
        on:click={() => mapComp?.recenter()}
        title="Zur Siedlung zentrieren"
      >
        🎯
      </button>
    </div>

    <!-- Bau-Modus-Hinweis (unten mittig — der Bereich ist jetzt frei) -->
    {#if buildDef}
      <div class="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-amber-900/90 border border-amber-600 rounded-full px-4 py-1.5 text-sm whitespace-nowrap">
        🏗️ {buildDef.name?.de} platzieren — Klick setzt · <kbd>R</kbd> drehen (↻ {buildRot * 90}°) · <kbd>ESC</kbd>/Rechtsklick beendet
      </div>
    {:else if roadMode}
      <div class="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-amber-900/90 border border-amber-600 rounded-full px-4 py-1.5 text-sm whitespace-nowrap">
        🛤️ Straße/🌉 Brücke: ziehen zeichnet eine <b>gerade Linie</b> (über Wasser = Brücke · links baut · rechts reißt ab) {#if state.logistics?.roadTiles}· {state.logistics.roadTiles} Felder{/if} · <kbd>ESC</kbd> beendet
      </div>
    {:else if decoType}
      <div class="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-amber-900/90 border border-amber-600 rounded-full px-4 py-1.5 text-sm whitespace-nowrap">
        {decoType === 'tree' ? '🌲 Bäume pflanzen' : '🪨 Felsen setzen'} — ziehen setzt (zählt für {decoType === 'tree' ? 'Wald' : 'Fels'}-Nachbarschaft) · <b>rechts</b> ziehen entfernt{decoType === 'tree' ? '/rodet Wald' : ''} · <kbd>ESC</kbd> beendet
      </div>
    {/if}

    <!-- Info-Panel (Auswahl) -->
    {#if !buildDef}
      <InfoPanel
        {selection}
        {defIndex}
        {resourceIndex}
        instances={state.instances}
        {shortages}
        state={state}
        on:close={() => (selection = null)}
        on:changed={(e) => {
          showFlash(e.detail.msg, e.detail.ok ?? true);
          pollState();
        }}
      />
    {/if}

    <!-- KI-Zentrale-Schublade -->
    {#if showChronicle}
      <div class="absolute top-28 right-3 z-30 w-96 max-w-[92vw]">
        <Chronicle
          packs={content.packs}
          on:close={() => (showChronicle = false)}
          on:changed={(e) => {
            showFlash(e.detail.msg, e.detail.ok ?? true);
            loadContent();
            pollState();
          }}
        />
      </div>
    {/if}

    <!-- Nachbarn / KI-Spieler-Panel -->
    {#if showPlayers}
      <div class="absolute top-28 right-3 z-30 w-80 max-w-[92vw] rounded-lg border border-sky-800 bg-stone-900/95 backdrop-blur shadow-xl p-3">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-sm font-semibold text-sky-200">🌍 Nachbarn</span>
          <button class="ml-auto text-stone-500 hover:text-stone-200" on:click={() => (showPlayers = false)}>✕</button>
        </div>
        {#if players}
          <div class="space-y-1.5">
            {#each rankedPlayers as p, i}
              <div class="flex items-center gap-2 rounded border px-2 py-1.5 text-sm {p.kind === 'human' ? 'border-emerald-800/70 bg-emerald-950/30' : 'border-stone-700 bg-stone-800/60'}">
                <span class="text-xs font-mono text-stone-500 w-4 text-right">{i + 1}</span>
                <span>{p.kind === 'human' ? '🧑' : '🤖'}</span>
                <button class="text-left flex-1 min-w-0" title="Zur Insel springen" on:click={() => mapComp?.focusIsland?.(p.islandId)}>
                  <div class="text-stone-200 truncate">{p.name}{p.kind === 'human' ? ' (du)' : ''}{#if p.personality}<span class="text-[10px] text-sky-400/80"> · {p.personality}</span>{/if}</div>
                  <div class="text-[11px] text-stone-500">Insel {p.islandId} · 👥 {p.population} · {p.epoch || '—'} · 🏠 {p.buildings}</div>
                  {#if p.strategy}<div class="text-[11px] text-sky-300/80 truncate" title={p.strategy}>🎯 {p.strategy}</div>{/if}
                  {#if p.chronicle}<div class="text-[11px] text-stone-400 italic truncate" title={p.chronicle}>„{p.chronicle}"</div>{/if}
                </button>
                {#if p.kind === 'ai'}
                  <button class="text-xs text-stone-500 hover:text-red-300" title="KI abschalten" on:click={() => removeAi(p.id)} disabled={aiBusy}>⏻</button>
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
                    {#each (state?.resources || []).filter((r) => r.amount >= 1) as r}<option value={r.id}>{resourceIndex[r.id]?.icon || ''} {resourceIndex[r.id]?.name?.de || r.id}</option>{/each}
                  </select>
                  <input type="number" min="1" bind:value={sendAmt} class="w-14 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200" />
                  <button class="rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 px-2 text-white" on:click={sendGoods} disabled={aiBusy || !sendTo || !sendRes} title="Verschiffen">➤</button>
                </div>
              {:else}
                <p class="text-[11px] text-stone-500">Kein Nachbar mit ⚓ Hafen — noch kein Ziel zum Verschiffen.</p>
              {/if}
            {:else}
              <p class="text-[11px] text-stone-500">Baue einen ⚓ <b>Hafen</b>, um Waren zu anderen Inseln zu verschiffen.</p>
            {/if}
          </div>

          {#if (players.players.filter((p) => p.kind === 'ai').length) < (players.maxAi ?? 4)}
            <button class="mt-2.5 w-full rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white" on:click={addAi} disabled={aiBusy || !(players.freeSlots || []).length}>
              ➕ KI-Spieler zuschalten
            </button>
          {:else}
            <p class="mt-2 text-[11px] text-stone-500">Maximal {players.maxAi} KI-Spieler.</p>
          {/if}
          <p class="mt-2 text-[11px] text-stone-500">KI-Inseln entwickeln sich in Echtzeit mit. Klick auf einen Namen springt hin.</p>
        {:else}
          <p class="text-xs text-stone-500">Lade…</p>
        {/if}
      </div>
    {/if}

    <!-- KI-Berater-Panel -->
    {#if showAssist}
      <div class="absolute top-28 right-3 z-30 w-96 max-w-[92vw]">
        <AiAssist on:close={() => (showAssist = false)} />
      </div>
    {/if}

    <!-- „Neu über Nacht"-Zusammenfassung -->
    {#if whatsNew}
      <div class="absolute top-28 left-1/2 -translate-x-1/2 z-40 w-[min(92vw,460px)] bg-indigo-950/95 backdrop-blur border border-indigo-700 rounded-lg shadow-2xl p-4">
        <div class="flex items-start gap-2">
          <span class="text-2xl">🌙</span>
          <div class="flex-1">
            <h3 class="text-sm font-semibold text-indigo-100">Über Nacht erweitert</h3>
            <p class="text-xs text-indigo-300/90 mt-0.5">Die KI hat {whatsNew.count} {whatsNew.count === 1 ? 'neues Inhaltspaket' : 'neue Inhaltspakete'} hinzugefügt.</p>
            {#if whatsNew.chronicle}<p class="text-xs text-stone-300 mt-2 leading-relaxed italic">„{whatsNew.chronicle}"</p>{/if}
            <div class="flex gap-2 mt-3">
              <button class="text-xs bg-indigo-700 hover:bg-indigo-600 rounded px-3 py-1.5 text-white" on:click={() => { showChronicle = true; dismissWhatsNew(); }}>Ansehen</button>
              <button class="text-xs bg-stone-800 hover:bg-stone-700 rounded px-3 py-1.5 text-stone-200" on:click={dismissWhatsNew}>OK</button>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Bau-Palette unten -->
    <BuildPalette
      buildings={content.buildings}
      {state}
      {resourceIndex}
      activeId={buildDef?.id}
      {newPackIds}
      on:pick={(e) => {
        buildDef = e.detail.def;
        selection = null;
        roadMode = false;
        decoType = null;
        buildRot = 0;
      }}
    />
  {:else}
    <div class="absolute inset-0 grid place-items-center">
      <p class="text-stone-500 animate-pulse">Lade Siedlung…</p>
    </div>
  {/if}

  {#if error}
    <div class="absolute bottom-40 left-1/2 -translate-x-1/2 z-40 bg-red-900/80 border border-red-700 rounded px-4 py-2 text-sm">
      ⚠️ {error}
    </div>
  {/if}
  {#if flash}
    <div
      class="absolute top-24 left-1/2 -translate-x-1/2 z-50 rounded px-4 py-2 text-sm shadow-lg {flash.ok
        ? 'bg-emerald-800'
        : 'bg-red-800'}"
    >
      {flash.msg}
    </div>
  {/if}
</main>
