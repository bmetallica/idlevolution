// Tests für die Kontext-Budgetierung des LLM-Clients und den gedeckelten Export.
// Hintergrund: Ab dem 24.07.2026 schlug jede Nacht fehl, weil der Prompt mit dem
// Spielstand wuchs, der Server aber nur 16384 statt der konfigurierten 32768
// Tokens Kontext bot — max_tokens wurde still gekappt und das Reasoning-Modell
// lief aus, bevor das erste JSON-Zeichen kam.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  messagesTokens,
  discoverContext,
  chatCompletion,
  _resetContextCache,
} from '../src/ai/generator.js';

const LLM = { baseUrl: 'http://llm.test', model: 'testmodell', ctx: 32768, maxTokens: 12288, temperature: 0.7 };

/** Ersetzt fetch: erste Antwort = Kontext-Sonde, danach frei konfigurierbar. */
function stubFetch({ nCtx = 16384, reply, onRequest } = {}) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    onRequest?.(body);
    // Kontext-Sonde erkennen: überlanger Prompt, max_tokens 1
    if (body.max_tokens === 1) {
      return {
        ok: false,
        json: async () => ({ error: { code: 400, n_ctx: nCtx, message: 'exceeds context' } }),
        text: async () => 'exceeds context',
      };
    }
    return { ok: true, json: async () => reply(body), text: async () => '' };
  };
  return () => { globalThis.fetch = orig; };
}

test('estimateTokens/messagesTokens schätzen leicht pessimistisch', () => {
  assert.ok(estimateTokens('a'.repeat(310)) >= 100);
  const msgs = [{ role: 'system', content: 'x'.repeat(310) }, { role: 'user', content: 'y'.repeat(310) }];
  // 2 × 100 Tokens + 2 × 4 Rollenmarker
  assert.equal(messagesTokens(msgs), 208);
});

test('discoverContext liest das echte n_ctx aus der Server-Fehlermeldung und cached es', async () => {
  _resetContextCache();
  let calls = 0;
  const restore = stubFetch({ nCtx: 16384, onRequest: () => { calls++; }, reply: () => ({}) });
  try {
    assert.equal(await discoverContext(LLM), 16384, 'echtes n_ctx schlägt LLM_CTX');
    assert.equal(await discoverContext(LLM), 16384);
    assert.equal(calls, 1, 'zweiter Aufruf kommt aus dem Cache');
  } finally { restore(); _resetContextCache(); }
});

test('discoverContext fällt bei unbrauchbarer Antwort auf LLM_CTX zurück', async () => {
  _resetContextCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Netz weg'); };
  try {
    assert.equal(await discoverContext(LLM), 32768);
  } finally { globalThis.fetch = orig; _resetContextCache(); }
});

test('chatCompletion leitet max_tokens aus (n_ctx − Prompt) ab statt aus LLM_MAX_TOKENS', async () => {
  _resetContextCache();
  let sent;
  const restore = stubFetch({
    nCtx: 16384,
    onRequest: (b) => { if (b.max_tokens !== 1) sent = b; },
    reply: () => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }),
  });
  try {
    // ~25000 Zeichen ≈ 8065 Tokens Prompt → Restbudget < LLM_MAX_TOKENS
    const msgs = [{ role: 'user', content: 'x'.repeat(25000) }];
    await chatCompletion(LLM, msgs);
    const expected = 16384 - messagesTokens(msgs) - 256;
    assert.equal(sent.max_tokens, expected, 'Budget = n_ctx − Prompt − Reserve');
    assert.ok(sent.max_tokens < LLM.maxTokens, 'greift vor dem konfigurierten Maximum');

    // Umgekehrt bleibt LLM_MAX_TOKENS die Obergrenze, wenn reichlich Platz ist
    await chatCompletion(LLM, [{ role: 'user', content: 'kurz' }]);
    assert.equal(sent.max_tokens, LLM.maxTokens);
  } finally { restore(); _resetContextCache(); }
});

test('chatCompletion schaltet Reasoning ab (Standard) und lässt es auf Wunsch zu', async () => {
  _resetContextCache();
  let sent;
  const restore = stubFetch({
    onRequest: (b) => { if (b.max_tokens !== 1) sent = b; },
    reply: () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }),
  });
  try {
    await chatCompletion(LLM, [{ role: 'user', content: 'hallo' }]);
    assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });

    await chatCompletion({ ...LLM, thinking: true }, [{ role: 'user', content: 'hallo' }]);
    assert.equal(sent.chat_template_kwargs, undefined, 'LLM_THINKING=true lässt das Modell denken');
  } finally { restore(); _resetContextCache(); }
});

test('chatCompletion rettet JSON aus reasoning_content, wenn content leer bleibt', async () => {
  _resetContextCache();
  const restore = stubFetch({
    reply: () => ({
      choices: [{ message: { content: '', reasoning_content: 'Also gut: {"chronicle":{"de":"x"}}' }, finish_reason: 'stop' }],
    }),
  });
  try {
    const out = await chatCompletion(LLM, [{ role: 'user', content: 'hallo' }]);
    assert.match(out, /chronicle/);
  } finally { restore(); _resetContextCache(); }
});

test('chatCompletion verweigert einen Prompt, der den Kontext sprengt — mit brauchbarer Diagnose', async () => {
  _resetContextCache();
  const restore = stubFetch({ nCtx: 16384, reply: () => ({}) });
  try {
    // 60000 Zeichen ≈ 19355 Tokens > 16384
    await assert.rejects(
      () => chatCompletion(LLM, [{ role: 'user', content: 'x'.repeat(60000) }]),
      /Prompt zu groß für 'testmodell'.*16384/s
    );
  } finally { restore(); _resetContextCache(); }
});

test('chatCompletion meldet erschöpftes Budget mit Zahlen statt pauschalem Hinweis', async () => {
  _resetContextCache();
  const restore = stubFetch({
    reply: () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
  });
  try {
    await assert.rejects(
      () => chatCompletion(LLM, [{ role: 'user', content: 'hallo' }]),
      /Token-Budget erschöpft.*max_tokens=\d+.*von 16384/s
    );
  } finally { restore(); _resetContextCache(); }
});
