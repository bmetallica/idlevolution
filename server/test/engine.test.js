import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadRegistry } from '../src/content/loader.js';
import { runTick, runTicks, startBuild, demolish, assignWorkers, storageCapacity, computeNetRates, computeResourceFlows } from '../src/engine/tick.js';
import { evaluateConditions } from '../src/engine/rules.js';
import { generateMap, canPlace, TERRAIN, setRoad, growIsland, growWorld } from '../src/engine/map.js';
import { generateWorld, islandAt, islandById, buildWorldFromLegacy, embedLegacyState } from '../src/engine/world.js';
import { newPlayerOnIsland, bootWorld } from '../src/engine/players.js';
import { runExecutor } from '../src/ai/executor.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const silent = { warn() {}, info() {} };
const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
const { game } = JSON.parse(await readFile(path.join(dataDir, 'balance.config.json'), 'utf8'));

// Kleine deterministische Testkarte: Gras mit Wald-Cluster und einem Fels
const testMap = (rows) => ({ seed: 0, width: rows[0].length, height: rows.length, tiles: rows.join('') });
const MAP = testMap([
  'GGGGGG',
  'GFFGGG',
  'GGGGGG',
  'GGRGGG',
  'GGGGGG',
  'WWGGGG',
]);

function freshState(overrides = {}) {
  return {
    tick: 0,
    epochId: 'stone_age',
    population: 10,
    resources: { wood: 100, stone: 50, food: 100, planks: 0, tools: 0 },
    buildings: {},
    instances: [],
    nextInstanceId: 1,
    map: MAP,
    lastTickAt: Date.now(),
    ...overrides,
  };
}

test('Tick: Holzfäller produziert Holz proportional zu Arbeitern', () => {
  const state = freshState({ buildings: { lumberjack: { count: 1, workers: 2 } } });
  const before = state.resources.wood;
  runTick(registry, state, game);
  assert.ok(Math.abs(state.resources.wood - (before + 0.5)) < 1e-9);

  // Halbe Besetzung → halbe Produktion
  const half = freshState({ buildings: { lumberjack: { count: 1, workers: 1 } } });
  runTick(registry, half, game);
  assert.ok(Math.abs(half.resources.wood - (100 + 0.25)) < 1e-9);
});

test('Tick: Sägewerk steht still ohne Holz-Input', () => {
  const state = freshState({
    resources: { wood: 0, stone: 0, food: 100, planks: 0, tools: 0 },
    buildings: { sawmill: { count: 1, workers: 2 } },
  });
  runTick(registry, state, game);
  assert.equal(state.resources.planks, 0);
});

test('Bevölkerung bremst sich bei Güter-Mangel selbst und kollabiert nicht auf 1', () => {
  // bronze_age verlangt tools (0.01/Kopf/Tick). Ein Toolmaker produziert 0.15/Tick —
  // bei 100 Einwohnern (Bedarf 1.0) deutlich zu wenig → Unzufriedenheit → Rückgang.
  // Erwartung: pendelt sich beim tragfähigen Niveau ein (~0.15/(0.4*0.01)=37.5),
  // NICHT Kollaps auf 1, und die Nahrungskette wird nicht abgebaut.
  // Großes Lager isoliert die Bevölkerungs-Dynamik von Zulieferung/Lager-Cap.
  const bigStore = { ...game, baseStorage: 1e9 };
  const state = freshState({
    epochId: 'bronze_age',
    population: 100,
    resources: { wood: 0, stone: 1e6, food: 1e5, planks: 1e6, tools: 0 },
    buildings: {
      gatherer_hut: { count: 20, workers: 40 }, // Nahrung 12/Tick ≫ Bedarf → nie Hunger
      toolmaker: { count: 1, workers: 2 },       // tools 0.15/Tick ≪ Bedarf → Unzufriedenheit
    },
  });
  for (let i = 0; i < 4000; i++) runTick(registry, state, bigStore);
  assert.ok(state.population > 20, `Bevölkerung kollabierte auf ${state.population.toFixed(1)}`);
  assert.ok(state.population < 100, `Bevölkerung hätte schrumpfen müssen (${state.population.toFixed(1)})`);
  assert.equal(state.buildings.gatherer_hut.workers, 40, 'Nahrungs-Arbeiter dürfen bei Rückgang nicht abgebaut werden');
  assert.ok(state.resources.food > 0, 'Nahrung darf nicht kollabieren');
  assert.ok(state.satisfaction >= 0.38, `Zufriedenheit am Gleichgewicht zu niedrig (${state.satisfaction.toFixed(2)})`);
});

