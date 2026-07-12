// Tests für das Kriegssystem (Stufe 6): Stärken, Angriff, Schlacht (rng
// injiziert = deterministisch), Eroberung inkl. Territorium-Übernahme und
// Mehr-Regionen-canPlace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { armyOf, defenseOf, startAttack, resolveBattle, conquerIsland } from '../src/engine/war.js';
import { canPlace } from '../src/engine/map.js';

const registry = {
  buildings: new Map([
    ['watchtower', { id: 'watchtower', meta: { military: { defense: 15 } } }],
    ['hut', { id: 'hut' }],
  ]),
};

function mkPlayer(id, islandId, over = {}) {
  return {
    id, kind: 'ai', name: `P${id}`, islandId, active: true,
    resources: {}, instances: [], buildings: {}, population: 0,
    roads: new Set(), cleared: new Set(), placed: {}, nextInstanceId: 1,
    region: { x: islandId * 20, y: 0, w: 10, h: 10 },
    ...over,
  };
}
const mkWorld = () => ({
  islands: [
    { id: 0, x: 0, y: 0, w: 10, h: 10 }, { id: 1, x: 20, y: 0, w: 10, h: 10 },
  ],
  ships: [], nextShipId: 1,
});

test('Stärken: Armee = Soldaten; Verteidigung = Soldaten + Türme + Miliz', () => {
  const p = mkPlayer(1, 1, {
    resources: { soldiers: 12 }, population: 100,
    instances: [{ id: 1, buildingId: 'watchtower', x: 21, y: 1, counted: true }, { id: 2, buildingId: 'hut', x: 22, y: 1, counted: true }],
  });
  assert.equal(armyOf(p), 12);
  assert.equal(defenseOf(p, registry), 12 + 15 + 5); // 5 % Miliz von 100
});

test('startAttack: Treuhand + Kriegsschiff; Validierungen greifen', () => {
  const world = mkWorld();
  const a = mkPlayer(0, 0, { resources: { soldiers: 20 }, instances: [{ id: 1, buildingId: 'harbor', x: 1, y: 1, counted: true }] });
  const d = mkPlayer(1, 1);
  const ship = startAttack(world, a, d, 15, 100);
  assert.equal(a.resources.soldiers, 5);
  assert.equal(ship.type, 'war');
  assert.equal(ship.cargo.amount, 15);
  assert.ok(ship.arriveTick > 100);
  assert.throws(() => startAttack(world, a, d, 99, 100), /Nur 5 Soldaten/);
  assert.throws(() => startAttack(world, mkPlayer(2, 0, { resources: { soldiers: 5 } }), d, 1, 100), /Hafen/);
});

test('Schlacht: Sieg erobert die Insel (Territorium, Gebäude, halbe Bevölkerung)', () => {
  const world = mkWorld();
  const a = mkPlayer(0, 0, { resources: { soldiers: 0 } });
  const d = mkPlayer(1, 1, {
    population: 40, resources: { soldiers: 2 },
    instances: [{ id: 7, buildingId: 'hut', x: 21, y: 1, counted: true, rot: 0 }],
    buildings: { hut: { count: 1, workers: 0 } },
    roads: new Set(['21,2']),
  });
  const ship = { type: 'war', owner: 0, toOwner: 1, cargo: { resourceId: 'soldiers', amount: 30 } };
  const r = resolveBattle(world, [a, d], ship, registry, () => 0.5); // rng fest → atk 30 > def (2+2)
  assert.equal(r.victory, true);
  assert.ok(a.resources.soldiers >= 1, 'Überlebende garnisonieren');
  assert.equal(d.active, false);
  assert.equal(d.instances.length, 0);
  assert.equal(a.instances.length, 1, 'Gebäude übernommen');
  assert.equal(a.buildings.hut.count, 1);
  assert.equal(a.population, 20, 'halbe Bevölkerung übernommen');
  assert.ok(a.regions.some((x) => x.x === 20), 'Territorium erweitert');
  assert.ok(a.roads.has('21,2'), 'Straßen übernommen');
});

test('Schlacht: Niederlage — Angreifer verliert Truppe, Verteidiger Soldaten anteilig', () => {
  const world = mkWorld();
  const a = mkPlayer(0, 0, { resources: { soldiers: 0 } });
  const d = mkPlayer(1, 1, { resources: { soldiers: 50 }, population: 200 });
  const ship = { type: 'war', owner: 0, toOwner: 1, cargo: { resourceId: 'soldiers', amount: 5 } };
  const r = resolveBattle(world, [a, d], ship, registry, () => 0.5);
  assert.equal(r.victory, false);
  assert.equal(a.resources.soldiers, 0, 'Angreifer-Truppe gefallen');
  assert.ok(d.resources.soldiers < 50 && d.resources.soldiers > 30, 'Verteidiger verliert anteilig');
  assert.equal(d.active, true);
});

test('canPlace respektiert mehrere Regionen (eroberte Insel wird baubar)', () => {
  // 40 breite Welt, zwei 10er-Inseln bei x=0 und x=20, alles Gras
  const map = { width: 40, height: 10, tiles: 'G'.repeat(400), legend: { G: 'grass' } };
  const def = { id: 'hut', placement: { terrain: ['grass'], size: { w: 1, h: 1 } } };
  const reg = { buildings: new Map([['hut', def]]) };
  const state = { instances: [], roads: new Set(), cleared: new Set(), placed: {}, region: { x: 0, y: 0, w: 10, h: 10 } };
  assert.equal(canPlace(map, state, reg, def, 25, 5).ok, false, 'fremde Insel gesperrt');
  state.regions = [state.region, { x: 20, y: 0, w: 10, h: 10 }];
  assert.equal(canPlace(map, state, reg, def, 25, 5).ok, true, 'erobert → baubar');
  assert.equal(canPlace(map, state, reg, def, 15, 5).ok, false, 'Ozean-Lücke bleibt gesperrt');
});
