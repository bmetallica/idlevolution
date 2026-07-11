import { config } from './config.js';
import { pool } from './db/index.js';
import { createRegistryHolder } from './content/loader.js';
import { loadGameConfig } from './engine/state.js';
import { loadWorld, loadPlayers } from './engine/players.js';
import { chatCompletion } from './ai/generator.js';
import { planTurn } from './ai/strategist.js';

const { game } = await loadGameConfig(config.dataDir);
const holder = createRegistryHolder(config.dataDir, { warn() {}, info() {} });
await holder.reload();
const world = await loadWorld(pool);
const players = await loadPlayers(pool, world);
const ai = players.find((p) => p.kind === 'ai');
console.log('KI:', ai?.name, '| LLM:', config.llm.baseUrl, config.llm.model);

// 1) roher LLM-Test (einfacher Ping)
try {
  const ping = await chatCompletion(config.llm, [{ role: 'user', content: 'Antworte nur mit: OK' }]);
  console.log('LLM-Ping:', JSON.stringify(String(ping).slice(0, 120)));
} catch (e) { console.log('LLM-Ping FEHLER:', e.message); }

// 2) echter Plan
try {
  const plan = await planTurn(holder.registry, ai, game, config.llm);
  console.log('PLAN OK:', JSON.stringify(plan, null, 2).slice(0, 600));
} catch (e) { console.log('PLAN FEHLER:', e.message); }

await pool.end();
