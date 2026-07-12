// M1 der Multiplayer-Roadmap: Insel-Export für das Online-Repo.
// Baut island.json (Region-Ausschnitt, relative Koordinaten) und packs.json
// (eigene KI-Packs, IDs mit gh-<user>-- genamespaced, Sprite-Farben eingefroren).
// Reine Funktionen — der Upload passiert in github.js.

// ── Farb-Logik 1:1 aus web/src/lib/sprites.js (eingefroren = reproduzierbar) ──
const hexToRgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const shade = (hex, f) => { const { r, g, b } = hexToRgb(hex); return rgbToHex(r * f, g * f, b * f); };
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const MATERIALS = [
  { wall: '#b98a56', roof: '#8a9a44' }, { wall: '#caa76f', roof: '#b0623a' },
  { wall: '#b7b0a2', roof: '#9a4a3c' }, { wall: '#c9c4bb', roof: '#7d5230' },
  { wall: '#a9b3bd', roof: '#5f6b74' }, { wall: '#c8cdd4', roof: '#4a6b8a' },
];
/** Identisch zu paletteFor() im Client — MIT der Original-ID aufrufen! */
function frozenArt(def, epochOrder) {
  const h = hashStr(def.id || 'x');
  const base = MATERIALS[Math.max(0, Math.min(MATERIALS.length - 1, epochOrder))];
  const art = def.meta?.art || {};
  return {
    ...art,
    wall: art.wall || shade(base.wall, 0.9 + ((h >> 3) & 15) / 60),
    roof: art.roof || shade(base.roof, 0.85 + ((h >> 7) & 15) / 50),
    accent: art.accent || hslHex(h % 360, 55, 55),
    seed: art.seed ?? h,
  };
}

/** Namespace-Präfix — global eindeutig, weil GitHub-Namen eindeutig sind. */
export const nsPrefix = (user) => `gh-${user.toLowerCase()}--`;

/**
 * Ersetzt in einem beliebigen JSON-Wert alle Strings und Objekt-Schlüssel,
 * die EXAKT einer bekannten Content-ID entsprechen (cost/inputs/outputs sind
 * nach Ressourcen-IDs geschlüsselt — deshalb auch die Keys).
 */
function namespaceValue(v, idSet, prefix) {
  if (typeof v === 'string') return idSet.has(v) ? prefix + v : v;
  if (Array.isArray(v)) return v.map((x) => namespaceValue(x, idSet, prefix));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[idSet.has(k) ? prefix + k : k] = namespaceValue(val, idSet, prefix);
    return out;
  }
  return v;
}

/** IDs aller aktiven KI-Packs (nur die werden genamespaced — Basis-Content teilen alle Spiele). */
function aiContentIds(registry) {
  const aiPacks = new Set(registry.packs.filter((p) => p.source === 'ai').map((p) => p.id));
  const ids = new Set();
  for (const b of registry.buildings.values()) if (aiPacks.has(b._pack)) ids.add(b.id);
  for (const r of registry.resources.values()) if (aiPacks.has(r._pack)) ids.add(r.id);
  for (const e of registry.epochs.values()) if (aiPacks.has(e._pack)) ids.add(e.id);
  return { ids, aiPacks };
}

/** island.json (Schema v1 des Online-Repos) aus dem eigenen Spielstand. */
export function buildIslandExport(ctx, user) {
  const p = ctx.human;
  const world = ctx.world;
  const r = p.region || { x: 0, y: 0, w: world.width, h: world.height };
  if (r.w > 128 || r.h > 128) throw new Error(`Insel ${r.w}×${r.h} übersteigt das Schema-Limit (128)`);

  // Region-Ausschnitt der Weltkarte (Zeichen W/G/S/F/R wie im Schema)
  let tiles = '';
  for (let y = r.y; y < r.y + r.h; y++) tiles += world.tiles.slice(y * world.width + r.x, y * world.width + r.x + r.w);

  const { ids } = aiContentIds(ctx.registryHolder.registry);
  const prefix = nsPrefix(user);
  const inRegion = (x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

  const instances = (p.instances || [])
    .filter((i) => i.counted && inRegion(i.x, i.y)) // counted = fertig gebaut (Engine-Feld; "done" existiert nur in der API-Sicht)
    .map((i) => ({
      buildingId: ids.has(i.buildingId) ? prefix + i.buildingId : i.buildingId,
      x: i.x - r.x, y: i.y - r.y, ...(i.rot ? { rot: i.rot } : {}),
    }));

  const roads = [...(p.roads || [])]
    .map((k) => { const c = k.indexOf(','); return [+k.slice(0, c), +k.slice(c + 1)]; })
    .filter(([x, y]) => inRegion(x, y))
    .map(([x, y]) => `${x - r.x},${y - r.y}`);

  return {
    version: 1,
    owner: user,
    name: `Insel von ${user}`,
    epoch: ids.has(p.epochId) ? prefix + p.epochId : p.epochId,
    population: Math.floor(p.population || 0),
    exportedAt: new Date().toISOString(),
    map: { width: r.w, height: r.h, tiles },
    instances,
    roads,
  };
}

/**
 * packs.json: alle aktiven KI-Packs, IDs genamespaced, Sprite-Farben mit der
 * ORIGINAL-ID eingefroren (sonst ändert der neue Hash die Optik beim Nachbarn).
 */
export function buildPacksExport(ctx, user) {
  const registry = ctx.registryHolder.registry;
  const { ids, aiPacks } = aiContentIds(registry);
  const prefix = nsPrefix(user);
  const epochOrder = (eid) => registry.epochs.get(eid)?.order ?? 0;

  const buildings = [], resources = [], epochs = [];
  for (const b of registry.buildings.values()) {
    if (!aiPacks.has(b._pack)) continue;
    const { _pack, ...def } = b;
    const art = frozenArt(def, epochOrder(def.epoch)); // VOR dem Umbenennen
    const ns = namespaceValue(def, ids, prefix);
    ns.meta = { ...(ns.meta || {}), art };
    buildings.push(ns);
  }
  for (const r of registry.resources.values()) {
    if (!aiPacks.has(r._pack)) continue;
    const { _pack, ...def } = r;
    resources.push(namespaceValue(def, ids, prefix));
  }
  for (const e of registry.epochs.values()) {
    if (!aiPacks.has(e._pack)) continue;
    const { _pack, ...def } = e;
    epochs.push(namespaceValue(def, ids, prefix));
  }

  return { version: 1, owner: user, exportedAt: new Date().toISOString(), buildings, resources, epochs };
}
