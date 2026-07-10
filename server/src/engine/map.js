// Prozedurale Insel-Karte + Platzierungsregeln.
// Terrain wird einmalig seeded generiert und in der DB persistiert; Gebäude
// werden als Instanzen mit Koordinaten platziert (Anno-Prinzip: Terrain zählt).

export const TERRAIN = {
  W: 'water',
  S: 'sand',
  G: 'grass',
  F: 'forest',
  R: 'rock',
};
export const TERRAIN_CODES = Object.fromEntries(Object.entries(TERRAIN).map(([k, v]) => [v, k]));

// Auf diesen Terrains darf standardmäßig gebaut werden
const DEFAULT_BUILDABLE = ['grass'];

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Einfaches Value-Noise mit bilinearer Interpolation. */
function makeNoise(rand, gridSize) {
  const g = [];
  for (let i = 0; i < (gridSize + 2) * (gridSize + 2); i++) g.push(rand());
  const lerp = (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t));
  return (u, v) => {
    const x = u * gridSize;
    const y = v * gridSize;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const idx = (ix, iy) => g[iy * (gridSize + 2) + ix];
    return lerp(lerp(idx(xi, yi), idx(xi + 1, yi), xf), lerp(idx(xi, yi + 1), idx(xi + 1, yi + 1), xf), yf);
  };
}

/**
 * Generiert eine Insel: Wasser außen, Sandküste, Gras, Wald- und Felscluster.
 * @returns {{seed:number, width:number, height:number, tiles:string}}
 */
export function generateMap(seed, width = 48, height = 48) {
  const rand = mulberry32(seed);
  const elevation = makeNoise(rand, 6);
  const forest = makeNoise(rand, 8);
  const rock = makeNoise(rand, 9);

  let tiles = '';
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const h = elevation(x / width, y / height) * 0.55 + (1 - dist * 1.15) * 0.6;
      if (h < 0.32) tiles += 'W';
      else if (h < 0.38) tiles += 'S';
      else if (forest(x / width, y / height) > 0.62) tiles += 'F';
      else if (rock(x / width, y / height) > 0.72) tiles += 'R';
      else tiles += 'G';
    }
  }

  const arr = tiles.split('');

  // Flüsse: 1-2 schmale, mäandernde Wasserläufe quer über die Insel (Brücken nötig)
  const rivers = 1 + Math.floor(rand() * 2);
  for (let r = 0; r < rivers; r++) {
    const horizontal = rand() < 0.5;
    const dir = rand() < 0.5 ? -1 : 1;
    let px = horizontal ? Math.floor(cx) : Math.floor(rand() * width);
    let py = horizontal ? Math.floor(rand() * height) : Math.floor(cy);
    for (let step = 0; step < Math.max(width, height) * 1.6; step++) {
      if (px < 0 || py < 0 || px >= width || py >= height) break;
      arr[py * width + px] = 'W';
      if (rand() < 0.35 && px + 1 < width) arr[py * width + px + 1] = 'W'; // leichte Breite
      if (horizontal) { px += dir; if (rand() < 0.4) py += rand() < 0.5 ? -1 : 1; }
      else { py += dir; if (rand() < 0.4) px += rand() < 0.5 ? -1 : 1; }
    }
  }

  // Startbereich in der Mitte freiräumen, damit die erste Siedlung Platz hat
  for (let y = Math.floor(cy) - 3; y <= Math.floor(cy) + 3; y++) {
    for (let x = Math.floor(cx) - 3; x <= Math.floor(cx) + 3; x++) {
      if (arr[y * width + x] !== 'W') arr[y * width + x] = 'G';
    }
  }
  return { seed, width, height, tiles: arr.join('') };
}

/**
 * Lässt die Insel um einen Ring wachsen: Küsten-Wasser wird zu Sand, und
 * Sand, das dadurch kein Wasser mehr berührt, wird zu Gras (mehr Baufläche).
 * @returns {string} neue tiles-Zeichenkette
 */
export function growIsland(tiles, width, height) {
  const arr = tiles.split('');
  const at = (a, x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 'W' : a[y * width + x]);
  const next = arr.slice();
  // Pass 1: Wasser mit Land-Nachbar → Sand
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (arr[y * width + x] !== 'W') continue;
    if (at(arr, x - 1, y) !== 'W' || at(arr, x + 1, y) !== 'W' || at(arr, x, y - 1) !== 'W' || at(arr, x, y + 1) !== 'W') next[y * width + x] = 'S';
  }
  // Pass 2: bisheriges Sand ohne Wasser-Nachbar → Gras
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (arr[y * width + x] !== 'S') continue;
    if (at(next, x - 1, y) !== 'W' && at(next, x + 1, y) !== 'W' && at(next, x, y - 1) !== 'W' && at(next, x, y + 1) !== 'W') next[y * width + x] = 'G';
  }
  return next.join('');
}

/**
 * Vergrößert das GESAMTE Spielfeld um `grow` Felder (Wasserring rundum) und
 * verschiebt alle Inhalte zentriert, sodass die Insel stets von Wasser umgeben
 * bleibt. Danach wächst die Insel um einen Ring. Mutiert state.
 */
