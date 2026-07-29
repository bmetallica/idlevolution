// Regression: Eine fehlgeschlagene Content-Generierung darf nicht den REST der
// Nacht mitreißen. Bis zum 29.07.2026 warf runNightly() sofort — dadurch fielen
// KI-Planung, Tagesziele, Kriegs-Auflösung und Online-Sync sechs Nächte lang
// stillschweigend mit aus.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
process.env.APP_URL = 'http://app.test';

const { runNightly } = await import('../src/ai/run-nightly.js');

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Stubt fetch: Spiel-API antwortet freundlich, der LLM-Aufruf schlägt fehl.
 * @returns {{routes: string[], restore: () => void}}
 */
function stubApi({ llmFails }) {
  const orig = globalThis.fetch;
  const routes = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) {
      const body = JSON.parse(opts.body);
      if (body.max_tokens === 1) return { ok: false, json: async () => ({ error: { n_ctx: 16384 } }), text: async () => '' };
      if (llmFails) return { ok: false, status: 500, json: async () => ({}), text: async () => 'GPU weg' };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"chronicle":{"de":"ok"}}' }, finish_reason: 'stop' }] }),
      };
    }
    const route = u.replace('http://app.test', '');
    routes.push(route);
    const payload = {
      '/api/ai/export': { epoch: { id: 'stone_age' }, gaps: [], allEpochs: [], resources: [], buildings: [] },
      '/api/ai/import': { status: 'accepted', accepted: { buildings: [], resources: [], epochs: [] } },
      '/api/players/plan': { planning: 2 },
      '/api/quests/generate': { count: 3, source: 'llm' },
      '/api/war/resolve': { battles: 1, reports: ['Raubzug abgewehrt'] },
      '/api/online/publish': { ok: true, instances: 5 },
      '/api/online/sync': { ok: true, islands: [{ ok: true }] },
    }[route] ?? {};
    return { ok: true, status: 200, json: async () => payload };
  };
  return { routes, restore: () => { globalThis.fetch = orig; } };
}

test('Nightly: scheitert die Generierung, laufen die übrigen Nacht-Aufgaben trotzdem', async () => {
  const { routes, restore } = stubApi({ llmFails: true });
  try {
    await assert.rejects(() => runNightly(silent), /Content-Generierung fehlgeschlagen/);
    // Genau das ist der Kern des Fixes: alles hinter der Generierung wurde erreicht.
    for (const r of ['/api/players/plan', '/api/quests/generate', '/api/war/resolve', '/api/online/publish', '/api/online/sync']) {
      assert.ok(routes.includes(r), `${r} muss trotz LLM-Ausfall laufen`);
    }
    assert.ok(routes.includes('/api/ai/runs'), 'Fehlschlag wird protokolliert');
    assert.ok(!routes.includes('/api/ai/import'), 'ohne Pack kein Import');
  } finally { restore(); }
});

test('Nightly: im Erfolgsfall wird importiert und der Lauf endet sauber', async () => {
  const { routes, restore } = stubApi({ llmFails: false });
  try {
    const res = await runNightly(silent);
    assert.equal(res.status, 'accepted');
    assert.ok(routes.includes('/api/ai/import'));
    assert.ok(routes.includes('/api/online/sync'));
  } finally { restore(); }
});
