// updates.md 2.3 — zweistufige Dubletten-Sperre.
// Der Kern ist das FUNKTIONALE GATE: Reine Text-Ähnlichkeit trennt in dieser
// Domäne nachweislich nicht (gemessen: "Sägewerk"/"Werkzeugmacher" 0.798 liegt
// so hoch wie echte Dubletten 0.795). Diese Tests halten fest, WAS überhaupt
// verglichen wird — dort entsteht die Trennschärfe, nicht in der Schwelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { functionalKey, isComparable, describeBuilding, findDuplicateBuildings } from '../src/ai/similarity.js';

const sawmill = { id: 'sawmill', category: 'production', name: { de: 'Sägewerk' }, production: { inputs: { wood: 1 }, outputs: { planks: 1 } } };
const toolmaker = { id: 'toolmaker', category: 'production', name: { de: 'Werkzeugmacher' }, production: { inputs: { planks: 1 }, outputs: { tools: 1 } } };
const sawmill2 = { id: 'holzschneiderei', category: 'production', name: { de: 'Holzschneiderei' }, production: { inputs: { wood: 1 }, outputs: { planks: 1 } } };
const plaza = { id: 'plaza', category: 'civic', name: { de: 'Marktplatz' } };
const tower = { id: 'tower', category: 'civic', name: { de: 'Wachturm' } };

test('functionalKey trennt Gebäude mit unterschiedlichen Ausgängen', () => {
  assert.notEqual(functionalKey(sawmill), functionalKey(toolmaker));
  assert.equal(functionalKey(sawmill), functionalKey(sawmill2), 'gleiche Funktion → vergleichbar');
});

test('isComparable schließt den nichtssagenden Zivilbau-Sammeltopf aus', () => {
  // Forschungsstation, Marktplatz und Wachturm teilen sich sonst eine Signatur
  // und erreichen 0.833 Ähnlichkeit, ohne Dubletten zu sein.
  assert.equal(isComparable(plaza), false);
  assert.equal(isComparable(tower), false);
  assert.equal(isComparable(sawmill), true);
  assert.equal(isComparable({ category: 'housing', housing: { capacity: 10 } }), true);
  assert.equal(isComparable({ category: 'storage', storage: { '*': 100 } }), true);
});

test('describeBuilding nutzt Name und Beschreibung', () => {
  assert.equal(describeBuilding({ id: 'x', name: { de: 'Halle' }, description: { de: 'Lagert Waren' } }), 'Halle. Lagert Waren');
  assert.equal(describeBuilding({ id: 'nur_id' }), 'nur_id.');
});

/** Stubt den Embedding-Server mit vorgegebenen Vektoren je Text. */
function stubEmbeddings(vectorFor) {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    const { input } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ data: input.map((t) => ({ embedding: vectorFor(t) })) }) };
  };
  return { restore: () => { globalThis.fetch = orig; }, get calls() { return calls; } };
}

const LLM = { baseUrl: 'http://llm.test', embedModel: 'nomic-embed-text' };

test('funktionsverschiedene Gebäude werden gar nicht erst eingebettet', async () => {
  const s = stubEmbeddings(() => [1, 0]);
  try {
    // toolmaker hat andere Ausgänge als sawmill → kein Vergleichspartner
    const hits = await findDuplicateBuildings([toolmaker], [sawmill], LLM, 0.8);
    assert.deepEqual(hits, []);
    assert.equal(s.calls, 0, 'kein Embedding-Aufruf → spart Zeit und verhindert Fehlalarme');
  } finally { s.restore(); }
});

test('Zivilbauten ohne Produktion lösen keine Sperre aus, egal wie ähnlich', async () => {
  const s = stubEmbeddings(() => [1, 0]); // identische Vektoren = Ähnlichkeit 1.0
  try {
    const hits = await findDuplicateBuildings([plaza], [tower], LLM, 0.8);
    assert.deepEqual(hits, [], 'lieber eine Dublette durchlassen als ein legitimes Gebäude verwerfen');
    assert.equal(s.calls, 0);
  } finally { s.restore(); }
});

test('funktionsgleiches Gebäude über der Schwelle wird als Dublette gemeldet', async () => {
  const s = stubEmbeddings((t) => (t.startsWith('Sägewerk') || t.startsWith('Holzschneiderei') ? [1, 0.05] : [0, 1]));
  try {
    const hits = await findDuplicateBuildings([sawmill2], [sawmill], LLM, 0.8);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'holzschneiderei');
    assert.equal(hits[0].similarTo, 'sawmill');
    assert.ok(hits[0].score > 0.8);
  } finally { s.restore(); }
});

test('funktionsgleich, aber inhaltlich verschieden → bleibt erhalten', async () => {
  const s = stubEmbeddings((t) => (t.startsWith('Sägewerk') ? [1, 0] : [0.3, 0.954]));
  try {
    const hits = await findDuplicateBuildings([sawmill2], [sawmill], LLM, 0.8);
    assert.deepEqual(hits, []);
  } finally { s.restore(); }
});

test('fällt der Embedding-Server aus, wirft die Prüfung — der Aufrufer fängt das ab', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    await assert.rejects(() => findDuplicateBuildings([sawmill2], [sawmill], LLM, 0.8), /Embedding HTTP 503/);
  } finally { globalThis.fetch = orig; }
});