test('Fluss-Aufschlüsselung summiert sich zur Netto-Rate', () => {
  const bigStore = { ...game, baseStorage: 1e9 };
  const state = freshState({
    epochId: 'bronze_age',
    population: 80,
    resources: { wood: 1e6, stone: 1e6, food: 1e5, planks: 0, tools: 0 },
    buildings: {
      gatherer_hut: { count: 5, workers: 10 },
      sawmill: { count: 2, workers: 4 },   // verbraucht wood, produziert planks
      toolmaker: { count: 2, workers: 4 },  // verbraucht planks+stone, produziert tools
    },
  });
  const rates = computeNetRates(registry, state, bigStore);
  const flows = computeResourceFlows(registry, state, bigStore);
  for (const rid of ['wood', 'planks', 'tools', 'food']) {
    const sum = (flows[rid] || []).reduce((a, f) => a + f.amount, 0);
    assert.ok(Math.abs(sum - (rates[rid] ?? 0)) < 1e-6, `${rid}: Summe ${sum} ≠ Netto ${rates[rid]}`);
  }
  // planks werden vom Sägewerk erzeugt UND vom Toolmaker verbraucht → beide Einträge vorhanden
  const plankLabels = (flows.planks || []).map((f) => f.label);
  assert.ok(plankLabels.some((l) => /Sägewerk/.test(l)), 'Produzent fehlt');
  assert.ok(plankLabels.some((l) => /Werkzeugmacher|Toolmaker|Werkzeug/i.test(l)) || (flows.planks || []).some((f) => f.amount < 0), 'Verbraucher fehlt');
});

test('Welt: N Inseln, durch Ozean getrennt, Territorium korrekt', () => {
  const world = generateWorld(42, { islandCount: 5, islandSize: 40, gap: 16 });
  assert.equal(world.islands.length, 5);
  assert.equal(world.tiles.length, world.width * world.height);
  const tileAt = (x, y) => world.tiles[y * world.width + x];

  for (const isl of world.islands) {
    // Spawn (Insel-Mitte) ist begehbares Land (generateMap räumt die Mitte frei)
    assert.notEqual(tileAt(isl.spawn.x, isl.spawn.y), 'W', `Insel ${isl.id}: Spawn ist Wasser`);
    // Territoriums-Zuordnung: Spawn gehört zur eigenen Insel
    assert.equal(islandAt(world, isl.spawn.x, isl.spawn.y), isl.id);
    // Jede Insel enthält tatsächlich Landfläche
    let land = 0;
    for (let y = isl.y; y < isl.y + isl.h; y++) for (let x = isl.x; x < isl.x + isl.w; x++) if (tileAt(x, y) !== 'W') land++;
    assert.ok(land > 100, `Insel ${isl.id}: zu wenig Land (${land})`);
  }

  // Offener Ozean zwischen Insel 0 und 1 gehört keinem (Territorium null)
  const a = world.islands[0], b = world.islands[1];
  if (a.y === b.y && b.x > a.x + a.w) {
    const midX = a.x + a.w + Math.floor((b.x - (a.x + a.w)) / 2);
    assert.equal(islandAt(world, midX, a.spawn.y), null, 'Ozean zwischen Inseln muss territoriumslos sein');
    assert.equal(tileAt(midX, a.spawn.y), 'W');
  }

  assert.equal(islandById(world, 3)?.id, 3);
  assert.equal(islandAt(world, 0, 0), null); // Ozean-Rand
});

