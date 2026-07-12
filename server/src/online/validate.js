// Strikte Validierung heruntergeladener Online-Inhalte (M2). Verteidigung in
// der Tiefe: wir vertrauen der Repo-Action NICHT blind — alles, was hier
// ankommt, wird erneut geprüft und auf Whitelist-Felder reduziert (unbekannte
// Felder werden verworfen, Texte hart gekappt).

const ID_RE = /^[a-z0-9_-]{1,80}$/;
const USER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);

/** Kurztexte {de,en} auf Whitelist + Länge reduzieren. */
const name = (v, n = 60) => (isObj(v) ? { ...(cap(v.de, n) ? { de: cap(v.de, n) } : {}), ...(cap(v.en, n) ? { en: cap(v.en, n) } : {}) } : undefined);

/** Map ressourceId→Zahl säubern (cost/inputs/outputs/storage). */
function idNumMap(v, lo, hi) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (ID_RE.test(k) && num(val, lo, hi) !== undefined) out[k] = val;
    if (k === '*' && num(val, lo, hi) !== undefined) out[k] = val; // Lager: alle Waren
  }
  return Object.keys(out).length ? out : undefined;
}

export function checkOwner(owner) { return typeof owner === 'string' && USER_RE.test(owner); }

/** island.json prüfen — wirft bei Struktur-Fehlern. Spiegelbild der Repo-Action. */
export function validateIsland(d, expectedOwner) {
  const bad = (m) => { throw new Error(`island.json: ${m}`); };
  if (!isObj(d)) bad('kein Objekt');
  if (d.version !== 1) bad('version ≠ 1');
  if (d.owner !== expectedOwner) bad(`owner "${d.owner}" ≠ "${expectedOwner}"`);
  if (!isObj(d.map)) bad('map fehlt');
  const w = int(d.map.width, 8, 128), h = int(d.map.height, 8, 128);
  if (w === undefined || h === undefined) bad('map-Maße ungültig');
  if (typeof d.map.tiles !== 'string' || !/^[WGSFR]+$/.test(d.map.tiles) || d.map.tiles.length !== w * h) bad('map.tiles ungültig');
  if (!Array.isArray(d.instances) || d.instances.length > 2000) bad('instances ungültig');
  const instances = [];
  for (const i of d.instances) {
    if (!isObj(i) || typeof i.buildingId !== 'string' || !ID_RE.test(i.buildingId)) bad('instance.buildingId ungültig');
    const x = int(i.x, 0, 127), y = int(i.y, 0, 127);
    if (x === undefined || y === undefined) bad('instance-Koordinate ungültig');
    instances.push({ buildingId: i.buildingId, x, y, rot: int(i.rot, 0, 3) ?? 0 });
  }
  const roads = [];
  if (d.roads !== undefined) {
    if (!Array.isArray(d.roads) || d.roads.length > 8000) bad('roads ungültig');
    for (const r of d.roads) { if (typeof r !== 'string' || !/^\d{1,3},\d{1,3}$/.test(r)) bad('roads-Eintrag ungültig'); roads.push(r); }
  }
  return {
    version: 1, owner: d.owner,
    name: cap(d.name, 40) || d.owner,
    epoch: typeof d.epoch === 'string' && ID_RE.test(d.epoch) ? d.epoch : 'unknown',
    population: num(d.population, 0, 1e6) ?? 0,
    exportedAt: cap(d.exportedAt, 30) || '',
    chronicle: cap(d.chronicle, 500),
    map: { width: w, height: h, tiles: d.map.tiles },
    instances, roads,
  };
}

/** Gebäude-Definition auf Render-/Anzeige-Whitelist reduzieren (oder null). */
function sanitizeBuilding(b) {
  if (!isObj(b) || typeof b.id !== 'string' || !ID_RE.test(b.id)) return null;
  const art = isObj(b.meta?.art) ? b.meta.art : {};
  const size = isObj(b.placement?.size) ? b.placement.size : {};
  return {
    id: b.id,
    name: name(b.name) || { de: b.id },
    description: name(b.description, 240),
    category: ['production', 'housing', 'storage', 'civic'].includes(b.category) ? b.category : 'production',
    epoch: typeof b.epoch === 'string' && ID_RE.test(b.epoch) ? b.epoch : undefined,
    icon: cap(b.icon, 8),
    workers: int(b.workers, 0, 100),
    buildTimeTicks: int(b.buildTimeTicks, 1, 10000), // nötig, falls Inhalte übernommen werden (M4)
    cost: idNumMap(b.cost, 0, 1e6),
    production: isObj(b.production) ? {
      inputs: idNumMap(b.production.inputs, 0, 1000) || {},
      outputs: idNumMap(b.production.outputs, 0, 1000) || {},
    } : undefined,
    housing: isObj(b.housing) && int(b.housing.capacity, 0, 10000) !== undefined ? { capacity: b.housing.capacity } : undefined,
    storage: idNumMap(b.storage, 0, 1e6),
    placement: {
      size: { w: int(size.w, 1, 4) ?? 1, h: int(size.h, 1, 4) ?? 1 },
      ...(isObj(b.placement?.adjacent) ? { adjacent: idNumMap(b.placement.adjacent, 1, 8) } : {}),
    },
    meta: { art: {
      ...(typeof art.shape === 'string' ? { shape: cap(art.shape, 20) } : {}),
      ...(COLOR_RE.test(art.wall || '') ? { wall: art.wall } : {}),
      ...(COLOR_RE.test(art.roof || '') ? { roof: art.roof } : {}),
      ...(COLOR_RE.test(art.accent || '') ? { accent: art.accent } : {}),
      ...(int(art.seed, 0, 4294967295) !== undefined ? { seed: art.seed } : {}),
    } },
  };
}