export function growWorld(state, grow = 8) {
  const N = state.map.width;
  const N2 = N + grow, off = grow >> 1;
  const old = state.map.tiles;
  const arr = new Array(N2 * N2).fill('W');
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) arr[(y + off) * N2 + (x + off)] = old[y * N + x];
  state.map.tiles = growIsland(arr.join(''), N2, N2);
  state.map.width = N2; state.map.height = N2;
  const shift = (k) => { const c = k.indexOf(','); return `${+k.slice(0, c) + off},${+k.slice(c + 1) + off}`; };
  for (const inst of state.instances || []) { inst.x += off; inst.y += off; }
  state.roads = new Set([...(state.roads || [])].map(shift));
  state.cleared = new Set([...(state.cleared || [])].map(shift));
  const np = {}; for (const [k, v] of Object.entries(state.placed || {})) np[shift(k)] = v;
  state.placed = np;
  state.mapVersion = (state.mapVersion || 0) + 1;
  return { width: N2, height: N2, offset: off };
}

/** Land-Feld am äußeren Rand? (dann fehlt der Wasser-Rand → Spielfeld wachsen lassen) */
export function landTouchesBorder(map, margin = 1) {
  const { width: W, height: H, tiles } = map;
  for (let x = 0; x < W; x++) for (let m = 0; m < margin; m++) {
    if (tiles[m * W + x] !== 'W' || tiles[(H - 1 - m) * W + x] !== 'W') return true;
  }
  for (let y = 0; y < H; y++) for (let m = 0; m < margin; m++) {
    if (tiles[y * W + m] !== 'W' || tiles[y * W + (W - 1 - m)] !== 'W') return true;
  }
  return false;
}

export const inBounds = (map, x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height;
export const terrainAt = (map, x, y) => (inBounds(map, x, y) ? TERRAIN[map.tiles[y * map.width + x]] : null);

const isCleared = (state, key) => {
  const c = state?.cleared;
  return c instanceof Set ? c.has(key) : Array.isArray(c) ? c.includes(key) : false;
};

/**
 * Für Bebaubarkeit & Nachbarschaft relevantes Terrain unter Berücksichtigung der
 * Deko-Features: platzierte Bäume zählen als 'forest', platzierte Felsen als 'rock';
 * gerodeter (cleared) Wald/Fels zählt als 'grass' und wird dadurch bebaubar.
 */
export function effectiveTerrain(map, state, x, y) {
  if (!inBounds(map, x, y)) return null;
  const key = `${x},${y}`;
  const placed = state?.placed?.[key];
  if (placed === 'tree') return 'forest';
  if (placed === 'rock') return 'rock';
  const t = terrainAt(map, x, y);
  if ((t === 'forest' || t === 'rock') && isCleared(state, key)) return 'grass';
  return t;
}

/** Grundfläche eines Gebäudes, um `rot` (0-3) gedreht (ungerade rot tauscht w/h). */
export function footprintOf(def, rot = 0) {
  const w = def.placement?.size?.w ?? 1;
  const h = def.placement?.size?.h ?? 1;
  return rot % 2 ? { w: h, h: w } : { w, h };
}

/** Set aller von Instanzen belegten Tiles ("x,y"). */
export function occupiedTiles(state, registry) {
  const occ = new Set();
  for (const inst of state.instances || []) {
    const def = registry.buildings.get(inst.buildingId);
    const { w, h } = def ? footprintOf(def, inst.rot ?? 0) : { w: 1, h: 1 };
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) occ.add(`${inst.x + dx},${inst.y + dy}`);
  }
  return occ;
}

/**
 * Prüft, ob ein Gebäude an (x,y) platziert werden darf.
 * Regeln: im Kartenbereich, erlaubtes Terrain, Tiles frei, geforderte
 * Nachbar-Terrains im 8er-Ring um den Footprint vorhanden.
 * @returns {{ok: boolean, reason?: string}}
 */
export function canPlace(map, state, registry, def, x, y, rot = 0) {
  const { w, h } = footprintOf(def, rot);
  const allowed = def.placement?.terrain ?? DEFAULT_BUILDABLE;
  // Optionale Territoriums-Beschränkung (Mehr-Insel-Welt): gesetzt = nur im
  // eigenen Insel-Rechteck baubar. Ohne region unverändertes Verhalten.
  const region = state?.region;

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (!inBounds(map, x + dx, y + dy)) return { ok: false, reason: 'außerhalb der Karte' };
      if (region && (x + dx < region.x || y + dy < region.y || x + dx >= region.x + region.w || y + dy >= region.y + region.h))
        return { ok: false, reason: 'außerhalb des eigenen Territoriums' };
      const t = effectiveTerrain(map, state, x + dx, y + dy);
      // Wald/Fels darf von normalen Gebäuden (die Gras/Sand nutzen) gerodet werden
      const clearable = (t === 'forest' || t === 'rock') && (allowed.includes('grass') || allowed.includes('sand'));
      if (!allowed.includes(t) && !clearable) return { ok: false, reason: `Terrain '${t}' nicht bebaubar (braucht: ${allowed.join('/')})` };
    }
  }

  const occ = occupiedTiles(state, registry);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (occ.has(`${x + dx},${y + dy}`)) return { ok: false, reason: 'Feld ist bereits bebaut' };
    }
  }

  for (const [terrain, need] of Object.entries(def.placement?.adjacent || {})) {
    let found = 0;
    for (let dy = -1; dy <= h; dy++) {
      for (let dx = -1; dx <= w; dx++) {
        if (dx >= 0 && dx < w && dy >= 0 && dy < h) continue; // Footprint selbst
        if (effectiveTerrain(map, state, x + dx, y + dy) === terrain) found++;
      }
    }
    if (found < need) return { ok: false, reason: `braucht ${need}× '${terrain}' angrenzend (gefunden: ${found})` };
  }

  return { ok: true };
}