test('Migration: Alt-Insel wird als Insel 0 eingebettet, Terrain+Gebäude erhalten', () => {
  // Alt-Zustand auf kleiner 24x24-Insel
  const legacyMap = generateMap(123, 24, 24);
  const cx = 12, cy = 12; // Mitte (freigeräumtes Gras)
  const legacy = {
    tick: 100, epochId: 'bronze_age', population: 42, satisfaction: 1,
    resources: { wood: 50 }, buildings: { hut: { count: 1, workers: 0 } },
    instances: [{ id: 1, buildingId: 'hut', x: cx, y: cy, rot: 0, doneAtTick: 0, counted: true }],
    roads: new Set([`${cx + 1},${cy}`]),
    placed: { [`${cx},${cy + 1}`]: 'tree' },
    cleared: new Set(),
    nextInstanceId: 2, mapVersion: 0,
    map: legacyMap,
  };

  const world = buildWorldFromLegacy(legacyMap, { islandCount: 3, islandSize: 32, gap: 12 });
  const isl0 = world.islands[0];
  // Insel 0 hat exakt die Alt-Größe und -Terrain
  assert.equal(isl0.w, 24); assert.equal(isl0.h, 24);
  const worldTile = (x, y) => world.tiles[y * world.width + x];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    assert.equal(worldTile(isl0.x + x, isl0.y + y), legacyMap.tiles[y * 24 + x]);
  }

  const emb = embedLegacyState(legacy, world);
  // Fortschrittsdaten erhalten
  assert.equal(emb.population, 42);
  assert.equal(emb.tick, 100);
  assert.equal(emb.resources.wood, 50);
  assert.equal(emb.islandId, 0);
  assert.deepEqual(emb.region, { x: isl0.x, y: isl0.y, w: 24, h: 24 });
  // Gebäude um den Insel-Offset verschoben, auf gleichem Terrain wie zuvor
  const inst = emb.instances[0];
  assert.equal(inst.x, cx + isl0.x);
  assert.equal(inst.y, cy + isl0.y);
  assert.equal(worldTile(inst.x, inst.y), legacyMap.tiles[cy * 24 + cx]); // selbes Terrain
  // Straße & Deko mitverschoben
  assert.ok(emb.roads.has(`${cx + 1 + isl0.x},${cy + isl0.y}`));
  assert.equal(emb.placed[`${cx + isl0.x},${cy + 1 + isl0.y}`], 'tree');
});

test('newPlayerOnIsland: Startgebäude landen auf der eigenen Insel', () => {
  const world = { ...generateWorld(9, { islandCount: 4, islandSize: 40, gap: 16 }), version: 1 };
  const p = newPlayerOnIsland(game, registry, world, 2, { id: 2, kind: 'ai', name: 'KI-Test' });
  const isl = islandById(world, 2);
  assert.equal(p.islandId, 2);
  assert.deepEqual(p.region, { x: isl.x, y: isl.y, w: isl.w, h: isl.h });
  assert.ok(p.instances.length >= 1, 'kein Startgebäude platziert');
  for (const inst of p.instances) {
    assert.ok(inst.x >= isl.x && inst.x < isl.x + isl.w && inst.y >= isl.y && inst.y < isl.y + isl.h, 'Startgebäude außerhalb der Insel');
    assert.equal(islandAt(world, inst.x, inst.y), 2);
  }
});

test('bootWorld: frische Welt + Spieler 0 (Mock-Pool, keine Legacy)', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql.trim().split('\n')[0]);
      if (/FROM world WHERE id = 1/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM game_state WHERE id = 1/.test(sql)) return { rowCount: 0, rows: [] }; // keine Legacy
      return { rowCount: 0, rows: [] }; // saveWorld / savePlayer
    },
  };
  const { world, players, migrated } = await bootWorld(pool, game, registry, { islandCount: 5, islandSize: 40, gap: 16 });
  assert.equal(migrated, false);
  assert.equal(world.islands.length, 5);
  assert.equal(players.length, 1);
  const h = players[0];
  assert.equal(h.kind, 'human');
  assert.equal(h.islandId, 0);
  assert.ok(h.instances.length >= 1);
  assert.equal(h.map.width, world.width); // geteilte Karte referenziert
  assert.ok(calls.some((c) => /INSERT INTO world/.test(c)), 'Welt wurde gespeichert');
  assert.ok(calls.some((c) => /INSERT INTO players/.test(c)), 'Spieler wurde gespeichert');
});

test('Executor: KI-Insel baut selbstständig und bleibt auf ihrer Insel', () => {
  const world = { ...generateWorld(11, { islandCount: 4, islandSize: 44, gap: 16 }), version: 1 };
  const ai = newPlayerOnIsland(game, registry, world, 1, { id: 1, kind: 'ai', name: 'KI' });
  const before = ai.instances.length;
  for (let t = 0; t < 500; t++) { runExecutor(registry, ai, game); runTick(registry, ai, game); }
  assert.ok(ai.instances.length > before, `KI baute nichts (${before} → ${ai.instances.length})`);
  assert.ok(ai.population >= 1, `Bevölkerung kollabiert (${ai.population})`);
  for (const i of ai.instances) assert.equal(islandAt(world, i.x, i.y), 1, `Gebäude außerhalb Insel 1 @(${i.x},${i.y})`);
  // Der Executor sollte auch Arbeiter zugewiesen haben
  const assigned = Object.values(ai.buildings).reduce((s, b) => s + (b.workers || 0), 0);
  assert.ok(assigned > 0, 'keine Arbeiter zugewiesen');
});

