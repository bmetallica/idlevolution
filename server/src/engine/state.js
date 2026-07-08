// Spielzustand-Repository: Laden/Speichern des dynamischen Zustands in PostgreSQL.
// Der Zustand referenziert Content nur über String-IDs — unbekannte IDs bleiben
// erhalten (Vorwärtskompatibilität, falls ein Pack entfernt/geändert wird).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateMap, findFreeSpot } from './map.js';

/** Lädt data/balance.config.json (Spiel-Grundwerte + Balancing-Grenzen). */
export async function loadGameConfig(dataDir) {
  const raw = JSON.parse(await readFile(path.join(dataDir, 'balance.config.json'), 'utf8'));
  return { game: raw.game, balance: raw.balance };
}

/** Lädt die Weltkarte oder generiert sie einmalig (seeded). */
export async function loadMap(pool) {
  const res = await pool.query('SELECT seed, width, height, tiles FROM world_map WHERE id = 1');
  if (res.rowCount > 0) {
    const r = res.rows[0];
    return { seed: Number(r.seed), width: r.width, height: r.height, tiles: r.tiles };
  }
  const map = generateMap(Math.floor(Math.random() * 2 ** 31), 48, 48);
  await pool.query('INSERT INTO world_map (id, seed, width, height, tiles) VALUES (1,$1,$2,$3,$4)', [
    map.seed,
    map.width,
    map.height,
    map.tiles,
  ]);
  return map;
}

/** Initialzustand aus der Spielkonfiguration; Startgebäude werden auf der Karte platziert. */
export function newState(game, registry, map) {
  const initial = game.initial || {};
  const state = {
    tick: 0,
    epochId: initial.epoch,
    population: initial.population ?? 5,
    satisfaction: 1,
    resources: { ...(initial.resources || {}) },
    buildings: {},
    instances: [],
    roads: new Set(),
    placed: {}, // "x,y" -> 'tree' | 'rock' (vom Spieler gesetzte Deko)
    cleared: new Set(), // Tiles, deren natürliche Deko (Wald/Fels) entfernt wurde
    mapVersion: 0,
    nextInstanceId: 1,
    map,
    lastTickAt: Date.now(),
  };
  for (const [id, b] of Object.entries(initial.buildings || {})) {
    state.buildings[id] = { count: 0, workers: b.workers ?? 0 };
    const def = registry.buildings.get(id);
    for (let i = 0; i < (b.count ?? 0); i++) {
      const spot = def ? findFreeSpot(map, state, registry, def) : null;
      if (!spot) continue;
      state.instances.push({ id: state.nextInstanceId++, buildingId: id, ...spot, doneAtTick: 0, counted: true });
      state.buildings[id].count += 1;
    }
  }
  return state;
}

export async function loadState(pool, game, registry) {
  const map = await loadMap(pool);
  const gs = await pool.query('SELECT * FROM game_state WHERE id = 1');
  if (gs.rowCount === 0) {
    const state = newState(game, registry, map);
    await saveState(pool, state);
    return state;
  }
  const row = gs.rows[0];
  const [stock, built, insts] = await Promise.all([
    pool.query('SELECT resource_id, amount FROM resource_stock'),
    pool.query('SELECT building_id, count, workers_assigned FROM buildings_built'),
    pool.query('SELECT id, building_id, x, y, done_at_tick, rot FROM building_instances ORDER BY id'),
  ]);
  const tick = Number(row.tick);
  const state = {
    tick,
    epochId: row.current_epoch,
    population: Number(row.population),
    satisfaction: 1,
    resources: Object.fromEntries(stock.rows.map((r) => [r.resource_id, Number(r.amount)])),
    buildings: Object.fromEntries(
      built.rows.map((r) => [r.building_id, { count: r.count, workers: r.workers_assigned }])
    ),
    instances: insts.rows.map((r) => ({
      id: Number(r.id),
      buildingId: r.building_id,
      x: r.x,
      y: r.y,
      rot: r.rot ?? 0,
      doneAtTick: Number(r.done_at_tick),
      counted: Number(r.done_at_tick) <= tick,
    })),
    roads: new Set(row.extra?.roads || []),
    placed: row.extra?.placed || {},
    cleared: new Set(row.extra?.cleared || []),
    mapVersion: row.extra?.mapVersion || 0,
    nextInstanceId: row.extra?.nextInstanceId || 1,
    map,
    lastTickAt: new Date(row.last_tick_at).getTime(),
  };
  state.nextInstanceId = Math.max(state.nextInstanceId, ...state.instances.map((i) => i.id + 1), 1);

  // Migration: Alt-Spielstände haben Zähler, aber keine platzierten Instanzen →
  // Gebäude automatisch nahe der Kartenmitte platzieren.
  if (state.instances.length === 0) {
    for (const [id, b] of Object.entries(state.buildings)) {
      const def = registry.buildings.get(id);
      if (!def) continue;
      for (let i = 0; i < b.count; i++) {
        const spot = findFreeSpot(map, state, registry, def);
        if (!spot) break;
        state.instances.push({ id: state.nextInstanceId++, buildingId: id, ...spot, doneAtTick: 0, counted: true });
      }
    }
    if (state.instances.length > 0) await saveState(pool, state);
  }
  return state;
}

export async function saveState(pool, state) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO game_state (id, current_epoch, tick, population, last_tick_at, extra)
       VALUES (1, $1, $2, $3, to_timestamp($4 / 1000.0), $5)
       ON CONFLICT (id) DO UPDATE SET
         current_epoch = EXCLUDED.current_epoch, tick = EXCLUDED.tick,
         population = EXCLUDED.population, last_tick_at = EXCLUDED.last_tick_at,
         extra = EXCLUDED.extra`,
      [state.epochId, state.tick, state.population, Date.now(), JSON.stringify({ nextInstanceId: state.nextInstanceId, roads: [...(state.roads || [])], placed: state.placed || {}, cleared: [...(state.cleared || [])], mapVersion: state.mapVersion || 0 })]
    );
    await client.query('DELETE FROM resource_stock');
    for (const [rid, amount] of Object.entries(state.resources)) {
      await client.query('INSERT INTO resource_stock (resource_id, amount) VALUES ($1, $2)', [rid, amount]);
    }
    await client.query('DELETE FROM buildings_built');
    for (const [bid, b] of Object.entries(state.buildings)) {
      await client.query(
        'INSERT INTO buildings_built (building_id, count, workers_assigned) VALUES ($1, $2, $3)',
        [bid, b.count, b.workers ?? 0]
      );
    }
    await client.query('DELETE FROM building_instances');
    for (const inst of state.instances || []) {
      await client.query(
        'INSERT INTO building_instances (id, building_id, x, y, done_at_tick, rot) VALUES ($1, $2, $3, $4, $5, $6)',
        [inst.id, inst.buildingId, inst.x, inst.y, inst.doneAtTick, inst.rot ?? 0]
      );
    }
    await client.query('COMMIT');
    state.lastTickAt = Date.now();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function logEvent(pool, type, payload = {}) {
  await pool.query('INSERT INTO event_log (type, payload) VALUES ($1, $2)', [type, JSON.stringify(payload)]);
}

/** Persistiert die (gewachsene) Karten-Tiles. */
export async function saveMapTiles(pool, tiles) {
  await pool.query('UPDATE world_map SET tiles = $1 WHERE id = 1', [tiles]);
}
