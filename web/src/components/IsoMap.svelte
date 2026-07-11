<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { TILE_W, TILE_H, gridToScreen, screenToGrid, tileDiamond, TERRAIN_COLORS, tileRand, drawTree, drawRock } from '../lib/iso.js';
  import { canPlaceClient, footprintOf } from '../lib/placement.js';
  import { createNpcSystem } from '../lib/npc.js';
  import { drawBuilding as drawBuildingSprite, getBuildingSprite, drawBuildingFX } from '../lib/sprites.js';
  import { chainNeighbors, isStarved } from '../lib/chains.js';

  export let map; // { width, height, tiles, legend }
  export let instances = []; // [{id, buildingId, x, y, done, ticksLeft}]
  export let defIndex = {}; // buildingId -> def
  export let buildDef = null; // gewähltes Gebäude im Bau-Modus (oder null)
  export let buildRot = 0; // Ausrichtung im Bau-Modus (0-3)
  export let population = 0;
  export let epochIndex = {}; // epoch-id -> order (Baustil je Epoche)
  export let selectedInstance = null; // ausgewähltes Gebäude → Ketten-Overlay
  export let shortages = new Set(); // Ressourcen-IDs im Engpass → Warn-Badges
  export let roads = []; // ["x,y", …] platzierte Straßen
  export let roadMode = false; // Straßen-Malmodus aktiv
  export let placed = {}; // "x,y" -> 'tree'|'rock' (platzierte Deko)
  export let cleared = []; // ["x,y", …] gerodete Wald-/Felsfelder
  export let decoType = null; // 'tree' | 'rock' im Deko-Malmodus
  export let ships = []; // [{id, owner, from, to, departTick, arriveTick, cargo}] unterwegs
  export let shipTick = 0; // Server-Tick (Referenz für flüssige Interpolation)
  export let tickSeconds = 5;
  // Basis für die glatte Tick-Schätzung; aktualisiert, wenn ein neuer Server-Tick eintrifft
  $: if (shipTick !== rt?.shipBaseTick) { if (rt) { rt.shipBaseTick = shipTick; rt.shipBaseTime = performance.now(); } }

  $: roadSet = new Set(roads);
  $: clearedSet = new Set(cleared);
  let decoBakes = []; // [{canvas, ox, oy}] je Insel
  let _decoSig = null;
  let painting = false;
  let erasing = false; // Straßen-Abriss-Modus (Rechtsklick)
  let roadStart = null; // Startfeld beim Ziehen einer geraden Straße
  let paintSet = new Set(); // während des Ziehens bearbeitete Felder (Vorschau)
  let roadBakes = []; // Straßen offscreen je Insel gebacken (nur bei Änderung neu)
  let terrainBaked = false;
  let _terrainSig = null, _roadsSig = null; // Signaturen: nur bei echter Änderung neu backen
  // Minimap: interne Auflösung (min. 1 px/Tile) + fixe Anzeigegröße ~160px.
  $: MINI = map ? Math.max(1, Math.round(200 / map.width)) : 3;
  const miniDisp = 160;
  let miniCanvas, miniCtx, miniTerrain = null;

  const dispatch = createEventDispatcher();

  let canvas, ctx, wrap;
  let viewW = 800,
    viewH = 600;
  const camera = { x: 0, y: 0, zoom: 1 };
  let viewRot = 0; // Ansichts-Drehung 0-3 (je 90°)
  let hover = null; // {gx, gy}
  let dragging = false;
  let dragMoved = false;
  let lastPointer = { x: 0, y: 0 };
  const pointers = new Map(); // pointerId -> {x,y}: aktive Zeiger (Multi-Touch)
  let pinch = null; // {dist, cx, cy}: Zwei-Finger-Geste (Pinch-Zoom + Schwenk)
  let terrainBakes = []; // [{canvas, ox, oy}] je Insel — Ozean bleibt prozedural
  const npcSystem = createNpcSystem();

  // ── Per-Insel-Rendering ──
  // Große Mehr-Insel-Welten passen nicht in ein einziges Offscreen-Canvas.
  // Deshalb wird jede Insel-Region in ein eigenes, kleines Canvas gebacken und
  // an ihre Weltposition geblittet; der offene Ozean bleibt prozedural (Hintergrund).
  const islandList = () => (map?.islands?.length ? map.islands : [{ id: 0, x: 0, y: 0, w: map.width, h: map.height }]);

  // Sammelt die Tiles einer Insel (tiefen-sortiert für korrekte Überlappung) + Bildschirm-Bounding-Box.
  function islandTiles(isl) {
    const tiles = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let gy = isl.y; gy < isl.y + isl.h; gy++) {
      for (let gx = isl.x; gx < isl.x + isl.w; gx++) {
        const [vx, vy] = rotFwd(gx, gy);
        const s = gridToScreen(vx, vy);
        tiles.push({ gx, gy, vx, vy, sx: s.x, sy: s.y, depth: vx + vy });
        if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
      }
    }
    tiles.sort((a, b) => a.depth - b.depth);
    // Ränder großzügig: Tiles ±TILE_W/2 breit, Bäume/Felsen ragen nach oben.
    const box = { minX: minX - TILE_W, minY: minY - TILE_H * 5, maxX: maxX + TILE_W, maxY: maxY + TILE_H * 2 };
    return { tiles, box };
  }

  // Bäckt jede Insel mit einem Tile-Zeichner in ein eigenes Canvas → [{canvas, ox, oy}].
  function bakeIslands(drawEach) {
    const bakes = [];
    for (const isl of islandList()) {
      const { tiles, box } = islandTiles(isl);
      const w = Math.max(1, Math.ceil(box.maxX - box.minX));
      const h = Math.max(1, Math.ceil(box.maxY - box.minY));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const off = { x: -box.minX, y: -box.minY };
      for (const t of tiles) drawEach(g, t, off);
      bakes.push({ canvas: c, ox: box.minX, oy: box.minY });
    }
    return bakes;
  }

  function buildTerrain() {
    if (!map) return;
    const isWaterV = (vx, vy) => { const [gx, gy] = rotInv(vx, vy); return (gx < 0 || gy < 0 || gx >= map.width || gy >= map.height) ? true : map.legend[map.tiles[gy * map.width + gx]] === 'water'; };
    terrainBakes = bakeIslands((g, t, off) => {
      const key = `${t.gx},${t.gy}`;
      let tt = map.legend[map.tiles[t.gy * map.width + t.gx]];
      if ((tt === 'forest' || tt === 'rock') && clearedSet.has(key)) tt = 'grass'; // gerodet = flaches Gras
      const p = placed[key];
      if (p === 'tree') tt = 'forest'; else if (p === 'rock') tt = 'rock'; // platzierte Deko hebt den Untergrund
      const col = TERRAIN_COLORS[tt] || TERRAIN_COLORS.grass;
      drawTile(g, t.vx, t.vy, tt, col, off, isWaterV);
    });
    terrainBaked = true;
  }

  // Deko-Ebene (Bäume/Felsen) je Insel — respektiert placed + cleared.
  function bakeDeco() {
    if (!map || !terrainBaked) return;
    decoBakes = bakeIslands((g, t, off) => {
      const key = `${t.gx},${t.gy}`;
      const tt = map.legend[map.tiles[t.gy * map.width + t.gx]];
      const p = placed[key];
      let type = null, hgt = 0;
      if (p === 'tree') { type = 'tree'; hgt = TERRAIN_COLORS.forest.h; }
      else if (p === 'rock') { type = 'rock'; hgt = TERRAIN_COLORS.rock.h; }
      else if (tt === 'forest' && !clearedSet.has(key)) { type = 'tree'; hgt = TERRAIN_COLORS.forest.h; }
      else if (tt === 'rock' && !clearedSet.has(key) && tileRand(t.gx, t.gy, 4) > 0.35) { type = 'rock'; hgt = TERRAIN_COLORS.rock.h; }
      if (!type) return;
      const px = t.sx + off.x, py = t.sy + off.y - hgt;
      const jx = (tileRand(t.gx, t.gy, 1) - 0.5) * TILE_W * 0.3;
      const jy = (tileRand(t.gx, t.gy, 2) - 0.5) * TILE_H * 0.3;
      const r = 0.85 + tileRand(t.gx, t.gy, 3) * 0.4;
      const seed = Math.floor(tileRand(t.gx, t.gy, 5) * 100000);
      if (type === 'tree') drawTree(g, px + jx, py + jy, r, seed);
      else drawRock(g, px + jx, py + jy, r, seed);
    });
  }

  function diamondPath(g, cx, cy) {
    g.beginPath();
    g.moveTo(cx, cy - TILE_H / 2);
    g.lineTo(cx + TILE_W / 2, cy);
    g.lineTo(cx, cy + TILE_H / 2);
    g.lineTo(cx - TILE_W / 2, cy);
    g.closePath();
  }

  function drawTile(g, gx, gy, t, col, off, isWater) {
    const c = gridToScreen(gx, gy);
    const cx = c.x + off.x;
    const cy = c.y + off.y - col.h;
    // Erhöhte Kacheln: Sockel mit Verlauf (Klippe)
    if (col.h > 0) {
      const grd = g.createLinearGradient(0, cy, 0, cy + col.h);
      grd.addColorStop(0, col.side);
      grd.addColorStop(1, `rgba(0,0,0,0.55)`);
      g.fillStyle = col.side;
      g.beginPath();
      g.moveTo(cx - TILE_W / 2, cy);
      g.lineTo(cx, cy + TILE_H / 2);
      g.lineTo(cx + TILE_W / 2, cy);
      g.lineTo(cx + TILE_W / 2, cy + col.h);
      g.lineTo(cx, cy + TILE_H / 2 + col.h);
      g.lineTo(cx - TILE_W / 2, cy + col.h);
      g.closePath();
      g.fill();
      g.fillStyle = grd;
      g.fill();
    }
    // Oberseite
    diamondPath(g, cx, cy);
    g.fillStyle = col.top;
    g.fill();
    // Per-Tile-Helligkeitsvariation (bricht die flache Fläche auf)
    const v = tileRand(gx, gy, 7) - 0.5;
    if (Math.abs(v) > 0.04) { diamondPath(g, cx, cy); g.fillStyle = v > 0 ? `rgba(255,255,255,${v * 0.18})` : `rgba(0,0,0,${-v * 0.16})`; g.fill(); }
    // sehr dezente Kante
    diamondPath(g, cx, cy); g.strokeStyle = 'rgba(0,0,0,0.05)'; g.lineWidth = 1; g.stroke();

    if (t === 'grass') {
      // Grasbüschel
      g.fillStyle = 'rgba(40,70,30,0.35)';
      for (let i = 0; i < 3; i++) {
        const rx = (tileRand(gx, gy, 10 + i) - 0.5) * TILE_W * 0.55;
        const ry = (tileRand(gx, gy, 20 + i) - 0.5) * TILE_H * 0.55;
        g.beginPath(); g.ellipse(cx + rx, cy + ry, 1.6, 1, 0, 0, Math.PI * 2); g.fill();
      }
    } else if (t === 'sand') {
      g.fillStyle = 'rgba(160,130,70,0.35)';
      for (let i = 0; i < 2; i++) {
        const rx = (tileRand(gx, gy, 12 + i) - 0.5) * TILE_W * 0.4;
        const ry = (tileRand(gx, gy, 22 + i) - 0.5) * TILE_H * 0.4;
        g.beginPath(); g.arc(cx + rx, cy + ry, 0.9, 0, Math.PI * 2); g.fill();
      }
    } else if (t === 'water') {
      // Wellenlinien
      g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1;
      for (let i = -1; i <= 1; i++) {
        const yy = cy + i * 5 + (tileRand(gx, gy, 30 + i) - 0.5) * 3;
        g.beginPath(); g.moveTo(cx - TILE_W * 0.22, yy); g.quadraticCurveTo(cx, yy - 2, cx + TILE_W * 0.22, yy); g.stroke();
      }
      // Küstenschaum an Land-Nachbarn
      const edges = [
        { land: !isWater(gx, gy - 1), a: { x: cx, y: cy - TILE_H / 2 }, b: { x: cx + TILE_W / 2, y: cy } }, // NE
        { land: !isWater(gx + 1, gy), a: { x: cx + TILE_W / 2, y: cy }, b: { x: cx, y: cy + TILE_H / 2 } }, // SE
        { land: !isWater(gx, gy + 1), a: { x: cx, y: cy + TILE_H / 2 }, b: { x: cx - TILE_W / 2, y: cy } }, // SW
        { land: !isWater(gx - 1, gy), a: { x: cx - TILE_W / 2, y: cy }, b: { x: cx, y: cy - TILE_H / 2 } }, // NW
      ];
      g.strokeStyle = 'rgba(226,240,245,0.5)'; g.lineWidth = 2;
      for (const e of edges) if (e.land) { g.beginPath(); g.moveTo(e.a.x, e.a.y); g.lineTo(e.b.x, e.b.y); g.stroke(); }
    }
  }

  // ── Kamera-Helfer ──
  function worldToScreen(wx, wy) {
    return { x: (wx - camera.x) * camera.zoom + viewW / 2, y: (wy - camera.y) * camera.zoom + viewH / 2 };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - viewW / 2) / camera.zoom + camera.x, y: (sy - viewH / 2) / camera.zoom + camera.y };
  }
  // ── Ansichts-Rotation (90°-Schritte), Karte ist quadratisch (N×N) ──
  const nSize = () => (map ? map.width : 1);
  function rotFwd(gx, gy) { // Grid → Ansichts-Grid
    const N = nSize();
    switch (viewRot & 3) {
      case 1: return [N - 1 - gy, gx];
      case 2: return [N - 1 - gx, N - 1 - gy];
      case 3: return [gy, N - 1 - gx];
      default: return [gx, gy];
    }
  }
  function rotInv(vx, vy) { // Ansichts-Grid → Grid
    const N = nSize();
    switch (viewRot & 3) {
      case 1: return [vy, N - 1 - vx];
      case 2: return [N - 1 - vx, N - 1 - vy];
      case 3: return [N - 1 - vy, vx];
      default: return [vx, vy];
    }
  }
  // Grid-Tile → Bildschirm-Mittelpunkt (mit Ansichts-Rotation, vor Kamera)
  function project(gx, gy) { const [vx, vy] = rotFwd(gx, gy); return gridToScreen(vx, vy); }
  // Ansichts-Grundfläche eines Gebäudes (Bounding-Box in Ansichts-Koordinaten)
  function buildingViewGeom(x, y, fp) {
    let minx = Infinity, miny = Infinity;
    for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) {
      const [vx, vy] = rotFwd(x + dx, y + dy);
      if (vx < minx) minx = vx; if (vy < miny) miny = vy;
    }
    return { vx0: minx, vy0: miny, w: viewRot & 1 ? fp.h : fp.w, h: viewRot & 1 ? fp.w : fp.h };
  }

  function pointerToGrid(sx, sy) {
    const w = screenToWorld(sx, sy);
    const v = screenToGrid(w.x, w.y);
    const [gx, gy] = rotInv(v.gx, v.gy);
    return { gx, gy };
  }
  // Grobes Viewport-Culling anhand des Tile-Mittelpunkts (in Ansichts-Koordinaten)
  function inViewport(gx, gy, margin) {
    const wpt = project(gx, gy);
    const s = worldToScreen(wpt.x, wpt.y);
    return s.x > -margin && s.x < viewW + margin && s.y > -margin * 1.6 && s.y < viewH + margin * 0.7;
  }

  function instanceAt(gx, gy) {
    for (const inst of instances) {
      const { w, h } = footprintOf(defIndex[inst.buildingId] || {}, inst.rot ?? 0);
      if (gx >= inst.x && gx < inst.x + w && gy >= inst.y && gy < inst.y + h) return inst;
    }
    return null;
  }

  // ── Tag/Nacht-Zyklus (voller Zyklus ~3 Min Echtzeit) ──
  const DAY_MS = 180000;
  function ambient(t) {
    const phase = (t / DAY_MS) % 1;
    const sun = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2); // 1 = Mittag, 0 = Mitternacht
    const night = Math.max(0, Math.min(1, (0.5 - sun) / 0.5));
    const golden = Math.max(0, 1 - Math.abs(sun - 0.32) / 0.18); // Morgen-/Abendrot
    return { sun, night, golden };
  }
  const mix = (a, b, t) => Math.round(a + (b - a) * t);

  // ── Haupt-Render-Schleife ──
  // WICHTIG: Laufzeit-Uhr in einem nicht-reaktiven Objekt halten. Würden wir
  // hier reaktive `let`-Variablen pro Frame zuweisen, liefe Sveltes komplette
  // Reaktivität (inkl. buildRoadsCanvas) jeden Frame → massive Latenz.
  // WICHTIG: auch `raf` hier ablegen — eine reaktive `let raf` würde bei jeder
  // Zuweisung pro Frame die ganze Komponente invalidieren.
  // Drossel-Konstanten (CPU-Optimierung): Render ~30 fps, NPC-Sim ~20 fps, Minimap ~5 fps.
  const SIM_STEP_MS = 1000 / 60; // Referenz-Takt, an dem die NPC-Geschwindigkeit kalibriert ist
  const RENDER_MS = 1000 / 30;
  const NPC_MS = 1000 / 20;
  const MINI_MS = 200;
  const rt = { now: 0, amb: { sun: 1, night: 0, golden: 0 }, raf: 0, lastRender: 0, lastNpc: 0, lastMini: 0, lastCamKey: '', shipBaseTick: 0, shipBaseTime: 0 };
  function render() {
    if (!ctx) return;
    rt.now = performance.now();
    rt.amb = ambient(rt.now);
    const amb = rt.amb, now = rt.now;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    // Hintergrund = offenes Meer (kein dunkler Void), tageszeitabhängig
    const grd = ctx.createLinearGradient(0, 0, 0, viewH);
    grd.addColorStop(0, `rgb(${mix(40, 12, amb.night)}, ${mix(96, 30, amb.night)}, ${mix(130, 52, amb.night)})`);
    grd.addColorStop(1, `rgb(${mix(28, 8, amb.night)}, ${mix(70, 22, amb.night)}, ${mix(100, 40, amb.night)})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.translate(viewW / 2, viewH / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // Per-Insel-Bakes blitten (nur sichtbare — Culling gegen den Weltausschnitt)
    const halfW = viewW / 2 / camera.zoom + 96, halfH = viewH / 2 / camera.zoom + 96;
    const vmnX = camera.x - halfW, vmxX = camera.x + halfW, vmnY = camera.y - halfH, vmxY = camera.y + halfH;
    const bakeVis = (b) => b.ox < vmxX && b.ox + b.canvas.width > vmnX && b.oy < vmxY && b.oy + b.canvas.height > vmnY;
    for (const b of terrainBakes) if (bakeVis(b)) ctx.drawImage(b.canvas, b.ox, b.oy);
    for (const b of roadBakes) if (bakeVis(b)) ctx.drawImage(b.canvas, b.ox, b.oy);
    for (const b of decoBakes) if (bakeVis(b)) ctx.drawImage(b.canvas, b.ox, b.oy);
    if (paintSet.size) drawPaintPreview();

    // Hover-/Bau-Vorschau
    if (hover) {
      if (buildDef) {
        const fp = footprintOf(buildDef, buildRot);
        const check = canPlaceClient(map, instances, defIndex, buildDef, hover.gx, hover.gy, buildRot);
        ctx.fillStyle = check.ok ? 'rgba(80,220,120,0.5)' : 'rgba(230,80,80,0.5)';
        for (let dy = 0; dy < fp.h; dy++) {
          for (let dx = 0; dx < fp.w; dx++) fillDiamond(hover.gx + dx, hover.gy + dy);
        }
        const geom = buildingViewGeom(hover.gx, hover.gy, fp);
        drawBuildingSprite(ctx, {
          def: buildDef, gx: geom.vx0, gy: geom.vy0, w: geom.w, h: geom.h, rot: (buildRot + viewRot) % 4,
          done: true, alpha: 0.6, time: now, epochOrder: epochIndex[buildDef.epoch] ?? 0,
        });
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        fillDiamond(hover.gx, hover.gy);
      }
    }

    // Gebäude + NPCs zusammen nach Tiefe (gx+gy) sortiert zeichnen (mit Culling)
    const npcs = npcSystem.get();
    const drawables = [];
    for (const inst of instances) {
      const def = defIndex[inst.buildingId];
      const fp = footprintOf(def || {}, inst.rot ?? 0);
      if (!inViewport(inst.x + (fp.w - 1) / 2, inst.y + (fp.h - 1) / 2, 220)) continue;
      const geom = buildingViewGeom(inst.x, inst.y, fp);
      drawables.push({ depth: geom.vx0 + geom.vy0 + (geom.w + geom.h) / 2, kind: 'building', inst, def });
    }
    for (const n of npcs) {
      if (!inViewport(n.x, n.y, 40)) continue;
      const [vx, vy] = rotFwd(n.x, n.y);
      drawables.push({ depth: vx + vy, kind: 'npc', n });
    }
    drawables.sort((a, b) => a.depth - b.depth);

    for (const d of drawables) {
      if (d.kind === 'building') drawBuilding(d.inst, d.def);
      else drawNpc(d.n);
    }

    // Schiffe auf dem Ozean (Stufe 4) — Position flüssig zwischen den Ticks interpolieren
    if (ships.length) {
      const estTick = rt.shipBaseTick + (rt.now - rt.shipBaseTime) / 1000 / (tickSeconds || 5);
      for (const s of ships) {
        const span = Math.max(1, s.arriveTick - s.departTick);
        const t = Math.max(0, Math.min(1, (estTick - s.departTick) / span));
        const sx = s.from.x + (s.to.x - s.from.x) * t;
        const sy = s.from.y + (s.to.y - s.from.y) * t;
        if (inViewport(sx, sy, 40)) drawShip(s, sx, sy);
      }
    }

    drawChainOverlay();
    drawShortageBadges();

    // Tageszeit-Overlay (im Bildschirmraum)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (amb.night > 0.01) {
      ctx.fillStyle = `rgba(18, 30, 66, ${amb.night * 0.5})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }
    if (amb.golden > 0.01) {
      ctx.fillStyle = `rgba(255, 150, 60, ${amb.golden * 0.13})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }
    // Minimap seltener neu zeichnen (ändert sich kaum) — spart eine Voll-Karten-
    // Neuzeichnung pro Frame. Bei Kamerabewegung sofort aktualisieren (Ausschnittsrahmen).
    const camKey = `${camera.x}|${camera.y}|${camera.zoom}`;
    if (now - rt.lastMini >= MINI_MS || camKey !== rt.lastCamKey) { rt.lastMini = now; rt.lastCamKey = camKey; drawMini(); }
  }

  // Kleines Schiff auf dem Ozean (leichtes Wippen)
  function drawShip(s, gx, gy) {
    const p = project(gx, gy);
    const x = p.x, y = p.y + Math.sin(rt.now / 400 + s.id) * 1.5;
    ctx.save();
    ctx.translate(x, y);
    // Kielwasser
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.ellipse(0, 3, 11, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    // Rumpf
    ctx.fillStyle = '#6b4a2b';
    ctx.beginPath(); ctx.moveTo(-9, 0); ctx.quadraticCurveTo(0, 6, 9, 0); ctx.lineTo(6, -3); ctx.lineTo(-6, -3); ctx.closePath(); ctx.fill();
    // Mast + Segel
    ctx.strokeStyle = '#3a2a18'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -3); ctx.lineTo(0, -16); ctx.stroke();
    ctx.fillStyle = '#f2ecda';
    ctx.beginPath(); ctx.moveTo(1, -15); ctx.lineTo(1, -4); ctx.lineTo(9, -6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Mittelpunkt eines Gebäudes (leicht angehoben, damit Linien am Körper andocken)
  function centerOf(inst) {
    const geom = buildingViewGeom(inst.x, inst.y, footprintOf(defIndex[inst.buildingId] || {}, inst.rot ?? 0));
    const c = gridToScreen(geom.vx0 + (geom.w - 1) / 2, geom.vy0 + (geom.h - 1) / 2);
    return { x: c.x, y: c.y - 14 };
  }

  function drawFlow(a, b, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = -((rt.now / 55) % 10);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // fließender Punkt (Warenstrom a → b)
    const t = (rt.now / 1400) % 1;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawChainOverlay() {
    if (!selectedInstance) return;
    const def = defIndex[selectedInstance.buildingId];
    if (!def?.production) return;
    const cur = instances.find((i) => i.id === selectedInstance.id);
    if (!cur) return;
    const { suppliers, customers } = chainNeighbors(cur, def, instances, defIndex, 4);
    const here = centerOf(cur);
    // Auswahl-Ring
    ctx.strokeStyle = 'rgba(245,220,150,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(here.x, here.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    for (const s of suppliers) drawFlow(centerOf(s.inst), here, '#5fd08a'); // Zulieferer → hier
    for (const c of customers) drawFlow(here, centerOf(c.inst), '#f0b24a'); // hier → Abnehmer
  }

  function drawShortageBadges() {
    for (const inst of instances) {
      if (!inst.done) continue;
      const def = defIndex[inst.buildingId];
      if (!isStarved(def, shortages)) continue;
      const c = centerOf(inst);
      ctx.font = '13px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const bob = 2 + Math.sin(rt.now / 300 + inst.id) * 1.5;
      ctx.fillText('⚠️', c.x, c.y - 30 - bob);
      ctx.textBaseline = 'alphabetic';
    }
  }

  function fillDiamond(gx, gy) {
    const c = project(gx, gy);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - TILE_H / 2);
    ctx.lineTo(c.x + TILE_W / 2, c.y);
    ctx.lineTo(c.x, c.y + TILE_H / 2);
    ctx.lineTo(c.x - TILE_W / 2, c.y);
    ctx.closePath();
    ctx.fill();
  }

  // Straßen-Kachel (gestampfte Erde) an einem Bildschirm-Mittelpunkt zeichnen
  function drawRoadShape(g, cx, cy, style) {
    g.fillStyle = style === 'erase' ? 'rgba(220,90,80,0.55)' : style === 'preview' ? 'rgba(210,180,130,0.6)' : '#b19468';
    g.beginPath();
    g.moveTo(cx, cy - TILE_H / 2); g.lineTo(cx + TILE_W / 2, cy);
    g.lineTo(cx, cy + TILE_H / 2); g.lineTo(cx - TILE_W / 2, cy);
    g.closePath(); g.fill();
    if (!style) { g.fillStyle = '#c2a878'; g.beginPath(); g.ellipse(cx, cy, TILE_W * 0.28, TILE_H * 0.28, 0, 0, Math.PI * 2); g.fill(); }
  }
  // Holzbrücke über Wasser zeichnen
  function drawBridge(g, cx, cy) {
    g.fillStyle = '#7a5c34';
    g.beginPath();
    g.moveTo(cx, cy - TILE_H / 2); g.lineTo(cx + TILE_W / 2, cy);
    g.lineTo(cx, cy + TILE_H / 2); g.lineTo(cx - TILE_W / 2, cy);
    g.closePath(); g.fill();
    // Planken
    g.strokeStyle = 'rgba(45,30,15,0.5)'; g.lineWidth = 1;
    for (let k = -1; k <= 1; k++) {
      const ox = k * TILE_W * 0.22, oy = k * TILE_H * 0.22;
      g.beginPath();
      g.moveTo(cx - TILE_W * 0.3 + ox, cy - oy + TILE_H * 0.15);
      g.lineTo(cx + TILE_W * 0.3 + ox, cy - oy - TILE_H * 0.15);
      g.stroke();
    }
    // helles Geländer entlang der oberen Kanten
    g.strokeStyle = 'rgba(190,160,110,0.65)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx - TILE_W / 2, cy); g.lineTo(cx, cy - TILE_H / 2); g.lineTo(cx + TILE_W / 2, cy); g.stroke();
  }
  // Straßen einmal offscreen backen (nur wenn sich das Netz ändert)
  function buildRoadsCanvas() {
    if (!map || !terrainBaked) return;
    roadBakes = [];
    for (const isl of islandList()) {
      const { box } = islandTiles(isl);
      const w = Math.max(1, Math.ceil(box.maxX - box.minX));
      const h = Math.max(1, Math.ceil(box.maxY - box.minY));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      let drew = false;
      for (const key of roadSet) {
        const ci = key.indexOf(',');
        const gx = +key.slice(0, ci), gy = +key.slice(ci + 1);
        if (gx < isl.x || gy < isl.y || gx >= isl.x + isl.w || gy >= isl.y + isl.h) continue; // nur Straßen dieser Insel
        const p = project(gx, gy);
        const px = p.x - box.minX, py = p.y - box.minY;
        if (map.legend[map.tiles[gy * map.width + gx]] === 'water') drawBridge(g, px, py);
        else drawRoadShape(g, px, py, null);
        drew = true;
      }
      if (drew) roadBakes.push({ canvas: c, ox: box.minX, oy: box.minY });
    }
  }
  // Live-Vorschau der gerade bearbeiteten Felder (Straße = Erde, Deko = farbige Raute)
  function drawPaintPreview() {
    for (const key of paintSet) {
      const ci = key.indexOf(',');
      const gx = +key.slice(0, ci), gy = +key.slice(ci + 1);
      if (roadMode) {
        const p = project(gx, gy);
        drawRoadShape(ctx, p.x, p.y, erasing ? 'erase' : 'preview');
      } else {
        ctx.fillStyle = erasing ? 'rgba(220,90,80,0.5)' : decoType === 'rock' ? 'rgba(160,160,160,0.55)' : 'rgba(80,200,90,0.5)';
        fillDiamond(gx, gy);
      }
    }
  }

  // ── Minimap ──
  function bakeMini() {
    if (!map) return;
    const c = document.createElement('canvas');
    c.width = map.width * MINI; c.height = map.height * MINI;
    const g = c.getContext('2d');
    for (let gy = 0; gy < map.height; gy++) {
      for (let gx = 0; gx < map.width; gx++) {
        const t = map.legend[map.tiles[gy * map.width + gx]];
        g.fillStyle = (TERRAIN_COLORS[t] || TERRAIN_COLORS.grass).top;
        g.fillRect(gx * MINI, gy * MINI, MINI, MINI);
      }
    }
    miniTerrain = c;
  }
  function drawMini() {
    if (!miniCtx && miniCanvas) miniCtx = miniCanvas.getContext('2d');
    if (!miniCtx || !miniTerrain) return;
    const mw = map.width * MINI, mh = map.height * MINI;
    miniCtx.clearRect(0, 0, mw, mh);
    miniCtx.drawImage(miniTerrain, 0, 0);
    if (roadSet.size) {
      miniCtx.fillStyle = '#b19468';
      for (const key of roadSet) { const ci = key.indexOf(','); miniCtx.fillRect(+key.slice(0, ci) * MINI, +key.slice(ci + 1) * MINI, MINI, MINI); }
    }
    for (const inst of instances) {
      miniCtx.fillStyle = inst.done ? '#f6e0b0' : '#ffcf4a';
      miniCtx.fillRect(inst.x * MINI - 1, inst.y * MINI - 1, MINI + 1, MINI + 1);
    }
    // sichtbarer Ausschnitt als Rahmen (4 Bildschirmecken → Gitter)
    const cs = [[0, 0], [viewW, 0], [viewW, viewH], [0, viewH]].map(([sx, sy]) => pointerToGrid(sx, sy));
    miniCtx.strokeStyle = 'rgba(255,255,255,0.9)'; miniCtx.lineWidth = 1.2;
    miniCtx.beginPath();
    cs.forEach((gp, i) => { const x = gp.gx * MINI, y = gp.gy * MINI; i ? miniCtx.lineTo(x, y) : miniCtx.moveTo(x, y); });
    miniCtx.closePath(); miniCtx.stroke();
  }
  function onMiniClick(e) {
    if (!map) return;
    const rect = miniCanvas.getBoundingClientRect();
    // Anzeige kann per CSS skaliert sein → über rect-Größe auf Gitter abbilden
    const gx = ((e.clientX - rect.left) / rect.width) * map.width;
    const gy = ((e.clientY - rect.top) / rect.height) * map.height;
    const p = project(gx, gy);
    camera.x = p.x; camera.y = p.y;
  }

  function drawBuilding(inst, def) {
    const rot = inst.rot ?? 0;
    const geom = buildingViewGeom(inst.x, inst.y, footprintOf(def || {}, rot));
    const effRot = (rot + viewRot) % 4; // Türseite dreht mit der Ansicht mit
    const eo = epochIndex[def?.epoch] ?? 0;
    const o = gridToScreen(geom.vx0, geom.vy0);
    if (!inst.done) {
      const buildTime = def?.buildTimeTicks ?? 1;
      const progress = 1 - Math.min(1, (inst.ticksLeft ?? 0) / Math.max(1, buildTime));
      drawBuildingSprite(ctx, { def: def || {}, gx: geom.vx0, gy: geom.vy0, w: geom.w, h: geom.h, rot: effRot, done: false, progress, time: rt.now });
      return;
    }
    const s = getBuildingSprite(def || {}, eo, geom.w, geom.h, effRot);
    ctx.drawImage(s.bitmap || s.canvas, o.x - s.ax, o.y - s.ay);
    drawBuildingFX(ctx, def || {}, geom.vx0, geom.vy0, geom.w, geom.h, eo, rt.now, inst.id, rt.amb.night);
  }

  function drawNpc(n) {
    const c = project(n.x, n.y);
    // Geh-Wackeln, wenn unterwegs
    const bob = n.moving ? Math.abs(Math.sin(rt.now / 90 + n.phase)) * 1.6 : 0;
    // Schatten (bleibt am Boden)
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + 1, 4, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    const y = c.y - bob;
    // Beine
    ctx.strokeStyle = '#3a2f26';
    ctx.lineWidth = 1.2;
    const step = n.moving ? Math.sin(rt.now / 90 + n.phase) * 1.4 : 0;
    ctx.beginPath();
    ctx.moveTo(c.x - 1, y - 3); ctx.lineTo(c.x - 1 + step, y);
    ctx.moveTo(c.x + 1, y - 3); ctx.lineTo(c.x + 1 - step, y);
    ctx.stroke();
    // Körper (Hemd, nachts nicht heller — Personen bleiben sichtbar)
    ctx.fillStyle = `hsl(${n.shirt}, 45%, 48%)`;
    ctx.fillRect(c.x - 2, y - 8, 4, 5);
    // Kopf
    ctx.fillStyle = `hsl(${n.hue}, 45%, 66%)`;
    ctx.beginPath();
    ctx.arc(c.x, y - 10, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Animationsschleife ──
  // rAF feuert mit voller Bildwiederholrate (60/120/144 Hz); Arbeit wird gedrosselt:
  // Render auf ~30 fps, NPC-Simulation auf ~20 fps (zeitskaliert), Minimap ~5 fps.
  function loop(ts) {
    rt.raf = requestAnimationFrame(loop);
    if (!ts) ts = performance.now();
    // NPC-Simulation gedrosselt, Bewegung zeit-skaliert → konstante Geschwindigkeit
    if (ts - rt.lastNpc >= NPC_MS - 1) {
      const mult = Math.min(4, (ts - rt.lastNpc) / SIM_STEP_MS);
      rt.lastNpc = ts;
      npcSystem.step(instances, defIndex, roadSet, mult, map?.islands);
    }
    // Render-Deckel
    if (ts - rt.lastRender >= RENDER_MS - 1) {
      rt.lastRender = ts;
      render();
    }
  }

  // ── Eingabe ──
  function onWheel(e) {
    e.preventDefault();
    const before = screenToWorld(e.offsetX, e.offsetY);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    camera.zoom = Math.min(2.5, Math.max(0.35, camera.zoom * factor));
    const after = screenToWorld(e.offsetX, e.offsetY);
    camera.x += before.x - after.x; // Zoom auf Cursor zentrieren
    camera.y += before.y - after.y;
  }
  // Gitterlinie (Bresenham) zwischen zwei Feldern
  function lineTiles(x0, y0, x1, y1) {
    const pts = [];
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy, x = x0, y = y0;
    for (let i = 0; i < 200; i++) {
      pts.push([x, y]);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return pts;
  }
  function tileRoadable(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= map.width || gy >= map.height) return false;
    if (erasing) return roadSet.has(`${gx},${gy}`);
    const t = map.legend[map.tiles[gy * map.width + gx]];
    // Alle Terrains bebaubar: Wasser=Brücke, Wald/Fels werden gerodet
    return !!t && !instanceAt(gx, gy) && !roadSet.has(`${gx},${gy}`);
  }
  // Beim Ziehen eine GERADE Linie vom Start zum aktuellen Feld aufbauen
  function roadLineTo(e) {
    const g = pointerToGrid(e.offsetX, e.offsetY);
    hover = g.gx >= 0 && g.gy >= 0 && g.gx < map.width && g.gy < map.height ? g : null;
    if (!roadStart) return;
    const ns = new Set();
    for (const [x, y] of lineTiles(roadStart.gx, roadStart.gy, g.gx, g.gy)) if (tileRoadable(x, y)) ns.add(`${x},${y}`);
    paintSet = ns;
  }
  // Deko-Malmodus (Freihand)
  function decoValid(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= map.width || gy >= map.height) return false;
    const key = `${gx},${gy}`;
    const t = map.legend[map.tiles[gy * map.width + gx]];
    if (erasing) return !!placed[key] || t === 'forest' || t === 'rock'; // entfernbar/rodbar
    return (t === 'grass' || t === 'sand') && !instanceAt(gx, gy) && !roadSet.has(key) && !placed[key];
  }
  function decoPaint(e) {
    const g = pointerToGrid(e.offsetX, e.offsetY);
    hover = g.gx >= 0 && g.gy >= 0 && g.gx < map.width && g.gy < map.height ? g : null;
    if (decoValid(g.gx, g.gy)) paintSet.add(`${g.gx},${g.gy}`);
  }
  // ── Zwei-Finger-Geste (Pinch-Zoom + Schwenk) ──
  function startPinch() {
    const pts = [...pointers.values()];
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    pinch = { dist: Math.hypot(dx, dy) || 1, cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
  }
  function onPointerDown(e) {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) {
      // Zweiter Finger → laufendes Malen/Schwenken abbrechen und Pinch beginnen
      painting = false; dragging = false; paintSet = new Set(); roadStart = null; erasing = false;
      dragMoved = true; // kein Tap nach der Geste
      startPinch();
      return;
    }
    if (pointers.size > 2) return;
    if (roadMode) {
      painting = true; erasing = e.button === 2;
      roadStart = pointerToGrid(e.offsetX, e.offsetY);
      paintSet = new Set(); roadLineTo(e);
      return;
    }
    if (decoType) {
      painting = true; erasing = e.button === 2;
      paintSet = new Set(); decoPaint(e);
      return;
    }
    dragging = true;
    dragMoved = false;
    lastPointer = { x: e.offsetX, y: e.offsetY };
  }
  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && pointers.size >= 2) {
      const pts = [...pointers.values()];
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      const dist = Math.hypot(dx, dy) || 1;
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      const before = screenToWorld(cx, cy);
      camera.zoom = Math.min(2.5, Math.max(0.35, camera.zoom * (dist / pinch.dist)));
      const after = screenToWorld(cx, cy);
      camera.x += before.x - after.x; // Zoom um den Gesten-Mittelpunkt
      camera.y += before.y - after.y;
      camera.x -= (cx - pinch.cx) / camera.zoom; // Schwenk mit dem Mittelpunkt
      camera.y -= (cy - pinch.cy) / camera.zoom;
      pinch = { dist, cx, cy };
      hover = null;
      return;
    }
    if (painting) {
      if (roadMode) roadLineTo(e); else decoPaint(e);
      return;
    }
    if (dragging) {
      const dx = e.offsetX - lastPointer.x;
      const dy = e.offsetY - lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
      camera.x -= dx / camera.zoom;
      camera.y -= dy / camera.zoom;
      lastPointer = { x: e.offsetX, y: e.offsetY };
    }
    const g = pointerToGrid(e.offsetX, e.offsetY);
    hover = g.gx >= 0 && g.gy >= 0 && g.gx < map.width && g.gy < map.height ? g : null;
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) { // verbleibenden Finger als neuen Schwenk-Anker (kein Sprung, kein Tap)
        const [p] = [...pointers.values()];
        lastPointer = { x: p.x, y: p.y }; dragging = true; dragMoved = true;
      }
      return;
    }
    if (painting) {
      painting = false;
      const tiles = [...paintSet].map((k) => { const c = k.indexOf(','); return { x: +k.slice(0, c), y: +k.slice(c + 1) }; });
      const wasErasing = erasing;
      const wasRoad = roadMode;
      paintSet = new Set();
      erasing = false;
      roadStart = null;
      if (tiles.length) {
        if (wasRoad) dispatch('road', { tiles, on: !wasErasing });
        else dispatch('deco', { tiles, type: decoType, on: !wasErasing });
      }
      return;
    }
    dragging = false;
    if (dragMoved) return; // war ein Schwenk, kein Klick
    const g = pointerToGrid(e.offsetX, e.offsetY);
    if (g.gx < 0 || g.gy < 0 || g.gx >= map.width || g.gy >= map.height) return;
    if (buildDef) {
      const check = canPlaceClient(map, instances, defIndex, buildDef, g.gx, g.gy, buildRot);
      dispatch('place', { buildingId: buildDef.id, x: g.gx, y: g.gy, rot: buildRot, ok: check.ok, reason: check.reason });
    } else {
      const inst = instanceAt(g.gx, g.gy);
      dispatch('select', { instance: inst, tile: g, terrain: map.legend[map.tiles[g.gy * map.width + g.gx]] });
    }
  }

  function resize() {
    if (!wrap) return;
    viewW = wrap.clientWidth;
    viewH = wrap.clientHeight;
    canvas.width = viewW;
    canvas.height = viewH;
  }

  function centerOnSettlement() {
    // Kamera auf den Schwerpunkt der Gebäude (oder Kartenmitte) setzen
    const done = instances.filter((i) => i.done);
    let gx = map.width / 2,
      gy = map.height / 2;
    if (done.length) {
      gx = done.reduce((s, i) => s + i.x, 0) / done.length;
      gy = done.reduce((s, i) => s + i.y, 0) / done.length;
    }
    const p = project(gx, gy);
    camera.x = p.x;
    camera.y = p.y;
  }

  export function recenter() {
    centerOnSettlement();
  }
  export function focusIsland(id) {
    const isl = (map?.islands || []).find((i) => i.id === id);
    if (!isl) return;
    const p = project(isl.x + Math.floor(isl.w / 2), isl.y + Math.floor(isl.h / 2));
    camera.x = p.x; camera.y = p.y;
  }
  export function rotateView() {
    viewRot = (viewRot + 1) % 4;
    centerOnSettlement(); // Siedlung nach dem Drehen wieder zentrieren
  }

  onMount(() => {
    ctx = canvas.getContext('2d');
    if (miniCanvas) miniCtx = miniCanvas.getContext('2d');
    resize();
    buildTerrain();
    centerOnSettlement();
    window.addEventListener('resize', resize);
    rt.lastNpc = rt.lastRender = performance.now();
    loop();
  });
  onDestroy(() => {
    cancelAnimationFrame(rt.raf);
    window.removeEventListener('resize', resize);
  });

  // Terrain nur backen, wenn eine WIRKLICH neue Karte eintrifft (nicht pro Frame)
  $: if (map && ctx) {
    const sig = `${map.width}x${map.height}:${map.version ?? map.seed ?? map.tiles?.length}:${viewRot}:${cleared.length}:${JSON.stringify(placed)}`;
    if (sig !== _terrainSig) { _terrainSig = sig; buildTerrain(); bakeMini(); _roadsSig = null; _decoSig = null; }
  }
  // Deko neu backen, wenn sich placed/cleared oder die Karte ändern
  $: if (ctx && terrainBaked) {
    const sig = JSON.stringify(placed) + '|' + cleared.join(',') + '|' + (map?.version ?? 0) + '|' + viewRot;
    if (sig !== _decoSig) { _decoSig = sig; bakeDeco(); }
  }
  // Straßen offscreen neu backen — nur wenn sich das Netz WIRKLICH ändert.
  // (Die Komponente kann pro Frame invalidiert werden; ohne diesen Guard würde
  //  sonst jedes Frame ein großes Offscreen-Canvas neu alloziert → Latenz/GC.)
  $: if (ctx && terrainBaked) {
    const sig = roads.length + '#' + roads.join(',') + '|' + viewRot;
    if (sig !== _roadsSig) { _roadsSig = sig; buildRoadsCanvas(); }
  }
  // NPC-Anzahl an Bevölkerung/Gebäude koppeln
  $: npcSystem.sync(population, instances, defIndex, map?.islands);
</script>

<div
  class="absolute inset-0 overflow-hidden {buildDef || roadMode || decoType ? 'cursor-crosshair' : dragging ? 'cursor-grabbing' : 'cursor-grab'}"
  bind:this={wrap}
>
  <canvas
    bind:this={canvas}
    class="touch-none"
    on:wheel={onWheel}
    on:pointerdown={onPointerDown}
    on:pointermove={onPointerMove}
    on:pointerup={onPointerUp}
    on:pointercancel={onPointerUp}
    on:pointerleave={(e) => {
      if (pointers.size > 1) return; // Multi-Touch nicht durch einen verlassenden Finger stören
      if (painting) onPointerUp(e);
      pointers.delete(e.pointerId);
      dragging = false;
      hover = null;
    }}
  ></canvas>

  <!-- Minimap unten rechts -->
  {#if map}
    <div class="absolute bottom-3 right-3 z-20 rounded border border-stone-600 bg-stone-950/80 p-1 shadow-lg" title="Minimap — Klick springt">
      <canvas
        bind:this={miniCanvas}
        width={map.width * MINI}
        height={map.height * MINI}
        class="block cursor-pointer"
        style="width:{miniDisp}px;height:{miniDisp}px"
        on:click={onMiniClick}
      ></canvas>
    </div>
  {/if}
</div>