test('Territorium: Bauen nur in der eigenen Insel-Region', () => {
  const world = generateWorld(5, { islandCount: 4, islandSize: 40, gap: 16 });
  const map = { width: world.width, height: world.height, tiles: world.tiles };
  const def = registry.buildings.get('hut'); // Gras/Sand, keine Adjazenz
  const isl0 = islandById(world, 0), isl1 = islandById(world, 1);
  // Spieler „gehört" zu Insel 1
  const state = { region: { x: isl1.x, y: isl1.y, w: isl1.w, h: isl1.h }, instances: [], placed: {}, cleared: new Set() };

  // Auf der eigenen Insel (Spawn = freigeräumtes Gras) → nicht am Territorium scheitern
  const own = canPlace(map, state, registry, def, isl1.spawn.x, isl1.spawn.y);
  assert.ok(own.ok || own.reason !== 'außerhalb des eigenen Territoriums', `eigenes Territorium abgelehnt: ${own.reason}`);

  // Auf fremder Insel (Insel 0, valides Terrain) → Territoriums-Ablehnung
  const foreign = canPlace(map, state, registry, def, isl0.spawn.x, isl0.spawn.y);
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /Territorium/);

  // Ohne region (heutiges Single-Player-Verhalten) → keine Territoriums-Schranke
  const noRegion = canPlace(map, { instances: [], placed: {}, cleared: new Set() }, registry, def, isl0.spawn.x, isl0.spawn.y);
  assert.ok(noRegion.ok, `ohne region sollte baubar sein: ${noRegion.reason}`);
});

test('Welt: deterministisch bei gleichem Seed', () => {
  const w1 = generateWorld(7, { islandCount: 3, islandSize: 32, gap: 12 });
  const w2 = generateWorld(7, { islandCount: 3, islandSize: 32, gap: 12 });
  assert.equal(w1.tiles, w2.tiles);
  assert.deepEqual(w1.islands, w2.islands);
  const w3 = generateWorld(8, { islandCount: 3, islandSize: 32, gap: 12 });
  assert.notEqual(w1.tiles, w3.tiles);
});

test('Tick: Lagerkapazität begrenzt Bestände', () => {
  const state = freshState({
    resources: { wood: 199.9, stone: 0, food: 100, planks: 0, tools: 0 },
    buildings: { lumberjack: { count: 5, workers: 10 } },
  });
  runTick(registry, state, game);
  assert.ok(state.resources.wood <= storageCapacity(registry, state, game, 'wood'));
});

test('Tick: Vorratsgrube erhöht die Kapazität', () => {
  const state = freshState({ buildings: { storage_pit: { count: 2, workers: 0 } } });
  assert.equal(storageCapacity(registry, state, game, 'wood'), 200 + 2 * 150);
});

test('Tick: Bevölkerung wächst nur bis zur Wohnkapazität', () => {
  const state = freshState({ population: 5, buildings: { hut: { count: 1, workers: 0 } } });
  runTicks(registry, state, game, 500);
  assert.ok(state.population <= 10 + 1e-9); // baseHousing 5 + Hütte 5
});

test('Tick: Hunger lässt die Bevölkerung schrumpfen', () => {
  const state = freshState({ population: 10, resources: { food: 0 } });
  runTicks(registry, state, game, 50);
  assert.ok(state.population < 10);
  assert.ok(state.population >= 1);
});

test('Bauen: Kosten werden abgezogen, Gebäude nach Bauzeit fertig', () => {
  const state = freshState();
  // (1,2) grenzt an die 2 Waldfelder (1,1)+(2,1) → Holzfäller-Platzierung gültig
  startBuild(registry, state, game, 'lumberjack', 1, 2); // Kosten: 10 Holz, 5 Stein, 4 Ticks
  assert.equal(state.resources.wood, 90);
  assert.equal(state.resources.stone, 45);
  assert.equal(state.instances.length, 1);
  assert.equal(state.buildings.lumberjack?.count ?? 0, 0);
  runTicks(registry, state, game, 4);
  assert.equal(state.buildings.lumberjack?.count, 1);
});

test('Bauen: nicht freigeschaltetes Gebäude wird abgelehnt', () => {
  const state = freshState(); // kein Sägewerk → Werkzeugmacher gesperrt
  state.resources.planks = 100;
  assert.throws(() => startBuild(registry, state, game, 'toolmaker', 4, 4), /freigeschaltet/);
});

