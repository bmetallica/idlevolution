import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, migrate } from './db/index.js';
import { createRegistryHolder } from './content/loader.js';
import { loadGameConfig, loadState, saveState, logEvent } from './engine/state.js';
import { runTick, runTicks } from './engine/tick.js';
import gameRoutes from './routes/game.js';
import contentRoutes from './routes/content.js';
import aiRoutes from './routes/ai.js';

const fastify = Fastify({ logger: { level: 'info' } });
const log = fastify.log;

// ── Bootstrap: DB → Content → Spielzustand → Offline-Aufholung ──
await migrate(log);

const { game, balance } = await loadGameConfig(config.dataDir);
const registryHolder = createRegistryHolder(config.dataDir, log);
await registryHolder.reload();
if (registryHolder.registry.epochs.size === 0) {
  log.error('Keine Epochen geladen — ohne Content-Packs kann das Spiel nicht starten.');
  process.exit(1);
}

const state = await loadState(pool, game, registryHolder.registry);

// Offline-Progression: verpasste Ticks seit dem letzten Speichern nachholen (Idle-Kern)
const elapsedMs = Date.now() - state.lastTickAt;
const capTicks = Math.floor((config.offlineCapHours * 3600) / config.tickSeconds);
const missedTicks = Math.min(capTicks, Math.floor(elapsedMs / 1000 / config.tickSeconds));
if (missedTicks > 0) {
  const events = runTicks(registryHolder.registry, state, game, missedTicks);
  await saveState(pool, state);
  log.info(`Offline-Progression: ${missedTicks} Ticks nachgeholt (${events.length} Ereignisse)`);
}

// ── App-Kontext für alle Routen ──
const ctx = { config, pool, registryHolder, state, game, balance };
fastify.decorate('gameCtx', ctx);

fastify.get('/healthz', async () => ({ ok: true, tick: state.tick }));
await fastify.register(gameRoutes);
await fastify.register(contentRoutes);
await fastify.register(aiRoutes);

// Gebautes Frontend ausliefern (Multi-Stage-Build legt es nach ./public)
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
await fastify.register(fastifyStatic, { root: publicDir, prefix: '/' });

// ── Tick-Loop ──
let tickCounter = 0;
const interval = setInterval(async () => {
  try {
    const events = runTick(registryHolder.registry, state, game);
    for (const e of events) {
      logEvent(pool, e.type, e.payload).catch(() => {});
      if (e.type === 'epoch_advance') log.info(`Epochen-Aufstieg: ${e.payload.from} → ${e.payload.to}`);
    }
    tickCounter += 1;
    if (tickCounter % config.persistEveryTicks === 0) await saveState(pool, state);
  } catch (err) {
    log.error(`Tick fehlgeschlagen: ${err.message}`);
  }
}, config.tickSeconds * 1000);

// ── Sauberes Herunterfahren: Zustand sichern ──
const shutdown = async (signal) => {
  log.info(`${signal} empfangen — speichere Spielstand…`);
  clearInterval(interval);
  try {
    await saveState(pool, state);
  } catch (err) {
    log.error(`Speichern beim Shutdown fehlgeschlagen: ${err.message}`);
  }
  await fastify.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await fastify.listen({ port: config.port, host: '0.0.0.0' });
