// Tests für das Kriegssystem v2: Raubzüge im Tagesrhythmus, KEINE Eroberung —
// jede Insel bleibt bei ihrem Besitzer. rng injiziert = deterministisch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { armyOf, defenseOf, declareWar, cancelDeclaration, resolveWars } from '../src/engine/war.js';
import { canPlace } from '../src/engine/map.js';

const registry = {
  buildings: new Map([
    ['watchtower', { id: 'watchtower', meta: { military: { defense: 15 } } }],
    ['hut', { id: 'hut' }],
  ]),
  resources: new Map([
    ['soldiers', { id: 'soldiers', category: 'special' }],
    ['wood', { id: 'wood', category: 'raw' }],
    ['meat', { id: 'meat', category: 'food' }],
  ]),
};

function mkPlayer(id, over = {}) {
  return {
    id, kind: 'ai', name: `P${id}`, islandId: id, active: true,
    resources: {}, instances: [], buildings: {}, population: 0,
    ...over,
  };
}

test('Stärken: Armee = Soldaten; Verteidigung = Soldaten + Türme + Miliz', () => {
  const p = mkPlayer(1, {
    resources: { soldiers: 12 }, population: 100,
    instances: [{ id: 1, buildingId: 'watchtower', x: 1, y: 1, counted: true }],
  });
  assert.equal(armyOf(p), 12);
  assert.equal(defenseOf(p, registry), 12 + 15 + 5);
});

test('Kriegserklärung: Treuhand, keine Doppel-Erklärung, Rückzug erstattet', () => {
  const world = {};
  const a = mkPlayer(0, { resources: { soldiers: 20 } });
  const d = mkPlayer(1);
  const decl = declareWar(world, a, d, 15);
  assert.equal(a.resources.soldiers, 5);
  assert.equal(decl.soldiers, 15);
  assert.throws(() => declareWar(world, a, d, 5), /bereits/);
  assert.throws(() => declareWar(world, a, mkPlayer(2), 99), /Nur 5 Soldaten/);
  cancelDeclaration(world, a, 1);
  assert.equal(a.resources.soldiers, 20);
  assert.equal(world.warDeclarations.length, 0);
});

test('Nacht-Auflösung: Sieger plündert Beute — die Insel bleibt beim Verlierer', () => {
  const world = {};
  const a = mkPlayer(0, { kind: 'human', resources: { soldiers: 40 } });
  const d = mkPlayer(1, {
    population: 40, resources: { soldiers: 2, wood: 400, meat: 100 },
    instances: [{ id: 7, buildingId: 'hut', x: 1, y: 1, counted: true }],
  });
  declareWar(world, a, d, 40);
  const reports = resolveWars(world, [a, d], registry, () => 0.5);
  assert.match(reports[0], /plündert/);
  // Beute: max 25 % je Vorrat, Tragkraft der Überlebenden
  assert.ok(a.resources.wood > 0 && a.resources.wood <= 100, 'Holz-Beute ≤ 25 %');
  assert.ok(d.resources.wood >= 300, 'Verlierer behält den Großteil');
  // KEINE Eroberung: Insel, Gebäude, Aktiv-Status bleiben beim Verlierer
  assert.equal(d.active, true);
  assert.equal(d.instances.length, 1);
  assert.equal(d.islandId, 1);
  // Überlebende kehren heim
  assert.ok(armyOf(a) > 0 && armyOf(a) <= 40);
});

test('Nacht-Auflösung: Abwehr — Angreifer blutet, Verteidiger hält stand', () => {
  const world = {};
  const a = mkPlayer(0, { kind: 'human', resources: { soldiers: 5 } });
  const d = mkPlayer(1, { resources: { soldiers: 60, wood: 100 }, population: 200 });
  declareWar(world, a, d, 5);
  const reports = resolveWars(world, [a, d], registry, () => 0.5);
  assert.match(reports[0], /wehrt den Raubzug/);
  assert.ok(armyOf(a) < 5, 'Angreifer hat Verluste');
  assert.equal(a.resources.wood ?? 0, 0, 'keine Beute bei Abwehr');
  assert.equal(d.active, true);
});

test('Vergeltung: angegriffene KI erklärt Gegenschlag für die nächste Nacht', () => {
  const world = {};
  const a = mkPlayer(0, { kind: 'human', resources: { soldiers: 10 } });
  const d = mkPlayer(1, { kind: 'ai', resources: { soldiers: 30 }, population: 100 });
  declareWar(world, a, d, 10);
  const reports = resolveWars(world, [a, d], registry, () => 0.5);
  assert.ok(reports.some((r) => r.includes('Vergeltung')), 'Vergeltung angekündigt');
  assert.equal(world.warDeclarations.length, 1);
  const ret = world.warDeclarations[0];
  assert.equal(ret.attackerId, 1);
  assert.equal(ret.defenderId, 0);
  assert.equal(ret.retaliation, true);
  // Vergeltungs-Truppe ist abgestellt (Treuhand)
  assert.ok(armyOf(d) < 30);
  // Nächste Nacht: Vergeltung schlägt gegen den Menschen zu (Mensch vergilt NICHT automatisch)
  const r2 = resolveWars(world, [a, d], registry, () => 0.5);
  assert.equal(r2.length >= 1, true);
  assert.equal(world.warDeclarations.length, 0, 'keine Endlos-Fehde: Mensch vergilt nicht automatisch');
});

test('canPlace respektiert mehrere Regionen (generisches Territorium-Feature)', () => {
  const map = { width: 40, height: 10, tiles: 'G'.repeat(400), legend: { G: 'grass' } };
  const def = { id: 'hut', placement: { terrain: ['grass'], size: { w: 1, h: 1 } } };
  const reg = { buildings: new Map([['hut', def]]) };
  const state = { instances: [], roads: new Set(), cleared: new Set(), placed: {}, region: { x: 0, y: 0, w: 10, h: 10 } };
  assert.equal(canPlace(map, state, reg, def, 25, 5).ok, false);
  state.regions = [state.region, { x: 20, y: 0, w: 10, h: 10 }];
  assert.equal(canPlace(map, state, reg, def, 25, 5).ok, true);
  assert.equal(canPlace(map, state, reg, def, 15, 5).ok, false);
});
