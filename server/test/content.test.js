import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../src/content/loader.js';
import { validatePack, validateStructure } from '../src/content/validator.js';
import { balancePack } from '../src/content/balancer.js';
import { readFile } from 'node:fs/promises';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const silent = { warn() {}, info() {} };

const balance = JSON.parse(await readFile(path.join(dataDir, 'balance.config.json'), 'utf8')).balance;

function aiPack(overrides = {}) {
  return {
    schemaVersion: 1,
    pack: { id: 'ai-test', source: 'ai', createdAt: '2026-07-05' },
    ...overrides,
  };
}

test('Base-Content-Pack lädt vollständig', async () => {
  // data/content/generated/ kann zusätzliche KI-Packs enthalten → nur Untergrenzen prüfen
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  assert.ok(registry.resources.size >= 5);
  assert.ok(registry.buildings.size >= 7);
  assert.ok(registry.epochs.size >= 2);
  for (const id of ['wood', 'stone', 'food', 'planks', 'tools']) {
    assert.ok(registry.resources.has(id), `Basis-Ressource '${id}' fehlt`);
  }
  assert.ok(registry.buildings.get('lumberjack').production.outputs.wood > 0);
});

test('Validator: strukturell kaputtes Pack wird abgelehnt', () => {
  const v = validateStructure({ schemaVersion: 1, pack: { id: 'x', source: 'ai' }, resources: [{ id: 'UPPER' }] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length > 0);
});

test('Validator: unbekannte Referenzen werden abgelehnt', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const v = validatePack(
    aiPack({
      buildings: [
        {
          id: 'ghost_forge',
          name: { de: 'Geisterschmiede' },
          category: 'production',
          epoch: 'stone_age',
          cost: { unobtainium: 10 },
          workers: 2,
          production: { inputs: {}, outputs: { wood: 0.1 } },
        },
      ],
    }),
    registry
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('unobtainium')));
});

test('Validator: ID-Kollision mit existierendem Content wird abgelehnt', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const v = validatePack(
    aiPack({
      resources: [{ id: 'wood', name: { de: 'Holz 2' }, category: 'raw', epoch: 'stone_age', baseValue: 1 }],
    }),
    registry
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("'wood'")));
});

test('Validator: neue Epoche ohne epochAdvance des Vorgängers wird abgelehnt', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const v = validatePack(
    aiPack({ epochs: [{ id: 'iron_age', order: 2, name: { de: 'Eisenzeit' } }] }),
    registry
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('epochAdvance')));
});

test('Balancer: Produktion ohne Arbeiter (Perpetuum mobile) wird abgelehnt', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const { pack, rejected } = balancePack(
    aiPack({
      buildings: [
        {
          id: 'magic_tree',
          name: { de: 'Zauberbaum' },
          category: 'production',
          epoch: 'stone_age',
          cost: { wood: 10 },
          workers: 0,
          production: { inputs: {}, outputs: { wood: 5 } },
        },
      ],
    }),
    registry,
    balance
  );
  assert.equal(pack.buildings.length, 0);
  assert.ok(rejected.some((r) => r.id === 'magic_tree'));
});

test('Balancer: übermächtige Outputs werden auf die Grenze skaliert', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const { pack, notes } = balancePack(
    aiPack({
      buildings: [
        {
          id: 'mega_lumberjack',
          name: { de: 'Mega-Holzfäller' },
          category: 'production',
          epoch: 'stone_age',
          cost: { wood: 100 },
          workers: 2,
          production: { inputs: {}, outputs: { wood: 50 } },
        },
      ],
    }),
    registry,
    balance
  );
  assert.equal(pack.buildings.length, 1);
  const out = pack.buildings[0].production.outputs.wood;
  // Relativgrenze: bester Stone-Age-Produzent liefert netto 0.6 (Sammlerhütte) → Cap 0.75
  assert.ok(out <= 0.75 + 1e-9, `Output ${out} überschreitet die Grenze`);
  assert.ok(notes.some((n) => n.includes('mega_lumberjack')));
});

test('Balancer: zu billige Gebäude bekommen höhere Baukosten (Amortisation)', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const { pack } = balancePack(
    aiPack({
      buildings: [
        {
          id: 'cheap_hut',
          name: { de: 'Billighütte' },
          category: 'production',
          epoch: 'stone_age',
          cost: { wood: 1 },
          workers: 2,
          production: { inputs: {}, outputs: { wood: 0.5 } },
        },
      ],
    }),
    registry,
    balance
  );
  assert.equal(pack.buildings.length, 1);
  // 0.5 Netto/Tick × 60 Ticks Mindest-Amortisation → Kostenwert ≥ 30
  assert.ok(pack.buildings[0].cost.wood >= 30);
});

test('Balancer: Epoche mit falscher order wird abgelehnt', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const { pack, rejected } = balancePack(
    aiPack({ epochs: [{ id: 'space_age', order: 7, name: { de: 'Weltraumzeit' }, advance: null }] }),
    registry,
    balance
  );
  assert.equal(pack.epochs.length, 0);
  assert.ok(rejected.some((r) => r.id === 'space_age'));
});

test('Balancer: Gebäude, das abgelehnte Ressource referenziert, fällt mit', async () => {
  const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
  const { pack, rejected } = balancePack(
    aiPack({
      resources: [
        { id: 'r1', name: { de: 'R1' }, category: 'raw', epoch: 'stone_age', baseValue: 1 },
        { id: 'r2', name: { de: 'R2' }, category: 'raw', epoch: 'stone_age', baseValue: 1 },
        { id: 'r3', name: { de: 'R3' }, category: 'raw', epoch: 'stone_age', baseValue: 1 },
        { id: 'r4', name: { de: 'R4' }, category: 'raw', epoch: 'stone_age', baseValue: 1 },
      ],
      buildings: [
        {
          id: 'b4',
          name: { de: 'B4' },
          category: 'production',
          epoch: 'stone_age',
          cost: { r4: 100 },
          workers: 1,
          production: { inputs: {}, outputs: { r4: 0.1 } },
        },
      ],
    }),
    registry,
    balance
  );
  // maxNewResourcesPerPack = 3 → r4 abgelehnt → b4 muss mitfallen
  assert.equal(pack.resources.length, 3);
  assert.equal(pack.buildings.length, 0);
  assert.ok(rejected.some((r) => r.id === 'r4'));
  assert.ok(rejected.some((r) => r.id === 'b4'));
});