function sanitizeResource(r) {
  if (!isObj(r) || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  return {
    id: r.id,
    name: name(r.name) || { de: r.id },
    icon: cap(r.icon, 8),
    category: cap(r.category, 20),
    baseValue: num(r.baseValue, 0, 1e6),
    epoch: typeof r.epoch === 'string' && ID_RE.test(r.epoch) ? r.epoch : undefined, // fürs Übernehmen (Pack-Schema verlangt epoch)
  };
}

function sanitizeEpoch(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  return { id: e.id, name: name(e.name) || { de: e.id }, order: int(e.order, 0, 100) ?? 0 };
}

// ── Handel (M3): offers.json / accepts.json der Nachbarn säubern ──
const OFFER_ID_RE = /^[a-z0-9-]{3,80}$/;
function sanitizeStake(s) {
  if (!isObj(s) || typeof s.resourceId !== 'string' || !ID_RE.test(s.resourceId)) return null;
  const amount = int(s.amount, 1, 1000000);
  return amount === undefined ? null : { resourceId: s.resourceId, amount };
}
export function sanitizeOffers(d, expectedOwner) {
  if (!isObj(d) || d.owner !== expectedOwner) throw new Error(`offers.json: owner ≠ ${expectedOwner}`);
  const offers = [], closed = [];
  for (const o of Array.isArray(d.offers) ? d.offers.slice(0, 20) : []) {
    if (!isObj(o) || typeof o.id !== 'string' || !OFFER_ID_RE.test(o.id)) continue;
    const give = sanitizeStake(o.give), want = sanitizeStake(o.want);
    if (give && want) offers.push({ id: o.id, give, want, createdAt: cap(o.createdAt, 30) || '' });
  }
  for (const c of Array.isArray(d.closed) ? d.closed.slice(0, 100) : []) {
    if (!isObj(c) || typeof c.id !== 'string' || !OFFER_ID_RE.test(c.id)) continue;
    closed.push({ id: c.id, winner: checkOwner(c.winner) ? c.winner : null, at: cap(c.at, 30) || '' });
  }
  return { version: 1, owner: d.owner, offers, closed };
}
export function sanitizeAccepts(d, expectedOwner) {
  if (!isObj(d) || d.owner !== expectedOwner) throw new Error(`accepts.json: owner ≠ ${expectedOwner}`);
  const accepts = [];
  for (const a of Array.isArray(d.accepts) ? d.accepts.slice(0, 50) : []) {
    if (!isObj(a) || typeof a.offerId !== 'string' || !OFFER_ID_RE.test(a.offerId) || !checkOwner(a.offerOwner)) continue;
    const give = sanitizeStake(a.give), want = sanitizeStake(a.want);
    if (give && want) accepts.push({ offerId: a.offerId, offerOwner: a.offerOwner, give, want, acceptedAt: cap(a.acceptedAt, 30) || '' });
  }
  return { version: 1, owner: d.owner, accepts };
}

/** packs.json säubern — liefert nur render-relevante, gekappte Definitionen. */
export function sanitizePacks(d, expectedOwner) {
  if (!isObj(d)) throw new Error('packs.json: kein Objekt');
  if (d.owner !== expectedOwner) throw new Error(`packs.json: owner ≠ ${expectedOwner}`);
  const take = (arr, fn, max) => (Array.isArray(arr) ? arr.slice(0, max).map(fn).filter(Boolean) : []);
  return {
    version: 1, owner: d.owner,
    buildings: take(d.buildings, sanitizeBuilding, 200),
    resources: take(d.resources, sanitizeResource, 200),
    epochs: take(d.epochs, sanitizeEpoch, 30),
  };
}
