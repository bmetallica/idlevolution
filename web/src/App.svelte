<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { fetchContent, fetchState, fetchMap, build, setRoad, setDeco, fetchPlayers, enableAi, disableAi, sendShip, attack, cancelAttack, fetchMarket, createOffer, acceptOffer, cancelOffer, onlineIsland, onlineAdopt, onlineTrade, onlineTradeOffer, onlineTradeCancel, onlineTradeAccept } from './lib/api.js';
  import { buildChainIndex, computeShortages, computeBottlenecks } from './lib/chains.js';
  import IsoMap from './components/IsoMap.svelte';
  import ResourceBar from './components/ResourceBar.svelte';
  import EpochBanner from './components/EpochBanner.svelte';
  import BuildPalette from './components/BuildPalette.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import Chronicle from './components/Chronicle.svelte';
  import AiAssist from './components/AiAssist.svelte';
  import OnlineSection from './components/OnlineSection.svelte';
  import { isMobile, portrait } from './lib/device.js';

  let topBarH = 48; // gemessene Höhe der Materialleiste → alles darunter weicht dynamisch aus
  let mobileMenu = false; // ausgeklapptes Menü-FAB (nur Mobile)
  let eraseMode = false; // Radier-Umschalter für Straßen/Deko (statt Rechtsklick, nur Mobile)
  let showBuild = false; // Bau-Dock ein-/ausklappen (nur Mobile)

  // Online-Nachbarn besuchen (M2): fremde Insel read-only in der IsoMap ansehen.
  // Eigene Simulation läuft serverseitig ungestört weiter.
  let visiting = null; // { owner, island, map, instances, defIndex, epochIndex, roads }
  async function visitOnline(owner) {
    try {
      const r = await onlineIsland(owner);
      if (!r.ok) throw new Error(r.error || 'Insel nicht gefunden');
      const defIdx = { ...defIndex };
      for (const b of r.packs?.buildings || []) defIdx[b.id] = b;
      const epIdx = { ...epochIndex };
      for (const e of r.packs?.epochs || []) epIdx[e.id] = e.order;
      visiting = {
        owner,
        island: r.island,
        map: { ...r.island.map, legend: map.legend, version: `online-${owner}-${r.island.exportedAt}` },
        instances: r.island.instances.map((i, idx) => ({ id: `online-${idx}`, ...i, done: true, _owner: owner })),
        defIndex: defIdx,
        epochIndex: epIdx,
        roads: r.island.roads || [],
        adoptable: (r.packs?.buildings?.length || 0) + (r.packs?.resources?.length || 0),
      };
      buildDef = null; roadMode = false; decoType = null; selection = null;
      showPlayers = showMarket = showChronicle = showAssist = false;
      await tick();
      mapComp?.recenter();
    } catch (e) { showFlash(e.message, false); }
  }
  async function leaveVisit() {
    visiting = null; selection = null;
    await tick();
    mapComp?.recenter();
  }
  // M4: LLM-generierte Inhalte des besuchten Nachbarn ins eigene Spiel übernehmen
  async function adoptVisiting() {
    if (!visiting || aiBusy) return; aiBusy = true;
    try {
      const r = await onlineAdopt(visiting.owner);
      if (!r.ok) throw new Error(r.error);
      showFlash(`✨ ${r.buildings} Gebäude & ${r.resources} Ressourcen von ${visiting.owner} übernommen (Pack „${r.packId}" — in der 🤖-Zentrale deaktivierbar)`);
      await loadContent();
      await pollState();
    } catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }

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
  // Handelsmarkt (Stufe 5) + Online-Handel (Multiplayer M3)
  let showMarket = false;
  let market = null;
  let oTrade = null; // /api/online/trade: eigene Angebote/Accepts + fremde Angebote
  let offGive = '', offGiveAmt = 50, offWant = '', offWantAmt = 50;
  async function loadMarket() {
    try { market = await fetchMarket(); } catch {}
    try { oTrade = await onlineTrade(); } catch {}
  }
  // ⚖ Fairness aus Sicht des Annehmers: Wert(bekomme) / Wert(zahle) nach baseValue
  function fairness(o) {
    const gv = resourceIndex[o.give.resourceId]?.baseValue, wv = resourceIndex[o.want.resourceId]?.baseValue;
    if (!gv || !wv) return null;
    const ratio = (gv * o.give.amount) / (wv * o.want.amount);
    return ratio >= 1.15 ? { icon: '🟢', label: 'günstig' } : ratio <= 0.85 ? { icon: '🔴', label: 'teuer' } : { icon: '⚖️', label: 'fair' };
  }
  async function submitOnlineOffer() {
    if (!offGive || !offWant || offGive === offWant || aiBusy) return;
    aiBusy = true;
    try { const r = await onlineTradeOffer(offGive, offGiveAmt, offWant, offWantAmt); if (!r.ok) throw new Error(r.error); showFlash('🌐 Online-Angebot eingestellt — wird veröffentlicht'); await loadMarket(); await pollState(); }
    catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  async function takeOnlineOffer(owner, id) {
    aiBusy = true;
    try { const r = await onlineTradeAccept(owner, id); if (!r.ok) throw new Error(r.error); showFlash('🌐 Angenommen — die Gegenseite bucht beim nächsten Sync'); await loadMarket(); await pollState(); }
    catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  async function dropOnlineOffer(id) {
    aiBusy = true;
    try { const r = await onlineTradeCancel(id); if (!r.ok) throw new Error(r.error); showFlash('Online-Angebot zurückgezogen'); await loadMarket(); await pollState(); }
    catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  async function submitOffer() {
    if (!offGive || !offWant || offGive === offWant || aiBusy) return;
    aiBusy = true;
    try { await createOffer(offGive, offGiveAmt, offWant, offWantAmt); showFlash('Angebot eingestellt'); await loadMarket(); await pollState(); }
    catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  async function takeOffer(id) {
    aiBusy = true;
    try { await acceptOffer(id); showFlash('📦 Angenommen — Schiffe unterwegs'); await loadMarket(); await pollState(); }
    catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  async function dropOffer(id) {
    aiBusy = true;
    try { await cancelOffer(id); await loadMarket(); await pollState(); } catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  // Ware verschiffen
  let sendTo = null, sendRes = '', sendAmt = 50;
  $: humanHarbor = (players?.players || []).find((p) => p.id === 0)?.harbor;
  // Krieg (Stufe 6 v2): tagsüber erklären, die Schlacht schlägt sich nachts
  let atkTo = null, atkSoldiers = 10;
  $: humanArmy = (players?.players || []).find((p) => p.id === 0)?.army ?? 0;
  async function launchAttack() {
    if (!atkTo || !(atkSoldiers > 0) || aiBusy) return;
    aiBusy = true;
    try {
      const r = await attack(atkTo, atkSoldiers);
      if (!r.ok) throw new Error(r.error);
      showFlash(`⚔️ Krieg erklärt — ${r.soldiers} Soldaten schlagen in der kommenden Nacht zu`);
      await loadPlayers(); await pollState();
    } catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
  async function withdrawAttack(defenderId) {
    if (aiBusy) return; aiBusy = true;
    try {
      const r = await cancelAttack(defenderId);
      if (!r.ok) throw new Error(r.error);
      showFlash(`↩️ Kriegserklärung zurückgezogen — ${r.soldiers} Soldaten kehren zurück`);
      await loadPlayers(); await pollState();
    } catch (e) { showFlash(e.message, false); }
    aiBusy = false;
  }
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
  // Fremde (KI-)Instanzen werden mit Besitzer markiert → InfoPanel zeigt sie nur an,
  // ohne Steuerung (Arbeiter/Drehen/Abriss wirken nur auf die eigene Insel).
  $: allInstances = [
    ...((state?.instances) || []),
    ...(((players?.players) || []).filter((p) => p.id !== 0).flatMap((p) => (p.instances || []).map((i) => ({ ...i, _owner: p.name })))),
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
    loadMarket();
    // Polling pausiert im Hintergrund-Tab (Akku/PWA) — beim Zurückkehren sofort auffrischen.
    const visible = () => !document.hidden;
    const s = setInterval(() => { if (visible()) pollState(); }, 2000);
    const c = setInterval(() => { if (visible()) loadContent(); }, 60000);
    // Markt nur pollen, wenn das Panel offen ist (players braucht die Karte für Schiffe immer)
    const pl = setInterval(() => { if (visible()) { loadPlayers(); if (showMarket) loadMarket(); } }, 3000);
    const onVis = () => { if (visible()) { pollState(); loadPlayers(); if (showMarket) loadMarket(); } };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(s);
      clearInterval(c);
      clearInterval(pl);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('keydown', onKey);
    };
  });

  $: resourceIndex = Object.fromEntries((content?.resources || []).map((r) => [r.id, r]));
  $: defIndex = Object.fromEntries((content?.buildings || []).map((b) => [b.id, b]));
  $: epochIndex = Object.fromEntries((content?.epochs || []).map((e) => [e.id, e.order]));
  $: chainIndex = buildChainIndex(content?.buildings || []);
  $: shortages = state ? computeShortages(state, chainIndex) : new Set();
  $: bottlenecks = state ? computeBottlenecks(state, chainIndex) : new Set();
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
      map={visiting ? visiting.map : map}
      instances={visiting ? visiting.instances : allInstances}
      defIndex={visiting ? visiting.defIndex : defIndex}
      epochIndex={visiting ? visiting.epochIndex : epochIndex}
      buildDef={visiting ? null : buildDef}
      {buildRot}
      shortages={visiting ? new Set() : shortages}
      roadMode={visiting ? false : roadMode}
      decoType={visiting ? null : decoType}
      reticle={$isMobile}
      erase={eraseMode}
      ships={visiting ? [] : players?.ships || []}
      shipTick={players?.tick ?? 0}
      tickSeconds={players?.tickSeconds ?? state.tickSeconds ?? 5}
      roads={visiting ? visiting.roads : state.roads}
      placed={visiting ? {} : state.placed}
      cleared={visiting ? [] : state.cleared}
      selectedInstance={selection?.instance}
      population={visiting ? visiting.island.population : state.population}
      on:place={onPlace}
      on:select={onSelect}
      on:road={onRoad}
      on:deco={onDeco}
    />

    <!-- Besuchen-Modus: fremde Insel read-only, eigenes HUD ausgeblendet -->
    {#if visiting}
      <div class="absolute top-0 inset-x-0 z-40 safe-top">
        <div class="mx-auto max-w-xl m-2 flex items-center gap-2 rounded-lg border border-sky-700 bg-stone-900/95 backdrop-blur px-3 py-2 shadow-xl">
          <span>🌐</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-stone-100 truncate">{visiting.island.name}</div>
            <div class="text-[11px] text-stone-500">von {visiting.owner} · 👥 {Math.floor(visiting.island.population)} · Stand {visiting.island.exportedAt ? new Date(visiting.island.exportedAt).toLocaleDateString('de-DE') : '—'}</div>
          </div>
          {#if visiting.adoptable}
            <button class="rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white" on:click={adoptVisiting} disabled={aiBusy} title="LLM-generierte Gebäude & Ressourcen dieses Nachbarn ins eigene Spiel übernehmen">
              ✨ Übernehmen
            </button>
          {/if}
          <button class="rounded bg-sky-700 hover:bg-sky-600 px-3 py-1.5 text-sm text-white" on:click={leaveVisit}>⬅ Zurück</button>
        </div>
      </div>
    {/if}

    {#if !visiting}
    <!-- Obere HUD-Leiste (über der Werkzeugleiste, damit die Ressourcen-Tooltips
         nicht von den Buttons überlagert werden) -->
    <!-- Mobile: Leiste zwischen 🏗️ (links) und ☰ (rechts) einpassen statt darunter -->
    <div class="absolute top-0 z-40 safe-top {$isMobile ? 'left-[52px] right-[52px]' : 'inset-x-0'}" bind:clientHeight={topBarH}>
      <ResourceBar {state} {resourceIndex} compact={$isMobile} />
    </div>

    <!-- Epochen-Panel oben, rechts neben der Bau-Seitenleiste (Desktop) -->
    {#if !$isMobile}
      <div class="absolute left-[19rem] z-20 w-[min(56vw,560px)]" style="top: {topBarH + 8}px">
        <EpochBanner {state} epochs={content.epochs} {resourceIndex} buildings={content.buildings} />
      </div>
    {/if}

    <!-- Werkzeugleiste oben rechts (Desktop) — weicht der Materialleiste dynamisch aus -->
    {#if !$isMobile}
    <div class="absolute right-3 z-30 flex gap-2" style="top: {topBarH + 8}px">
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
        class="border rounded px-3 py-1.5 text-sm {showMarket ? 'bg-amber-800 border-amber-500 text-amber-100' : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => (showMarket = !showMarket)}
        title="Handelsmarkt"
      >
        🪙
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
    {/if}

    <!-- ══ Mobile-HUD ══ -->
    {#if $isMobile}
      <!-- Bau-Dock-Umschalter oben links -->
      <div class="absolute top-2 left-2 z-40 safe-top">
        <button class="mobile-fab {showBuild ? 'active' : ''}" on:click={() => { showBuild = !showBuild; if (showBuild) { roadMode = false; decoType = null; } }} title="Bauen">🏗️</button>
      </div>

      <!-- Menü-FAB oben rechts (Panels) -->
      <div class="absolute top-2 right-2 z-40 flex flex-col items-end gap-2 safe-top">
        <button class="mobile-fab {mobileMenu ? 'active' : ''}" on:click={() => (mobileMenu = !mobileMenu)} title="Menü">☰</button>
        {#if mobileMenu}
          <button class="mobile-fab {showPlayers ? 'active' : ''}" on:click={() => { showPlayers = !showPlayers; showMarket = showAssist = showChronicle = false; }} title="Nachbarn">🌍</button>
          <button class="mobile-fab {showMarket ? 'active' : ''}" on:click={() => { showMarket = !showMarket; showPlayers = showAssist = showChronicle = false; }} title="Markt">🪙</button>
          <button class="mobile-fab {showAssist ? 'active' : ''}" on:click={() => { showAssist = !showAssist; showPlayers = showMarket = showChronicle = false; }} title="Berater">💬</button>
          <button class="mobile-fab {showChronicle ? 'active' : ''}" on:click={() => { showChronicle = !showChronicle; showPlayers = showMarket = showAssist = false; }} title="KI-Zentrale">🤖</button>
        {/if}
      </div>

      {#if !showBuild && !buildDef}
        <!-- Karten-Steuerung rechts -->
        <div class="absolute right-2 bottom-4 z-40 flex flex-col gap-2">
          <button class="mobile-fab" on:click={() => mapComp?.rotateView()} title="Ansicht drehen">🔄</button>
          <button class="mobile-fab" on:click={() => mapComp?.recenter()} title="Zentrieren">🎯</button>
        </div>

        <!-- Bau-Werkzeuge links -->
        <div class="absolute left-2 bottom-4 z-40 flex flex-col gap-2">
          <button class="mobile-fab {roadMode ? 'active' : ''}" on:click={() => { roadMode = !roadMode; decoType = null; buildDef = null; selection = null; eraseMode = false; }} title="Straßen">🛤️</button>
          <button class="mobile-fab {decoType === 'tree' ? 'active' : ''}" on:click={() => { decoType = decoType === 'tree' ? null : 'tree'; roadMode = false; buildDef = null; selection = null; eraseMode = false; }} title="Bäume">🌲</button>
          <button class="mobile-fab {decoType === 'rock' ? 'active' : ''}" on:click={() => { decoType = decoType === 'rock' ? null : 'rock'; roadMode = false; buildDef = null; selection = null; eraseMode = false; }} title="Felsen">🪨</button>
          {#if roadMode || decoType}
            <button class="mobile-fab {eraseMode ? 'active' : ''}" on:click={() => (eraseMode = !eraseMode)} title="Radieren an/aus">🧹</button>
          {/if}
        </div>
      {/if}

      <!-- Dreh-Hinweis im Hochformat -->
      {#if $portrait}
        <div class="fixed inset-0 z-[100] bg-stone-950 grid place-items-center text-center p-8">
          <div>
            <div class="text-6xl mb-4 animate-pulse">📱 ↻</div>
            <p class="text-lg text-stone-200 font-semibold">Bitte drehen</p>
            <p class="text-sm text-stone-400 mt-1">Idlevolution spielt sich im <b>Querformat</b>.</p>
          </div>
        </div>
      {/if}
    {/if}

    <!-- Bau-Modus-Hinweis (unten mittig — Desktop) -->
    {#if $isMobile}
      <!-- Mobile: Fadenkreuz + Bau-Bestätigung -->
      {#if buildDef}
        <!-- Fadenkreuz bei 40 % Höhe (deckungsgleich mit dem Bau-Geist in IsoMap) -->
        <div class="absolute inset-x-0 z-20 pointer-events-none flex justify-center" style="top: 40%; transform: translateY(-50%);">
          <div class="text-4xl text-white/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">✛</div>
        </div>
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3">
          <button class="mobile-fab" on:click={() => (buildRot = (buildRot + 1) % 4)} title="Drehen">↻</button>
          <button class="mobile-fab active" style="width:56px;height:56px;font-size:1.5rem" on:click={() => mapComp?.placeAtCenter()} title="Bauen">✓</button>
          <button class="mobile-fab" on:click={() => (buildDef = null)} title="Abbrechen">✕</button>
        </div>
      {/if}
    {:else if buildDef}
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

    {/if}

    <!-- Info-Panel (Auswahl) — auch beim Besuchen (zeigt fremde Gebäude read-only) -->
    {#if !buildDef}
      <InfoPanel
        mobile={$isMobile}
        topOffset={topBarH + 8}
        {selection}
        defIndex={visiting ? visiting.defIndex : defIndex}
        {resourceIndex}
        instances={visiting ? visiting.instances : state.instances}
        {shortages}
        {bottlenecks}
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
      <div class={$isMobile ? 'mobile-sheet p-2' : 'absolute right-3 z-30 w-96 max-w-[92vw]'} style={$isMobile ? '' : `top: ${topBarH + 52}px`}>
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

    <!-- Handelsmarkt-Panel (Stufe 5) -->
    {#if showMarket}
      <div class={$isMobile ? 'mobile-sheet p-3' : 'absolute right-3 z-30 w-80 max-w-[92vw] rounded-lg border border-amber-800 bg-stone-900/95 backdrop-blur shadow-xl p-3 overflow-y-auto'} style={$isMobile ? '' : `top: ${topBarH + 52}px; max-height: calc(100vh - ${topBarH + 64}px)`}>
        <div class="flex items-center gap-2 mb-2">
          <span class="text-sm font-semibold text-amber-200">🪙 Handelsmarkt</span>
          <button class="ml-auto text-stone-500 hover:text-stone-200" on:click={() => (showMarket = false)}>✕</button>
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
                      <button class="ml-auto text-[11px] text-stone-400 hover:text-red-300" on:click={() => dropOffer(o.id)} disabled={aiBusy}>zurücknehmen</button>
                    {:else}
                      <button class="ml-auto text-[11px] rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 px-2 py-0.5 text-white" on:click={() => takeOffer(o.id)} disabled={aiBusy || !market.hasHarbor}>annehmen</button>
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
                  {#each (state?.resources || []).filter((r) => r.amount >= 1 && resourceIndex[r.id]?.category !== 'special') as r}<option value={r.id}>{resourceIndex[r.id]?.icon || ''} {resourceIndex[r.id]?.name?.de || r.id}</option>{/each}
                </select>
              </div>
              <div class="flex items-center gap-1 mt-1">
                <input type="number" min="1" bind:value={offWantAmt} class="w-12 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200" />
                <select bind:value={offWant} class="min-w-0 flex-1 bg-stone-950 border border-stone-700 rounded px-1 py-1 text-xs text-stone-200">
                  <option value="">nehme…</option>
                  {#each (content?.resources || []).filter((r) => r.category !== 'special') as r}<option value={r.id}>{r.icon || ''} {r.name?.de || r.id}</option>{/each}
                </select>
                <button class="rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 px-2 text-white text-sm" on:click={submitOffer} disabled={aiBusy || !offGive || !offWant}>+</button>
                {#if oTrade?.connected}
                  <button class="rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 px-2 text-white text-sm" on:click={submitOnlineOffer} disabled={aiBusy || !offGive || !offWant} title="Als ONLINE-Angebot für andere Spieler veröffentlichen">🌐</button>
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
                      <button class="ml-auto text-[11px] rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 px-2 py-0.5 text-white" on:click={() => takeOnlineOffer(o.owner, o.id)} disabled={aiBusy || !oTrade.connected}>annehmen</button>
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
                    <button class="ml-auto text-[11px] text-stone-400 hover:text-red-300" on:click={() => dropOnlineOffer(o.id)} disabled={aiBusy}>zurückziehen</button>
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
    {/if}

    <!-- Nachbarn / KI-Spieler-Panel -->
    {#if showPlayers}
      <!-- scrollbar: auf kleinen Displays war der untere Teil sonst unerreichbar -->
      <div class={$isMobile ? 'mobile-sheet p-3' : 'absolute right-3 z-30 w-80 max-w-[92vw] rounded-lg border border-sky-800 bg-stone-900/95 backdrop-blur shadow-xl p-3 overflow-y-auto'} style={$isMobile ? '' : `top: ${topBarH + 52}px; max-height: calc(100vh - ${topBarH + 64}px)`}>
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
                  <div class="text-[11px] text-stone-500">Insel {p.islandId} · 👥 {p.population} · {p.epoch || '—'} · 🏠 {p.buildings}{#if p.army || p.defense} · <span title="Armee / Verteidigung">⚔️{p.army} 🛡️{p.defense}</span>{/if}</div>
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
                    {#each (state?.resources || []).filter((r) => r.amount >= 1 && resourceIndex[r.id]?.category !== 'special') as r}<option value={r.id}>{resourceIndex[r.id]?.icon || ''} {resourceIndex[r.id]?.name?.de || r.id}</option>{/each}
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
                  <button class="rounded bg-red-800 hover:bg-red-700 disabled:opacity-40 px-2 text-white" on:click={launchAttack} disabled={aiBusy || !atkTo || !(atkSoldiers > 0)} title="Krieg erklären — Schlacht in der kommenden Nacht">⚔️</button>
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
                    <button class="ml-auto text-stone-500 hover:text-stone-200" title="Zurückziehen" on:click={() => withdrawAttack(d.defenderId)} disabled={aiBusy}>↩️</button>
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
            <button class="mt-2.5 w-full rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white" on:click={addAi} disabled={aiBusy || !(players.freeSlots || []).length}>
              ➕ KI-Spieler zuschalten
            </button>
          {:else}
            <p class="mt-2 text-[11px] text-stone-500">Maximal {players.maxAi} KI-Spieler.</p>
          {/if}
          <p class="mt-2 text-[11px] text-stone-500">KI-Inseln entwickeln sich in Echtzeit mit. Klick auf einen Namen springt hin.</p>
          <OnlineSection on:visit={(e) => visitOnline(e.detail.owner)} />
        {:else}
          <p class="text-xs text-stone-500">Lade…</p>
        {/if}
      </div>
    {/if}

    <!-- KI-Berater-Panel -->
    {#if showAssist}
      <div class={$isMobile ? 'mobile-sheet p-2' : 'absolute right-3 z-30 w-96 max-w-[92vw]'} style={$isMobile ? '' : `top: ${topBarH + 52}px`}>
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

    <!-- Bau-Palette (Desktop: linke Leiste · Mobile: unteres Dock, per 🏗️ getoggelt) -->
    {#if !visiting && (!$isMobile || showBuild)}
      <BuildPalette
        mobile={$isMobile}
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
          if ($isMobile) showBuild = false; // Dock nach Auswahl schließen → Fadenkreuz frei
        }}
      />
    {/if}
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