test('Bauen: unzureichende Ressourcen werden abgelehnt', () => {
  const state = freshState({ resources: { wood: 1, stone: 0, food: 10 } });
  assert.throws(() => startBuild(registry, state, game, 'lumberjack', 1, 2), /Nicht genug/);
});

test('Platzierung: falsches Terrain, belegte Felder und fehlende Nachbarschaft', () => {
  const state = freshState();
  // Wasser (0,5) → ungültig
  assert.throws(() => startBuild(registry, state, game, 'hut', 0, 5), /Platzierung/);
  // Holzfäller ohne Wald in der Nähe (4,4) → ungültig
  assert.throws(() => startBuild(registry, state, game, 'lumberjack', 4, 4), /forest/);
  // Steinbruch braucht Fels: (2,2) grenzt an (2,3)=R → gültig
  startBuild(registry, state, game, 'lumberjack', 1, 2); // schaltet quarry frei… erst nach Fertigstellung
  runTicks(registry, state, game, 4);
  startBuild(registry, state, game, 'quarry', 2, 2);
  // Belegtes Feld → ungültig
  assert.throws(() => startBuild(registry, state, game, 'hut', 2, 2), /bebaut/);
});

test('Abriss: Instanz entfernt, halbe Kosten erstattet, Arbeiter geklemmt', () => {
  const state = freshState();
  const { instanceId } = startBuild(registry, state, game, 'lumberjack', 1, 2);
  runTicks(registry, state, game, 4);
  assignWorkers(registry, state, 'lumberjack', 2);
  const woodBefore = state.resources.wood;
  demolish(registry, state, game, instanceId);
  assert.equal(state.instances.length, 0);
  assert.equal(state.buildings.lumberjack.count, 0);
  assert.equal(state.buildings.lumberjack.workers, 0);
  assert.ok(state.resources.wood > woodBefore); // 50% von 10 Holz zurück
});

test('Karte: Generator erzeugt Insel mit allen Terrain-Typen', () => {
  const map = generateMap(1234, 48, 48);
  assert.equal(map.tiles.length, 48 * 48);
  for (const code of ['W', 'G', 'F', 'R']) {
    assert.ok(map.tiles.includes(code), `Terrain '${TERRAIN[code]}' fehlt auf der Karte`);
  }
  // Startbereich in der Mitte ist bebaubar
  const hut = registry.buildings.get('hut');
  const check = canPlace(map, { instances: [] }, registry, hut, 24, 24);
  assert.ok(check.ok, check.reason);
});

test('Arbeiter: Zuweisung respektiert freie Arbeiter und Gebäudelimit', () => {
  const state = freshState({ population: 3, buildings: { lumberjack: { count: 1, workers: 0 } } });
  assignWorkers(registry, state, 'lumberjack', 2);
  assert.equal(state.buildings.lumberjack.workers, 2);
  // Limit: 1 Gebäude × 2 Arbeiter → +5 wird auf max 2 gekappt (kein Fehler, kein Effekt)
  assignWorkers(registry, state, 'lumberjack', 5);
  assert.equal(state.buildings.lumberjack.workers, 2);
  const state2 = freshState({ population: 1, buildings: { lumberjack: { count: 1, workers: 0 } } });
  assignWorkers(registry, state2, 'lumberjack', 1);
  assert.throws(() => assignWorkers(registry, state2, 'lumberjack', 1), /freie Arbeiter/);
});

test('Epochen-Aufstieg: erfolgt automatisch, wenn advance erfüllt ist', () => {
  const state = freshState({
    population: 20,
    resources: { wood: 0, stone: 0, food: 100, planks: 0, tools: 40 },
    buildings: { toolmaker: { count: 1, workers: 0 }, hut: { count: 4, workers: 0 } },
  });
  const events = runTick(registry, state, game);
  assert.equal(state.epochId, 'bronze_age');
  assert.ok(events.some((e) => e.type === 'epoch_advance'));
});

test('Regel-Evaluator: liefert fehlende Bedingungen mit have/need', () => {
  const state = freshState({ population: 5 });
  const r = evaluateConditions({ population: 15, resources: { tools: 30 } }, registry, state);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 2);
});