// ── Straßen (Infrastruktur) ─────────────────────────────────────────────────
// Straßen dürfen auf Wasser (=Brücke) sowie auf Wald/Fels (rodet sie) gebaut werden.
const ROAD_TERRAIN = ['grass', 'sand', 'water', 'forest', 'rock'];

/** Setzt/entfernt eine Straße auf (x,y). state.roads ist ein Set aus "x,y". */
export function setRoad(map, state, registry, x, y, on) {
  if (!inBounds(map, x, y)) throw new Error('außerhalb der Karte');
  state.roads ??= new Set();
  const key = `${x},${y}`;
  if (!on) { state.roads.delete(key); return { x, y, on: false }; }
  const t = terrainAt(map, x, y);
  if (!ROAD_TERRAIN.includes(t)) throw new Error(`Straße nur auf ${ROAD_TERRAIN.join('/')} (hier: ${t})`);
  if (occupiedTiles(state, registry).has(key)) throw new Error('Feld ist bebaut');
  state.roads.add(key);
  if (state.placed && state.placed[key]) delete state.placed[key]; // Straße räumt platzierte Deko
  if (t === 'forest' || t === 'rock') { state.cleared ??= new Set(); state.cleared.add(key); } // rodet Wald/Fels
  return { x, y, on: true };
}

// Bäume/Felsen platzieren (Deko-Layer). type: 'tree' | 'rock'.
export function setDeco(map, state, registry, x, y, type, on) {
  if (!inBounds(map, x, y)) throw new Error('außerhalb der Karte');
  state.placed ??= {};
  state.cleared ??= new Set();
  const key = `${x},${y}`;
  const raw = terrainAt(map, x, y);
  if (!on) {
    if (state.placed[key]) { delete state.placed[key]; return { x, y, on: false }; }
    if (raw === 'forest' || raw === 'rock') { state.cleared.add(key); return { x, y, on: false, cleared: true }; }
    return { x, y, on: false };
  }
  if (raw !== 'grass' && raw !== 'sand') throw new Error('Bäume/Felsen nur auf Wiese/Sand');
  if (state.roads?.has(key)) throw new Error('Feld ist eine Straße');
  if (occupiedTiles(state, registry).has(key)) throw new Error('Feld ist bebaut');
  state.placed[key] = type === 'rock' ? 'rock' : 'tree';
  return { x, y, on: true, type: state.placed[key] };
}

/** Ist ein Gebäude an ein Straßenfeld angebunden (4er-Nachbarschaft des Footprints)? */
export function isRoadConnected(state, registry, inst) {
  const roads = state.roads;
  if (!roads || roads.size === 0) return false;
  const def = registry.buildings.get(inst.buildingId);
  const { w, h } = def ? footprintOf(def, inst.rot ?? 0) : { w: 1, h: 1 };
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const x = inst.x + dx, y = inst.y + dy;
      if (roads.has(`${x - 1},${y}`) || roads.has(`${x + 1},${y}`) || roads.has(`${x},${y - 1}`) || roads.has(`${x},${y + 1}`)) return true;
    }
  }
  return false;
}

/** Logistik-Abdeckung 0..1 = Anteil fertiger Gebäude mit Straßenanschluss. */
export function roadCoverage(state, registry) {
  const insts = (state.instances || []).filter((i) => i.counted);
  if (!insts.length || !state.roads?.size) return 0;
  let connected = 0;
  for (const i of insts) if (isRoadConnected(state, registry, i)) connected++;
  return connected / insts.length;
}

/** Findet freien, gültigen Platz spiralförmig um (cx,cy) — Standard: Kartenmitte.
 *  Respektiert state.region (Territorium), sodass die Suche auf der eigenen Insel bleibt. */
export function findFreeSpot(map, state, registry, def, cx = Math.floor(map.width / 2), cy = Math.floor(map.height / 2)) {
  for (let r = 0; r < Math.max(map.width, map.height); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const check = canPlace(map, state, registry, def, cx + dx, cy + dy);
        if (check.ok) return { x: cx + dx, y: cy + dy };
      }
    }
  }
  return null;
}
