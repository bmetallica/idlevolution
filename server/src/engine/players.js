// Persistenz + Boot-Orchestrierung für die Mehr-Insel-Welt (Stufe 0 der
// KI-Spieler-Roadmap). Eine geteilte Welt (Karte + Inseln) und N Spieler-
// Wirtschaften. Ein "Spieler"-Objekt trägt sowohl Meta (id/kind/name/active/
// plan) als auch alle Wirtschafts-/Zustandsfelder — die Engine (runTick,
// startBuild, ...) arbeitet direkt darauf wie bisher auf `state`.

import { loadState } from './state.js';
import { generateWorld, buildWorldFromLegacy, embedLegacyState } from './world.js';
import { findFreeSpot } from './map.js';

const DEFAULTS = { islandCount: 5, islandSize: 44, gap: 18 };

function worldMap(world) {
  return { seed: world.seed, width: world.width, height: world.height, tiles: world.tiles };
}

/** Serialisiert die Wirtschaft eines Spielers für JSONB (Sets → Arrays, ohne map). */
function serializeEconomy(p) {
  const { map, id, kind, name, active, plan, ...econ } = p;
  return { ...econ, roads: [...(p.roads || [])], cleared: [...(p.cleared || [])] };
}
/** Baut aus JSONB + geteilter Karte wieder ein lauffähiges Spieler-Objekt. */
function playerFromRow(row, world) {
  const econ = row.economy || {};
  return {
    id: row.id, kind: row.kind, name: row.name, islandId: row.island_id,
    active: row.active, plan: row.plan || null,
    ...econ,
    roads: new Set(econ.roads || []),
    cleared: new Set(econ.cleared || []),
    map: worldMap(world),
  };
}

export async function loadWorld(pool) {
  const res = await pool.query('SELECT seed, width, height, tiles, islands, version, ships, offers, warlog FROM world WHERE id = 1');
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  const ships = r.ships || [];
  const offers = r.offers || [];
  return {
    seed: Number(r.seed), width: r.width, height: r.height, tiles: r.tiles,
    islands: r.islands || [], version: r.version || 0,
    ships, nextShipId: ships.reduce((m, s) => Math.max(m, s.id + 1), 1),
    offers, nextOfferId: offers.reduce((m, o) => Math.max(m, o.id + 1), 1),
    warLog: r.warlog || [],
  };
}

export async function saveWorld(pool, world) {
  await pool.query(
    `INSERT INTO world (id, seed, width, height, tiles, islands, version, ships, offers, warlog)
     VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       seed=EXCLUDED.seed, width=EXCLUDED.width, height=EXCLUDED.height,
       tiles=EXCLUDED.tiles, islands=EXCLUDED.islands, version=EXCLUDED.version,
       ships=EXCLUDED.ships, offers=EXCLUDED.offers, warlog=EXCLUDED.warlog`,
    [world.seed, world.width, world.height, world.tiles, JSON.stringify(world.islands || []), world.version || 0, JSON.stringify(world.ships || []), JSON.stringify(world.offers || []), JSON.stringify(world.warLog || [])]
  );
}

export async function loadPlayers(pool, world) {
  const res = await pool.query('SELECT id, kind, name, island_id, active, economy, plan FROM players ORDER BY id');
  return res.rows.map((r) => playerFromRow(r, world));
}

export async function savePlayer(pool, p) {
  await pool.query(
    `INSERT INTO players (id, kind, name, island_id, active, economy, plan, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (id) DO UPDATE SET
       kind=EXCLUDED.kind, name=EXCLUDED.name, island_id=EXCLUDED.island_id,
       active=EXCLUDED.active, economy=EXCLUDED.economy, plan=EXCLUDED.plan, updated_at=now()`,
    [p.id, p.kind, p.name, p.islandId ?? 0, p.active !== false, JSON.stringify(serializeEconomy(p)), p.plan ? JSON.stringify(p.plan) : null]
  );
}

/** Frische Wirtschaft für einen Spieler auf einer Insel (Startgebäude nahe Spawn). */
export function newPlayerOnIsland(game, registry, world, islandId, meta) {
  const isl = (world.islands || []).find((i) => i.id === islandId);
  const map = worldMap(world);
  const initial = game.initial || {};
  const p = {
    id: meta.id, kind: meta.kind, name: meta.name, active: true, plan: null,
    tick: 0, epochId: initial.epoch, population: initial.population ?? 5, satisfaction: 1,
    resources: { ...(initial.resources || {}) }, buildings: {}, instances: [],
    roads: new Set(), placed: {}, cleared: new Set(),
    mapVersion: 0, nextInstanceId: 1,
    region: { x: isl.x, y: isl.y, w: isl.w, h: isl.h }, islandId,
    lastTickAt: Date.now(), map,
  };
  for (const [bid, b] of Object.entries(initial.buildings || {})) {
    p.buildings[bid] = { count: 0, workers: b.workers ?? 0 };
    const def = registry.buildings.get(bid);
    for (let i = 0; i < (b.count ?? 0); i++) {
      const spot = def ? findFreeSpot(map, p, registry, def, isl.spawn.x, isl.spawn.y) : null;
      if (!spot) continue;
      p.instances.push({ id: p.nextInstanceId++, buildingId: bid, ...spot, doneAtTick: 0, counted: true });
      p.buildings[bid].count += 1;
    }
  }
  return p;
}

/**
 * Lädt die Welt + Spieler oder migriert/erzeugt sie beim ersten Start.
 * - Welt vorhanden → laden.
 * - Alt-Spielstand (game_state) vorhanden → als Insel 0 einbetten (Fortschritt erhalten).
 * - sonst frische Welt + Spieler 0.
 */
export async function bootWorld(pool, game, registry, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const existing = await loadWorld(pool);
  if (existing) {
    const players = await loadPlayers(pool, existing);
    return { world: existing, players, migrated: false };
  }

  const hasLegacy = (await pool.query('SELECT 1 FROM game_state WHERE id = 1')).rowCount > 0;
  let world, human;
  if (hasLegacy) {
    const legacy = await loadState(pool, game, registry); // liest Alt-Tabellen + Karte
    world = { ...buildWorldFromLegacy(legacy.map, cfg), version: 1 };
    const econ = embedLegacyState(legacy, world);
    human = { id: 0, kind: 'human', name: 'Du', active: true, plan: null, ...econ, map: worldMap(world) };
  } else {
    const seed = Math.floor(Math.random() * 2 ** 31);
    world = { ...generateWorld(seed, cfg), version: 1 };
    human = newPlayerOnIsland(game, registry, world, 0, { id: 0, kind: 'human', name: 'Du' });
  }
  await saveWorld(pool, world);
  await savePlayer(pool, human);
  return { world, players: [human], migrated: hasLegacy };
}