test('Bedürfnisse: unerfüllter Güterbedarf senkt Zufriedenheit und Bevölkerung', () => {
  // bronze_age verlangt tools (needs); ohne Vorrat → Unzufriedenheit
  const state = freshState({
    epochId: 'bronze_age',
    population: 10,
    resources: { wood: 100, stone: 50, food: 100, planks: 0, tools: 0 },
  });
  runTick(registry, state, game);
  assert.ok(state.satisfaction < 0.01, 'ohne tools ist die Zufriedenheit ~0');
  assert.ok(state.population < 10, 'Unzufriedenheit führt zu Abwanderung');
});

test('Bedürfnisse: gedeckter Bedarf hält Zufriedenheit und verbraucht die Güter', () => {
  const state = freshState({
    epochId: 'bronze_age',
    population: 10,
    resources: { wood: 100, stone: 50, food: 100, planks: 0, tools: 5 },
  });
  runTick(registry, state, game);
  assert.equal(state.satisfaction, 1);
  // needs.tools = 0.01 × 10 Bevölkerung = 0.1 pro Tick
  assert.ok(Math.abs(state.resources.tools - 4.9) < 1e-9, 'tools werden als Bedarf verbraucht');
});

test('Bedürfnisse: Steinzeit ohne needs bleibt voll zufrieden', () => {
  const state = freshState({ population: 8 });
  runTick(registry, state, game);
  assert.equal(state.satisfaction, 1);
});

test('Straßen: setRoad respektiert Terrain und Belegung', () => {
  const state = freshState({
    buildings: { lumberjack: { count: 1, workers: 2 } },
    instances: [{ id: 1, buildingId: 'lumberjack', x: 2, y: 2, doneAtTick: 0, counted: true }],
    roads: new Set(),
  });
  setRoad(MAP, state, registry, 3, 2, true); // Gras → ok
  assert.ok(state.roads.has('3,2'));
  setRoad(MAP, state, registry, 1, 1, true); // Wald → Straße baubar, rodet den Wald
  assert.ok(state.roads.has('1,1'));
  assert.ok(state.cleared.has('1,1'));
  setRoad(MAP, state, registry, 0, 5, true); // Wasser → Brücke ok
  assert.ok(state.roads.has('0,5'));
  assert.throws(() => setRoad(MAP, state, registry, 2, 2, true), /bebaut/); // belegt
  setRoad(MAP, state, registry, 3, 2, false);
  assert.ok(!state.roads.has('3,2'));
});

test('Straßen: Anbindung erhöht die Produktion (Logistik-Bonus)', () => {
  const mk = (roads) => freshState({
    buildings: { lumberjack: { count: 1, workers: 2 } },
    instances: [{ id: 1, buildingId: 'lumberjack', x: 2, y: 2, doneAtTick: 0, counted: true }],
    roads,
  });
  const a = mk(new Set());
  const b = mk(new Set(['3,2'])); // grenzt an das Gebäude bei (2,2)
  const a0 = a.resources.wood, b0 = b.resources.wood;
  runTick(registry, a, game);
  runTick(registry, b, game);
  assert.ok(b.resources.wood - b0 > a.resources.wood - a0, 'mit Straße höhere Produktion');
});

test('Insel-Wachstum: Küstenwasser wird Land, Zentrum bleibt', () => {
  const t = 'WWW' + 'WGW' + 'WWW'; // 3x3, nur Zentrum Gras
  const g = growIsland(t, 3, 3);
  assert.equal(g[1], 'S'); assert.equal(g[3], 'S'); assert.equal(g[5], 'S'); assert.equal(g[7], 'S');
  assert.equal(g[4], 'G'); // Zentrum bleibt
  assert.equal(g[0], 'W'); // Ecke (nur diagonal) bleibt Wasser
});

test('Spielfeld-Wachstum: Raster wächst, Inhalte verschieben sich zentriert', () => {
  const state = freshState({
    map: testMap(['GGG', 'GGG', 'GGG']),
    instances: [{ id: 1, buildingId: 'hut', x: 1, y: 1, doneAtTick: 0, counted: true }],
    roads: new Set(['0,0']),
    placed: { '2,2': 'tree' },
    cleared: new Set(),
  });
  growWorld(state, 4); // +4 → Offset 2
  assert.equal(state.map.width, 7);
  assert.equal(state.map.height, 7);
  assert.equal(state.instances[0].x, 3); // 1+2
  assert.equal(state.instances[0].y, 3);
  assert.ok(state.roads.has('2,2')); // 0,0 → +2
  assert.equal(state.placed['4,4'], 'tree'); // 2,2 → +2
});
