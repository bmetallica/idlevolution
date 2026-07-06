<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchContent, fetchState, fetchMap, build, setRoad } from './lib/api.js';
  import { buildChainIndex, computeShortages } from './lib/chains.js';
  import IsoMap from './components/IsoMap.svelte';
  import ResourceBar from './components/ResourceBar.svelte';
  import EpochBanner from './components/EpochBanner.svelte';
  import BuildPalette from './components/BuildPalette.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import Chronicle from './components/Chronicle.svelte';

  let content = null;
  let state = null;
  let map = null;
  let error = null;
  let flash = null;
  let buildDef = null; // gewähltes Gebäude im Bau-Modus
  let buildRot = 0; // Ausrichtung im Bau-Modus (0-3)
  let selection = null; // ausgewähltes Feld/Gebäude
  let showChronicle = false;
  let roadMode = false; // Straßen-Malmodus
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
    if (buildDef || roadMode) return; // im Bau-/Straßenmodus keine Auswahl
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

  function onKey(e) {
    if (e.key === 'Escape') {
      buildDef = null;
      selection = null;
      roadMode = false;
    } else if ((e.key === 'r' || e.key === 'R') && buildDef) {
      buildRot = (buildRot + 1) % 4; // Gebäude drehen
    }
  }

  onMount(() => {
    loadContent();
    loadMap();
    pollState();
    const s = setInterval(pollState, 2000);
    const c = setInterval(loadContent, 60000);
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(s);
      clearInterval(c);
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
      instances={state.instances}
      {defIndex}
      {epochIndex}
      {buildDef}
      {buildRot}
      {shortages}
      {roadMode}
      roads={state.roads}
      selectedInstance={selection?.instance}
      population={state.population}
      on:place={onPlace}
      on:select={onSelect}
      on:road={onRoad}
    />

    <!-- Obere HUD-Leiste -->
    <div class="absolute top-0 inset-x-0 z-30">
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
        on:click={() => { roadMode = !roadMode; buildDef = null; selection = null; }}
        title="Straßen bauen — auf Wiese/Sand ziehen"
      >
        🛤️
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
        🛤️ Straße: ziehen zeichnet eine <b>gerade Linie</b> (links baut · rechts reißt ab) {#if state.logistics?.roadTiles}· {state.logistics.roadTiles} Felder, +{Math.round((state.logistics.bonus || 0) * 100)}%{/if} · <kbd>ESC</kbd> beendet
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
