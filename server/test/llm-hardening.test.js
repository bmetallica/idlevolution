// Tests für die Härtung aus updates.md 2.2/2.4/2.5: tolerante i18n-Felder,
// Epochen-Gate in Schema+Prompt, shape als Enum.
import test from 'node:test';
import assert from 'node:assert/strict';
import { llmPackSchema, buildMessages, epochsWelcome, nextEpochOrder } from '../src/ai/generator.js';
import { BUILDING_SHAPES, isKnownShape } from '../src/content/shapes.js';
import { _coerceI18n, _normalizePack } from '../src/ai/importer.js';

const BAL = { minAmortizationTicks: 60, workerValuePerTick: 0.3, netValueSlack: 1.5, epochValueGrowth: 2 };

// ── 2.2 i18n tolerant ────────────────────────────────────────────────────────

test('coerceI18n: nackter String wird zu {de} — häufigste strukturelle Ablehnung', () => {
  const b = _coerceI18n({ id: 'x', name: 'Werkstatt', description: 'Stellt Werkzeug her' });
  assert.deepEqual(b.name, { de: 'Werkstatt' });
  assert.deepEqual(b.description, { de: 'Stellt Werkzeug her' });
});

test('coerceI18n: fehlendes de wird aus einer anderen Sprache gefüllt statt zu scheitern', () => {
  const b = _coerceI18n({ id: 'x', name: { en: 'Workshop' } });
  assert.equal(b.name.de, 'Workshop');
  assert.equal(b.name.en, 'Workshop');
});

test('coerceI18n: unbrauchbare Werte fliegen raus, gültige bleiben unangetastet', () => {
  const b = _coerceI18n({ name: { de: 'Halle', en: 42 }, description: '   ', title: { de: 'Ziel' } });
  assert.deepEqual(b.name, { de: 'Halle' }, 'nicht-String-Sprachwert entfernt');
  assert.equal(b.description, undefined, 'leerer String entfernt');
  assert.deepEqual(b.title, { de: 'Ziel' });
});

test('normalizePack: coercion greift für alle Item-Listen und den Stufennamen', () => {
  const p = _normalizePack({
    chronicle: 'Ein Tag',
    buildings: [{ id: 'a', name: 'Haus' }],
    resources: [{ id: 'r', name: 'Erz' }],
    epochs: [{ id: 'e', order: 1, name: 'Neuzeit', tier: { name: 'Bürger' } }],
  });
  assert.deepEqual(p.chronicle, { de: 'Ein Tag' });
  assert.deepEqual(p.buildings[0].name, { de: 'Haus' });
  assert.deepEqual(p.resources[0].name, { de: 'Erz' });
  assert.deepEqual(p.epochs[0].tier.name, { de: 'Bürger' });
});

// ── 2.5 shape als Enum ───────────────────────────────────────────────────────

test('Schema führt meta.art.shape als Enum statt als freien String', () => {
  const shape = llmPackSchema().properties.buildings.items.properties.meta.properties.art.properties.shape;
  assert.deepEqual(shape, { enum: BUILDING_SHAPES });
  assert.ok(!isKnownShape('production'), 'Kategorien sind keine Silhouetten');
  assert.ok(isKnownShape('fountain'));
});

test('normalizePack verwirft ungültiges shape, statt die Kategorie einzusetzen', () => {
  // Vorher setzte der Importer ersatzweise b.category — daher "shape: production"
  // in echten Packs. Ohne shape rät der Client aus Funktion/Name deutlich besser.
  const p = _normalizePack({ buildings: [{ id: 'a', category: 'production', meta: { art: { shape: 'production' } } }] });
  assert.equal(p.buildings[0].meta.art.shape, undefined);

  const ok = _normalizePack({ buildings: [{ id: 'b', category: 'civic', meta: { art: { shape: 'fountain' } } }] });
  assert.equal(ok.buildings[0].meta.art.shape, 'fountain', 'gültige Silhouette bleibt');
});

// ── 2.4 Epochen-Gate ─────────────────────────────────────────────────────────

const EXPORT_MITTE = { epoch: { order: 3 }, allEpochs: [{ id: 'a', order: 3 }, { id: 'b', order: 8 }], resources: [], buildings: [] };
const EXPORT_ENDE = { epoch: { order: 8 }, allEpochs: [{ id: 'a', order: 3 }, { id: 'b', order: 8 }], resources: [], buildings: [] };

test('epochsWelcome: nur an der Spitze der Epochen-Kette', () => {
  assert.equal(epochsWelcome(EXPORT_MITTE), false, 'es gibt noch eine Folge-Epoche');
  assert.equal(epochsWelcome(EXPORT_ENDE), true);
  assert.equal(nextEpochOrder(EXPORT_ENDE), 9);
});

test('Schema bietet Epochen gar nicht erst an, wenn der Aufstieg fern ist', () => {
  const zu = llmPackSchema({ allowEpochs: false });
  assert.equal(zu.properties.epochs, undefined);
  assert.equal(zu.properties.epochAdvance, undefined);
  assert.ok(zu.properties.buildings, 'Gebäude bleiben natürlich erlaubt');
});

test('Schema erzwingt die einzig freie order — Grammatik kann keine vergebene erzeugen', () => {
  const auf = llmPackSchema({ allowEpochs: true, nextOrder: 9 });
  assert.deepEqual(auf.properties.epochs.items.properties.order, { const: 9 });
});

test('Prompt spiegelt das Epochen-Gate: keine Epochen-Regeln, wenn keine erlaubt sind', () => {
  const zu = buildMessages(EXPORT_MITTE, BAL).find((m) => m.role === 'system').content;
  assert.match(zu, /Neue EPOCHEN sind in diesem Pack NICHT vorgesehen/);
  assert.match(zu, /Lege KEINE neue Epoche an/);
  assert.ok(!zu.includes('"epochAdvance": {'), 'kein Token für ungenutzte Felder');

  const auf = buildMessages(EXPORT_ENDE, BAL).find((m) => m.role === 'system').content;
  assert.match(auf, /order \(MUSS exakt 9 sein\)/);
  assert.match(auf, /order genau 9/);
});
