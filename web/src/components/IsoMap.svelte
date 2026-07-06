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

  $: roadSet = new Set(roads);
  let painting = false;
  let erasing = false; // Straßen-Abriss-Modus (Rechtsklick)
  let roadStart = null; // Startfeld beim Ziehen einer geraden Straße
  let paintSet = new Set(); // während des Ziehens bearbeitete Felder (Vorschau)
  let roadsCanvas = null; // Straßen offscreen gebacken (nur bei Änderung neu)
  let terrainW = 0, terrainH = 0;
  let _terrainSig = null, _roadsSig = null; // Signaturen: nur bei echter Änderung neu backen
  // Minimap
  const MINI = 3;
  let miniCanvas, miniCtx, miniTerrain = null;

  const dispatch = createEventDispatcher();

  let canvas, ctx, wrap;
  let viewW = 800,
    viewH = 600;
  const camera = { x: 0, y: 0, zoom: 1 };
  let hover = null; // {gx, gy}
  let dragging = false;
  let dragMoved = false;
  let lastPointer = { x: 0, y: 0 };
  let terrainCanvas = null;
  let terrainOff = { x: 0, y: 0 };
  const npcSystem = createNpcSystem();

  // ── Terrain einmalig in einen Offscreen-Canvas rendern (statisch) ──
  function buildTerrain() {
    if (!map) return;
    const off = { x: map.height * (TILE_W / 2) + TILE_W, y: TILE_H * 3 };
    terrainOff = off;
    const w = (map.width + map.height) * (TILE_W / 2) + TILE_W * 2;
    const h = (map.width + map.height) * (TILE_H / 2) + TILE_H * 6;
    terrainW = w; terrainH = h;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const isWater = (x, y) => (x < 0 || y < 0 || x >= map.width || y >= map.height ? true : map.legend[map.tiles[y * map.width + x]] === 'water');
    // Hinten nach vorne (Painter): Zeilenweise gx+gy aufsteigend ist automatisch korrekt
    for (let gy = 0; gy < map.height; gy++) {
      for (let gx = 0; gx < map.width; gx++) {
        const t = map.legend[map.tiles[gy * map.width + gx]];
        const col = TERRAIN_COLORS[t] || TERRAIN_COLORS.grass;
        drawTile(g, gx, gy, t, col, off, isWater);
        // Deko: Bäume auf Wald, Felsbrocken auf Fels (deterministisch, statisch mitgebacken)
        if (t === 'forest' || t === 'rock') {
          const sc = gridToScreen(gx, gy);
          const px = sc.x + off.x;
          const py = sc.y + off.y - col.h;
          const jx = (tileRand(gx, gy, 1) - 0.5) * TILE_W * 0.3;
          const jy = (tileRand(gx, gy, 2) - 0.5) * TILE_H * 0.3;
          const r = 0.85 + tileRand(gx, gy, 3) * 0.4;
          const seed = Math.floor(tileRand(gx, gy, 5) * 100000);
          if (t === 'forest') drawTree(g, px + jx, py + jy, r, seed);
          else if (tileRand(gx, gy, 4) > 0.35) drawRock(g, px + jx, py + jy, r, seed);
        }
      }
    }
    terrainCanvas = c;
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
  function pointerToGrid(sx, sy) {
    const w = screenToWorld(sx, sy);
    return screenToGrid(w.x, w.y);
  }
  // Grobes Viewport-Culling anhand des Tile-Mittelpunkts
  function inViewport(gx, gy, margin) {
    const wpt = gridToScreen(gx, gy);
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
  const rt = { now: 0, amb: { sun: 1, night: 0, golden: 0 }, raf: 0 };
  function render() {
    if (!ctx) return;
    rt.now = performance.now();
    rt.amb = ambient(rt.now);
    const amb = rt.amb, now = rt.now;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    // Himmel-Verlauf, tageszeitabhängig
    const grd = ctx.createLinearGradient(0, 0, 0, viewH);
    grd.addColorStop(0, `rgb(${mix(26, 8, amb.night)}, ${mix(42, 14, amb.night)}, ${mix(58, 34, amb.night)})`);
    grd.addColorStop(1, `rgb(${mix(12, 4, amb.night)}, ${mix(22, 8, amb.night)}, ${mix(32, 18, amb.night)})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.translate(viewW / 2, viewH / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    if (terrainCanvas) ctx.drawImage(terrainCanvas, -terrainOff.x, -terrainOff.y);
    if (roadsCanvas) ctx.drawImage(roadsCanvas, -terrainOff.x, -terrainOff.y);
    if (paintSet.size) drawRoadPreview();

    // Hover-/Bau-Vorschau
    if (hover) {
      if (buildDef) {
        const { w, h } = footprintOf(buildDef, buildRot);
        const check = canPlaceClient(map, instances, defIndex, buildDef, hover.gx, hover.gy, buildRot);
        ctx.fillStyle = check.ok ? 'rgba(80,220,120,0.5)' : 'rgba(230,80,80,0.5)';
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) fillDiamond(hover.gx + dx, hover.gy + dy);
        }
        drawBuildingSprite(ctx, {
          def: buildDef, gx: hover.gx, gy: hover.gy, w, h, rot: buildRot,
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
      const { w, h } = footprintOf(def || {}, inst.rot ?? 0);
      if (!inViewport(inst.x + (w - 1) / 2, inst.y + (h - 1) / 2, 220)) continue;
      drawables.push({ depth: inst.x + inst.y + (w + h) / 2, kind: 'building', inst, def });
    }
    for (const n of npcs) { if (inViewport(n.x, n.y, 40)) drawables.push({ depth: n.x + n.y, kind: 'npc', n }); }
    drawables.sort((a, b) => a.depth - b.depth);

    for (const d of drawables) {
      if (d.kind === 'building') drawBuilding(d.inst, d.def);
      else drawNpc(d.n);
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
    drawMini();
  }

  // Mittelpunkt eines Gebäudes (leicht angehoben, damit Linien am Körper andocken)
  function centerOf(inst) {
    const { w, h } = footprintOf(defIndex[inst.buildingId] || {}, inst.rot ?? 0);
    const c = gridToScreen(inst.x + (w - 1) / 2, inst.y + (h - 1) / 2);
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
    const pts = tileDiamond(gx, gy);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
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
  // Straßen einmal offscreen backen (nur wenn sich das Netz ändert)
  function buildRoadsCanvas() {
    if (!map || !terrainW) return;
    const c = document.createElement('canvas');
    c.width = terrainW; c.height = terrainH;
    const g = c.getContext('2d');
    for (const key of roadSet) {
      const ci = key.indexOf(',');
      const p = gridToScreen(+key.slice(0, ci), +key.slice(ci + 1));
      drawRoadShape(g, p.x + terrainOff.x, p.y + terrainOff.y, null);
    }
    roadsCanvas = c;
  }
  // Live-Vorschau der gerade gemalten/gelöschten Felder (nur während des Ziehens)
  function drawRoadPreview() {
    for (const key of paintSet) {
      const ci = key.indexOf(',');
      const p = gridToScreen(+key.slice(0, ci), +key.slice(ci + 1));
      drawRoadShape(ctx, p.x, p.y, erasing ? 'erase' : 'preview');
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
    const gx = (e.clientX - rect.left) / MINI, gy = (e.clientY - rect.top) / MINI;
    const p = gridToScreen(gx, gy);
    camera.x = p.x; camera.y = p.y;
  }

  function drawBuilding(inst, def) {
    const rot = inst.rot ?? 0;
    const { w, h } = footprintOf(def || {}, rot);
    const eo = epochIndex[def?.epoch] ?? 0;
    if (!inst.done) {
      const buildTime = def?.buildTimeTicks ?? 1;
      const progress = 1 - Math.min(1, (inst.ticksLeft ?? 0) / Math.max(1, buildTime));
      drawBuildingSprite(ctx, { def: def || {}, gx: inst.x, gy: inst.y, w, h, rot, done: false, progress, time: rt.now });
      return;
    }
    // Fertige Gebäude: gecachtes Bitmap blitten + nur animierte Teile darüber
    const s = getBuildingSprite(def || {}, eo, w, h, rot);
    const o = gridToScreen(inst.x, inst.y);
    ctx.drawImage(s.bitmap || s.canvas, o.x - s.ax, o.y - s.ay);
    drawBuildingFX(ctx, def || {}, inst.x, inst.y, w, h, eo, rt.now, inst.id, rt.amb.night);
  }

  function drawNpc(n) {
    const c = gridToScreen(n.x, n.y);
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
  function loop() {
    npcSystem.step(instances, defIndex, roadSet);
    render();
    rt.raf = requestAnimationFrame(loop);
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
    return (t === 'grass' || t === 'sand') && !instanceAt(gx, gy) && !roadSet.has(`${gx},${gy}`);
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
  function onPointerDown(e) {
    if (roadMode) {
      painting = true; erasing = e.button === 2;
      roadStart = pointerToGrid(e.offsetX, e.offsetY);
      paintSet = new Set(); roadLineTo(e);
      return;
    }
    dragging = true;
    dragMoved = false;
    lastPointer = { x: e.offsetX, y: e.offsetY };
  }
  function onPointerMove(e) {
    if (painting) {
      roadLineTo(e);
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
    if (painting) {
      painting = false;
      const tiles = [...paintSet].map((k) => { const c = k.indexOf(','); return { x: +k.slice(0, c), y: +k.slice(c + 1) }; });
      const wasErasing = erasing;
      paintSet = new Set();
      erasing = false;
      roadStart = null;
      if (tiles.length) dispatch('road', { tiles, on: !wasErasing });
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
    const p = gridToScreen(gx, gy);
    camera.x = p.x;
    camera.y = p.y;
  }

  export function recenter() {
    centerOnSettlement();
  }

  onMount(() => {
    ctx = canvas.getContext('2d');
    if (miniCanvas) miniCtx = miniCanvas.getContext('2d');
    resize();
    buildTerrain();
    centerOnSettlement();
    window.addEventListener('resize', resize);
    loop();
  });
  onDestroy(() => {
    cancelAnimationFrame(rt.raf);
    window.removeEventListener('resize', resize);
  });

  // Terrain nur backen, wenn eine WIRKLICH neue Karte eintrifft (nicht pro Frame)
  $: if (map && ctx) {
    const sig = `${map.width}x${map.height}:${map.version ?? map.seed ?? map.tiles?.length}`;
    if (sig !== _terrainSig) { _terrainSig = sig; buildTerrain(); bakeMini(); _roadsSig = null; }
  }
  // Straßen offscreen neu backen — nur wenn sich das Netz WIRKLICH ändert.
  // (Die Komponente kann pro Frame invalidiert werden; ohne diesen Guard würde
  //  sonst jedes Frame ein großes Offscreen-Canvas neu alloziert → Latenz/GC.)
  $: if (ctx && terrainW) {
    const sig = roads.length + '#' + roads.join(',');
    if (sig !== _roadsSig) { _roadsSig = sig; buildRoadsCanvas(); }
  }
  // NPC-Anzahl an Bevölkerung/Gebäude koppeln
  $: npcSystem.sync(population, instances, defIndex);
</script>

<div
  class="absolute inset-0 overflow-hidden {buildDef || roadMode ? 'cursor-crosshair' : dragging ? 'cursor-grabbing' : 'cursor-grab'}"
  bind:this={wrap}
>
  <canvas
    bind:this={canvas}
    on:wheel={onWheel}
    on:pointerdown={onPointerDown}
    on:pointermove={onPointerMove}
    on:pointerup={onPointerUp}
    on:pointerleave={(e) => {
      if (painting) onPointerUp(e);
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
        on:click={onMiniClick}
      ></canvas>
    </div>
  {/if}
</div>
