<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { fetchContent, fetchState, fetchFrame, fetchMap, build, moveInstance, setRoad, setDeco, fetchPlayers, fetchMarket, onlineIsland, onlineAdopt, onlineTrade } from './lib/api.js';
  import { buildChainIndex, computeShortages, computeBottlenecks } from './lib/chains.js';
  import { recordSample, getHistory } from './lib/history.js';
  import { sfxThud, sfxError, isMuted, setMuted } from './lib/sound.js';

  let soundMuted = isMuted(); // D3: Mute-Zustand (persistiert)
  function toggleSound() { soundMuted = !soundMuted; setMuted(soundMuted); }
  import IsoMap from './components/IsoMap.svelte';
  import ResourceBar from './components/ResourceBar.svelte';
  import EpochBanner from './components/EpochBanner.svelte';
  import BuildPalette from './components/BuildPalette.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import Chronicle from './components/Chronicle.svelte';
  import MarketPanel from './components/MarketPanel.svelte';
  import NeighborsPanel from './components/NeighborsPanel.svelte';
  import AiAssist from './components/AiAssist.svelte';
  import WorkerPanel from './components/WorkerPanel.svelte';
  import Onboarding from './components/Onboarding.svelte';

  // E: Onboarding nur für junge Siedlungen (einmalige Prüfung beim ersten State)
  let showOnboarding = false;
  let _onboardingChecked = false;
  $: if (state && !_onboardingChecked) {
    _onboardingChecked = true;
    try { showOnboarding = !localStorage.getItem('onboarded') && Math.floor(state.population) < 50; } catch {}
  }
  function dismissOnboarding() {
    showOnboarding = false;
    try { localStorage.setItem('onboarded', '1'); } catch {}
  }
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
  let showWorkers = false; // B3: Arbeiter-Management-Panel
  let showEpoch = false; // E: Epochen-Panel auf Mobile (Desktop: Banner immer sichtbar)
  let players = null; // { islands, players, freeSlots, maxAi }
  let aiBusy = false;

  async function loadPlayers() {
    try { players = await fetchPlayers(); } catch {}
  }
  // Handelsmarkt (Stufe 5) + Online-Handel (Multiplayer M3)
  let showMarket = false;
  let market = null;
  let oTrade = null; // /api/online/trade: eigene Angebote/Accepts + fremde Angebote
  async function loadMarket() {
    try { market = await fetchMarket(); } catch {}
    try { oTrade = await onlineTrade(); } catch {}
  }
  /** Der Markt meldet Änderungen zurück: Meldung anzeigen + Daten neu laden. */
  async function onMarketChanged(e) {
    if (e.detail?.msg) showFlash(e.detail.msg, e.detail.ok !== false);
    await loadMarket();
    await pollState();
  }
  /** Das Nachbarn-Panel meldet Änderungen zurück. */
  async function onPlayersChanged(e) {
    if (e.detail?.msg) showFlash(e.detail.msg, e.detail.ok !== false);
    await loadPlayers();
    await pollState();
  }
  // Alle Instanzen (Mensch detailliert aus state + KI-Inseln aus /api/players) für die Weltansicht
  // Fremde (KI-)Instanzen werden mit Besitzer markiert → InfoPanel zeigt sie nur an,
  // ohne Steuerung (Arbeiter/Drehen/Abriss wirken nur auf die eigene Insel).
  $: allInstances = [
    ...((state?.instances) || []),
    ...(((players?.players) || []).filter((p) => p.id !== 0).flatMap((p) => (p.instances || []).map((i) => ({ ...i, _owner: p.name })))),
  ];
  let roadMode = false; // Straßen-Malmodus
  let decoType = null; // 'tree' | 'rock' im Deko-Malmodus
  let moveMode = false; // Verschiebe-Werkzeug: eigenes Gebäude umsetzen
  let mapComp;

  let whatsNew = null; // Zusammenfassung neuer KI-Inhalte seit letztem Besuch

  // ── B2: Offline-Bericht („Während du weg warst") ──
  // Der Server tickt 24/7 weiter — der Bericht entsteht clientseitig aus einem
  // localStorage-Snapshot des letzten Besuchs (Δ Bevölkerung, Epoche, Kämpfe).
  let offlineReport = null;
  const SNAP_KEY = 'offlineSnapshot';
  let _snapSavedAt = 0;
  let _offlineChecked = false;
  // Snapshot des LETZTEN Besuchs sofort beim Start lesen — der erste Poll
  // überschreibt ihn sonst, bevor der Bericht ihn auswerten kann.
  let _bootSnap = null;
  try { _bootSnap = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null'); } catch {}
  function saveSnapshot(force = false) {
    if (!state?.epoch) return;
    if (!force && Date.now() - _snapSavedAt < 30000) return; // max. alle 30 s schreiben
    _snapSavedAt = Date.now();
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify({
        at: Date.now(),
        population: Math.floor(state.population),
        epochId: state.epoch.id,
        epochName: state.epoch.name?.de || state.epoch.id,
      }));
    } catch {}
  }
  function checkOfflineReport() {
    if (_offlineChecked || !state?.epoch) return;
    _offlineChecked = true;
    const snap = _bootSnap;
    saveSnapshot(true); // neuer Besuch = neuer Bezugspunkt
    if (!snap?.at) return;
    const awayMs = Date.now() - snap.at;
    if (awayMs < 30 * 60 * 1000) return; // unter 30 min Abwesenheit: kein Bericht
    const battles = (players?.warLog || []).filter((w) => w.at && new Date(w.at).getTime() > snap.at);
    const epochChanged = snap.epochId && state.epoch.id !== snap.epochId;
    offlineReport = {
      hours: Math.round((awayMs / 3600000) * 10) / 10,
      dPop: Math.floor(state.population) - (snap.population ?? Math.floor(state.population)),
      popNow: Math.floor(state.population),
      epochFrom: epochChanged ? snap.epochName : null,
      epochTo: epochChanged ? (state.epoch.name?.de || state.epoch.id) : null,
      battles,
      advanceReady: !!state.epoch.ready,
    };
  }

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
  let history = getHistory().slice(); // D2: Verlaufspuffer (Sparklines im EpochBanner)
  async function applyState(s) {
    state = s;
    error = null;
    saveSnapshot(); // Bezugspunkt für den Offline-Bericht aktuell halten (gedrosselt)
    if (recordSample(state)) history = getHistory().slice(); // neue Referenz → Svelte-Update
    // Insel gewachsen? → Karte neu laden (Terrain re-baked automatisch)
    if (map && state.mapVersion != null && state.mapVersion !== (map.version ?? 0)) await loadMap();
  }
  async function pollState() {
    try {
      await applyState(await fetchState());
    } catch (e) {
      error = e.message;
    }
  }
  // E: gebündelter Poll (state + players in einem Request — halbiert die Poll-Last)
  async function pollFrame() {
    try {
      const r = await fetchFrame();
      players = r.players;
      await applyState(r.state);
    } catch (e) {
      error = e.message;
    }
  }

  function showFlash(msg, ok = true) {
    flash = { msg, ok };
    if (!ok) sfxError(); // D3: Fehler hörbar machen (dezent)
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
      sfxThud();
      await pollState();
      // Bau-Modus für Reihenbau aktiv lassen; abbrechen mit ESC/Rechtsklick
    } catch (err) {
      showFlash(err.message, false);
    }
  }

  function onSelect(e) {
    if (buildDef || roadMode || decoType || moveMode) return; // in Bau-/Straßen-/Deko-/Verschiebe-Modus keine Auswahl
    selection = e.detail;
  }

  async function onMove(e) {
    const { instanceId, x, y, ok, reason } = e.detail;
    if (!ok) { showFlash('Hier nicht platzierbar: ' + reason, false); return; }
    try {
      await moveInstance(instanceId, x, y);
      sfxThud();
      await pollState();
      showFlash('🏚️ Gebäude verschoben');
    } catch (err) { showFlash(err.message, false); }
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
      moveMode = false;
    } else if ((e.key === 'r' || e.key === 'R') && buildDef) {
      buildRot = (buildRot + 1) % 4; // Gebäude drehen
    }
  }

  onMount(() => {
    loadContent();
    loadMap();
    // Offline-Bericht braucht state UND players (warLog) vom ersten Laden
    Promise.all([pollState(), loadPlayers()]).then(checkOfflineReport);
    loadMarket();
    // Polling pausiert im Hintergrund-Tab (Akku/PWA) — beim Zurückkehren sofort auffrischen.
    // E: state + players kommen gebündelt über /api/frame (ein Request statt zwei).
    const visible = () => !document.hidden;
    const s = setInterval(() => { if (visible()) pollFrame(); }, 2500);
    const c = setInterval(() => { if (visible()) loadContent(); }, 60000);
    // Markt nur pollen, wenn das Panel offen ist
    const pl = setInterval(() => { if (visible() && showMarket) loadMarket(); }, 3000);
    const onVis = () => { if (visible()) { pollFrame(); if (showMarket) loadMarket(); } };
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

  // D1: Toast, wenn ein Tages-Ereignis beginnt (oder beim Laden bereits läuft)
  let _lastEventId;
  $: {
    const ev = state?.activeEvent;
    if (state && ev?.id !== _lastEventId) {
      if (ev) showFlash(`${ev.icon} ${ev.name}${ev.description ? ' — ' + ev.description : ''}`);
      _lastEventId = ev?.id ?? null;
    }
  }

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
      moveMode={visiting ? false : moveMode}
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
      on:move={onMove}
      on:moveinfo={(e) => showFlash(e.detail.reason, false)}
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
        <EpochBanner {state} {history} epochs={content.epochs} {resourceIndex} buildings={content.buildings} on:changed={(e) => { showFlash(e.detail.msg, e.detail.ok ?? true); pollState(); }} />
      </div>
    {:else if showEpoch}
      <!-- E: Mobile — Epochen-Fortschritt/Aufstieg als Sheet (sonst unsichtbar) -->
      <div class="mobile-sheet p-2">
        <div class="flex items-center justify-end"><button class="text-stone-500 hover:text-stone-200 px-2 py-1" on:click={() => (showEpoch = false)}>✕</button></div>
        <EpochBanner {state} {history} epochs={content.epochs} {resourceIndex} buildings={content.buildings} on:changed={(e) => { showFlash(e.detail.msg, e.detail.ok ?? true); pollState(); }} />
      </div>
    {/if}

    <!-- Werkzeugleiste oben rechts (Desktop) — weicht der Materialleiste dynamisch aus -->
    {#if !$isMobile}
    <div class="absolute right-3 z-30 flex gap-2" style="top: {topBarH + 8}px">
      <button
        class="border rounded px-3 py-1.5 text-sm {roadMode
          ? 'bg-amber-800 border-amber-500 text-amber-100'
          : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => { roadMode = !roadMode; decoType = null; buildDef = null; selection = null; moveMode = false; }}
        title="Straßen bauen — auf Wiese/Sand ziehen"
      >
        🛤️
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {moveMode
          ? 'bg-sky-800 border-sky-500 text-sky-100'
          : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => { moveMode = !moveMode; roadMode = false; decoType = null; buildDef = null; selection = null; }}
        title="Gebäude verschieben — eigenes Gebäude anklicken, dann Zielfeld anklicken"
      >
        ✥
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {decoType === 'tree'
          ? 'bg-emerald-800 border-emerald-500 text-emerald-100'
          : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => { decoType = decoType === 'tree' ? null : 'tree'; roadMode = false; buildDef = null; selection = null; moveMode = false; }}
        title="Bäume pflanzen (Wald-Nachbarschaft) — ziehen setzt, Rechtsklick entfernt/rodet"
      >
        🌲
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {decoType === 'rock'
          ? 'bg-stone-600 border-stone-400 text-stone-100'
          : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => { decoType = decoType === 'rock' ? null : 'rock'; roadMode = false; buildDef = null; selection = null; moveMode = false; }}
        title="Felsen setzen (Fels-Nachbarschaft) — ziehen setzt, Rechtsklick entfernt"
      >
        🪨
      </button>
      <button
        class="border rounded px-3 py-1.5 text-sm {showWorkers ? 'bg-emerald-800 border-emerald-500 text-emerald-100' : 'bg-stone-900/90 border-stone-700 hover:border-stone-500'}"
        on:click={() => (showWorkers = !showWorkers)}
        title="Arbeiter-Verwaltung — zuweisen, abziehen, Auto-verteilen"
      >
        👷
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
      <button
        class="bg-stone-900/90 border border-stone-700 rounded px-3 py-1.5 text-sm hover:border-stone-500"
        on:click={toggleSound}
        title={soundMuted ? 'Ton einschalten' : 'Ton stummschalten'}
      >
        {soundMuted ? '🔇' : '🔊'}
      </button>
    </div>
    {/if}

    <!-- ══ Mobile-HUD ══ -->
    {#if $isMobile}
      <!-- Bau-Dock-Umschalter oben links -->
      <div class="absolute top-2 left-2 z-40 safe-top">
        <button class="mobile-fab {showBuild ? 'active' : ''}" on:click={() => { showBuild = !showBuild; if (showBuild) { roadMode = false; decoType = null; moveMode = false; } }} title="Bauen">🏗️</button>
      </div>

      <!-- Menü-FAB oben rechts (Panels) -->
      <div class="absolute top-2 right-2 z-40 flex flex-col items-end gap-2 safe-top">
        <button class="mobile-fab {mobileMenu ? 'active' : ''}" on:click={() => (mobileMenu = !mobileMenu)} title="Menü">☰</button>
        {#if mobileMenu}
          <button class="mobile-fab {showEpoch ? 'active' : ''}" on:click={() => { showEpoch = !showEpoch; showWorkers = showPlayers = showMarket = showAssist = showChronicle = false; }} title="Epoche">🏛️</button>
          <button class="mobile-fab {showWorkers ? 'active' : ''}" on:click={() => { showWorkers = !showWorkers; showEpoch = showPlayers = showMarket = showAssist = showChronicle = false; }} title="Arbeiter">👷</button>
          <button class="mobile-fab {showPlayers ? 'active' : ''}" on:click={() => { showPlayers = !showPlayers; showWorkers = showMarket = showAssist = showChronicle = false; }} title="Nachbarn">🌍</button>
          <button class="mobile-fab {showMarket ? 'active' : ''}" on:click={() => { showMarket = !showMarket; showWorkers = showPlayers = showAssist = showChronicle = false; }} title="Markt">🪙</button>
          <button class="mobile-fab {showAssist ? 'active' : ''}" on:click={() => { showAssist = !showAssist; showWorkers = showPlayers = showMarket = showChronicle = false; }} title="Berater">💬</button>
          <button class="mobile-fab {showChronicle ? 'active' : ''}" on:click={() => { showChronicle = !showChronicle; showWorkers = showPlayers = showMarket = showAssist = false; }} title="KI-Zentrale">🤖</button>
          <button class="mobile-fab" on:click={toggleSound} title={soundMuted ? 'Ton an' : 'Ton aus'}>{soundMuted ? '🔇' : '🔊'}</button>
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
          <button class="mobile-fab {moveMode ? 'active' : ''}" on:click={() => { moveMode = !moveMode; roadMode = false; decoType = null; buildDef = null; selection = null; eraseMode = false; }} title="Gebäude verschieben">✥</button>
          <button class="mobile-fab {roadMode ? 'active' : ''}" on:click={() => { roadMode = !roadMode; decoType = null; buildDef = null; selection = null; moveMode = false; eraseMode = false; }} title="Straßen">🛤️</button>
          <button class="mobile-fab {decoType === 'tree' ? 'active' : ''}" on:click={() => { decoType = decoType === 'tree' ? null : 'tree'; roadMode = false; buildDef = null; selection = null; moveMode = false; eraseMode = false; }} title="Bäume">🌲</button>
          <button class="mobile-fab {decoType === 'rock' ? 'active' : ''}" on:click={() => { decoType = decoType === 'rock' ? null : 'rock'; roadMode = false; buildDef = null; selection = null; moveMode = false; eraseMode = false; }} title="Felsen">🪨</button>
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
    {:else if moveMode}
      <div class="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-sky-900/90 border border-sky-600 rounded-full px-4 py-1.5 text-sm whitespace-nowrap">
        ✥ Verschieben — eigenes Gebäude anklicken (nimmt es auf), dann Zielfeld anklicken · <kbd>ESC</kbd> beendet
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

    <!-- B3: Arbeiter-Management-Panel -->
    {#if showWorkers}
      <div class={$isMobile ? 'mobile-sheet p-3' : 'absolute right-3 z-30 w-80 max-w-[92vw] rounded-lg border border-emerald-800 bg-stone-900/95 backdrop-blur shadow-xl p-3 overflow-y-auto'} style={$isMobile ? '' : `top: ${topBarH + 52}px; max-height: calc(100vh - ${topBarH + 64}px)`}>
        <WorkerPanel
          {state}
          {defIndex}
          {resourceIndex}
          on:close={() => (showWorkers = false)}
          on:changed={(e) => { if (e.detail.msg) showFlash(e.detail.msg, e.detail.ok ?? true); pollState(); }}
        />
      </div>
    {/if}

    <!-- Handelsmarkt-Panel (Stufe 5) + Online-Handel -->
    {#if showMarket}
      <MarketPanel
        {market}
        {oTrade}
        {resourceIndex}
        {topBarH}
        ownResources={state?.resources || []}
        allResources={content?.resources || []}
        on:close={() => (showMarket = false)}
        on:changed={onMarketChanged}
      />
    {/if}

    <!-- Nachbarn / KI-Spieler-Panel (Rangliste, Verschiffen, Krieg, Online) -->
    {#if showPlayers}
      <NeighborsPanel
        {players}
        {resourceIndex}
        {topBarH}
        ownResources={state?.resources || []}
        on:close={() => (showPlayers = false)}
        on:changed={onPlayersChanged}
        on:focusIsland={(e) => mapComp?.focusIsland?.(e.detail.islandId)}
        on:visit={(e) => visitOnline(e.detail.owner)}
      />
    {/if}

    <!-- KI-Berater-Panel -->
    {#if showAssist}
      <div class={$isMobile ? 'mobile-sheet p-2' : 'absolute right-3 z-30 w-96 max-w-[92vw]'} style={$isMobile ? '' : `top: ${topBarH + 52}px`}>
        <AiAssist on:close={() => (showAssist = false)} />
      </div>
    {/if}

    <!-- E: Onboarding für Erstspieler (mechanisch validierte Schritte) -->
    {#if showOnboarding && !visiting && !buildDef}
      <Onboarding {state} buildings={content.buildings} {resourceIndex} mobile={$isMobile} on:dismiss={dismissOnboarding} />
    {/if}

    <!-- B2: Offline-Bericht („Während du weg warst") -->
    {#if offlineReport}
      <div class="absolute top-24 left-1/2 -translate-x-1/2 z-40 w-[min(92vw,480px)] bg-stone-900/97 backdrop-blur border border-sky-700 rounded-lg shadow-2xl p-4">
        <div class="flex items-start gap-2">
          <span class="text-2xl">💤</span>
          <div class="flex-1 min-w-0">
            <h3 class="text-sm font-semibold text-sky-100">Während du weg warst <span class="text-stone-500 font-normal">({offlineReport.hours} h)</span></h3>
            <div class="mt-2 space-y-1 text-xs text-stone-300">
              <div>
                {#if offlineReport.dPop > 0}<span class="text-emerald-300">📈 Bevölkerung +{offlineReport.dPop}</span>{:else if offlineReport.dPop < 0}<span class="text-red-300">📉 Bevölkerung {offlineReport.dPop}</span>{:else}<span>👥 Bevölkerung stabil</span>{/if}
                <span class="text-stone-500"> → jetzt {offlineReport.popNow}</span>
              </div>
              {#if offlineReport.epochTo}
                <div class="text-amber-300">🏛️ Epoche: {offlineReport.epochFrom} → {offlineReport.epochTo}</div>
              {/if}
              {#if offlineReport.advanceReady}
                <div class="text-amber-200">⬆ <b>Epochen-Aufstieg bereit</b> — Details im Epochen-Banner.</div>
              {/if}
              {#each offlineReport.battles as b}
                <div class="text-red-200/90">⚔️ {b.report}</div>
              {/each}
              {#if !offlineReport.battles.length && !offlineReport.epochTo && offlineReport.dPop >= 0}
                <div class="text-stone-500">Ruhige Zeit — die Siedlung hat fleißig weitergearbeitet.</div>
              {/if}
            </div>
            <button class="mt-3 text-xs bg-sky-700 hover:bg-sky-600 rounded px-3 py-1.5 text-white" on:click={() => (offlineReport = null)}>Weiter</button>
          </div>
        </div>
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
        topOffset={topBarH + 8}
        buildings={content.buildings}
        {state}
        {resourceIndex}
        epochs={content.epochs}
        activeId={buildDef?.id}
        {newPackIds}
        on:pick={(e) => {
          buildDef = e.detail.def;
          selection = null;
          roadMode = false;
          decoType = null;
          moveMode = false;
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
