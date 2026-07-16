// E1: Tagesziele — Validierung, Fallback und Einlösen sind rein mechanisch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadRegistry } from '../src/content/loader.js';
import { validateQuests, fallbackQuests, claimQuest, questProgress, MAX_QUESTS } from '../src/engine/quests.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const silent = { warn() {}, info() {} };
const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
const { game } = JSON.parse(await readFile(path.join(dataDir, 'balance.config.json'), 'utf8'));

const mkState = () => ({
  tick: 100,
  epochId: 'stone_age',
  population: 20,
  resources: { wood: 50, stone: 20, food: 80 },
  buildings: { gatherer_hut: { count: 2, workers: 2 }, hut: { count: 3, workers: 0 } },
  instances: [],
});

test('Quests: validateQuests kappt Mengen, filtert Müll, deckelt auf MAX', () => {
  const state = mkState();
  const items = validateQuests(
    [
      { type: 'build', buildingId: 'gatherer_hut', amount: 99, title: { de: 'Sammeln!' } }, // → 5 gekappt
      { type: 'build', buildingId: 'DOES_NOT_EXIST', amount: 1 }, // raus
      { type: 'stock', resourceId: 'wood', amount: 999999 }, // an Lagerkapazität gekappt
      { type: 'population', amount: 5 }, // schon erreicht → raus
      { type: 'population', amount: 999999 }, // an Wohnraum gekappt
      { type: 'stock', resourceId: 'stone', amount: 60 },
    ],
    registry, state, game
  );
  assert.ok(items.length <= MAX_QUESTS);
  const build = items.find((q) => q.type === 'build');
  assert.ok(build && build.amount <= 5, 'build-Menge nicht gekappt');
  assert.equal(build.baseline, 2); // zählt nur NEUE Gebäude
  for (const q of items) {
    assert.ok(q.reward?.resourceId && q.reward.amount > 0, 'Belohnung fehlt');
    assert.ok(q.title.length > 0);
  }
});

test('Quests: Fallback liefert erreichbare Ziele ohne LLM', () => {
  const state = mkState();
  const items = fallbackQuests(registry, state, game);
  assert.ok(items.length >= 2, 'Fallback zu dünn');
  for (const q of items) {
    const p = questProgress(state, q);
    assert.equal(p.done, false, `Fallback-Ziel '${q.title}' ist schon erledigt`);
  }
});

test('Quests: claim nur bei erreichtem Ziel, Belohnung einmalig', () => {
  const state = mkState();
  state.quests = { generatedAt: new Date().toISOString(), items: validateQuests(
    [{ type: 'stock', resourceId: 'wood', amount: 60 }], registry, state, game
  ) };
  const q = state.quests.items[0];
  assert.throws(() => claimQuest(registry, state, game, q.id), /nicht erreicht/);
  state.resources.wood = 60; // Ziel erfüllen
  const before = state.resources[q.reward.resourceId] ?? 0;
  claimQuest(registry, state, game, q.id);
  assert.ok((state.resources[q.reward.resourceId] ?? 0) > before || q.reward.resourceId === 'wood', 'Belohnung nicht gutgeschrieben');
  assert.equal(q.claimed, true);
  assert.throws(() => claimQuest(registry, state, game, q.id), /bereits/);
});
