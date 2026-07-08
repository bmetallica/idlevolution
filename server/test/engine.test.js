import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadRegistry } from '../src/content/loader.js';
import { runTick, runTicks, startBuild, demolish, assignWorkers, storageCapacity } from '../src/engine/tick.js';
import { evaluateConditions } from '../src/engine/rules.js';
import { generateMap, canPlace, TERRAIN, setRoad, growIsland, growWorld } from '../src/engine/map.js';

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
  assert.throws(() => setRoad(MAP, state, registry, 1, 1, true), /Straße nur/); // Wald → ungültig
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
