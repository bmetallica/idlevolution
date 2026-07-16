// C2: Ökonomie-Langlauftest — dauerhaftes Frühwarnsystem gegen Todesspiralen.
// Eine KI-Insel baut sich 10.000 Ticks (~14 h Spielzeit) selbstständig auf.
// Invarianten: Bevölkerung wächst (mindestens: fällt nie unter den Start),
// keine Ressource wird NaN/∞, Zufriedenheit bleibt eine gültige Zahl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadRegistry } from '../src/content/loader.js';
import { runTick } from '../src/engine/tick.js';
import { generateWorld } from '../src/engine/world.js';
import { newPlayerOnIsland } from '../src/engine/players.js';
import { runExecutor } from '../src/ai/executor.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const silent = { warn() {}, info() {} };
const registry = await loadRegistry(dataDir, silent, { includeGenerated: false });
const { game } = JSON.parse(await readFile(path.join(dataDir, 'balance.config.json'), 'utf8'));

test('Langlauf 10k Ticks: KI-Aufbau bleibt stabil (keine Spirale, kein NaN/∞)', () => {
  const world = { ...generateWorld(4242, { islandCount: 2, islandSize: 44, gap: 16 }), version: 1 };
  const p = newPlayerOnIsland(game, registry, world, 0, { id: 1, kind: 'ai', name: 'Langlauf' });
  const popStart = p.population;

  let minPop = p.population;
  for (let t = 0; t < 10000; t++) {
    if (t % 60 === 0) runExecutor(registry, p, game); // 1 KI-Zug je ~5 min Spielzeit
    runTick(registry, p, game);
    if (p.population < minPop) minPop = p.population;
    // NaN früh erkennen — mit Tick-Angabe ist die Regression sofort eingrenzbar
    if (!Number.isFinite(p.population)) assert.fail(`Bevölkerung wurde ${p.population} bei Tick ${t}`);
  }

  assert.ok(Number.isFinite(p.satisfaction ?? 1), 'Zufriedenheit ist keine Zahl');
  for (const [rid, amount] of Object.entries(p.resources)) {
    assert.ok(Number.isFinite(amount), `Ressource '${rid}' wurde ${amount}`);
    assert.ok(amount < 1e9, `Ressource '${rid}' explodiert (${amount})`);
  }
  // Kein Kollaps unterwegs: nie unter die Hälfte des Starts gefallen
  assert.ok(minPop >= popStart * 0.5, `Bevölkerung fiel unterwegs auf ${Math.floor(minPop)} (Start ${Math.floor(popStart)})`);
  // Am Ende mindestens auf Startniveau (der Aufbau soll tragen, nicht zehren)
  assert.ok(p.population >= popStart, `Bevölkerung am Ende ${Math.floor(p.population)} < Start ${Math.floor(popStart)}`);
});
