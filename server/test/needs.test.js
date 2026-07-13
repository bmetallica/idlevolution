// Tests für die Bedarfs-Ökonomie (Todesspiral-Schutz): Ketten-Arbeiterkosten,
// leistbare Bedürfnisse, Balancer-Kappung, Bevölkerungs-Untergrenze.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainWorkerCost, maxAffordableNeed, clampEpochNeeds } from '../src/content/needs.js';
import { balancePack } from '../src/content/balancer.js';

const B = [
  { id: 'mine', workers: 3, production: { inputs: {}, outputs: { ore: 0.5 } } },
  { id: 'smelter', workers: 4, production: { inputs: { ore: 0.6 }, outputs: { ingot: 0.3 } } },
  { id: 'forge', workers: 4, production: { inputs: { ingot: 0.4 }, outputs: { ware: 0.3 } } },
];

test('chainWorkerCost rechnet die komplette Vorkette', () => {
  assert.equal(chainWorkerCost(B, 'ore'), 6); // 3 / 0.5
  // ingot: 4/0.3 + (0.6/0.3)*6 = 13.33 + 12 = 25.33
  assert.ok(Math.abs(chainWorkerCost(B, 'ingot') - 25.333) < 0.01);
  // ware: 4/0.3 + (0.4/0.3)*25.33 = 13.33 + 33.78 = 47.1
  assert.ok(Math.abs(chainWorkerCost(B, 'ware') - 47.11) < 0.1);
  assert.equal(chainWorkerCost(B, 'unbekannt'), Infinity);
});

test('maxAffordableNeed: 15%-Budget geteilt durch Kettenkosten', () => {
  assert.ok(Math.abs(maxAffordableNeed(B, 'ware') - 0.0031) < 0.0002); // 0.15/47.1
  assert.equal(maxAffordableNeed(B, 'unbekannt'), 0.0001); // Untergrenze
});

test('clampEpochNeeds kappt unerfüllbare Bedürfnisse (Todesspiral-Schutz)', () => {
  const epoch = { id: 'test_age', needs: { ware: 0.01, ore: 0.02 } };
  const notes = clampEpochNeeds(B, epoch);
  assert.ok(epoch.needs.ware <= 0.0032, 'ware gekappt');
  assert.equal(epoch.needs.ore, 0.02, 'ore leistbar (0.02×6=12% < 15%)');
  assert.equal(notes.length, 1);
});

test('balancePack kappt Epochen-needs inkl. Pack-eigener Produzenten', () => {
  const registry = {
    epochs: new Map([['a0', { id: 'a0', order: 0 }]]),
    resources: new Map([['ore', { id: 'ore', baseValue: 1 }], ['ware', { id: 'ware', baseValue: 9 }]]),
    buildings: new Map(B.map((b) => [b.id, b])),
  };
  const pack = { epochs: [{ id: 'a1', order: 1, needs: { ware: 0.01 } }], epochAdvance: { a0: { population: 10 } } };
  const { pack: out, notes } = balancePack(pack, registry, {});
  assert.ok(out.epochs[0].needs.ware <= 0.0032);
  assert.ok(notes.some((n) => n.includes('gekappt')));
});

test('Balancer: productionMultiplier darf nie unter die Vorepoche fallen', () => {
  const registry = {
    epochs: new Map([['a0', { id: 'a0', order: 0, modifiers: { productionMultiplier: 1.5 } }]]),
    resources: new Map(),
    buildings: new Map(),
  };
  const pack = { epochs: [{ id: 'a1', order: 1, modifiers: { productionMultiplier: 0.3 } }], epochAdvance: { a0: { population: 10 } } };
  const { pack: out, notes } = balancePack(pack, registry, {});
  assert.ok(out.epochs[0].modifiers.productionMultiplier >= 1.5, 'angehoben statt Regression');
  assert.ok(notes.some((n) => n.includes('angehoben')));
  // fehlende modifiers werden ebenfalls repariert
  const pack2 = { epochs: [{ id: 'a1', order: 1 }], epochAdvance: { a0: { population: 10 } } };
  const r2 = balancePack(pack2, registry, {});
  assert.ok(r2.pack.epochs[0].modifiers.productionMultiplier >= 1.5);
});
