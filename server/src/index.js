import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, migrate } from './db/index.js';
import { createRegistryHolder } from './content/loader.js';
import { loadGameConfig, logEvent } from './engine/state.js';
import { runTick, runTicks } from './engine/tick.js';
import { bootWorld, savePlayer, saveWorld } from './engine/players.js';
import { growIslandRegion } from './engine/world.js';
import { runExecutor } from './ai/executor.js';
import { tickShips } from './engine/ships.js';
import { aiConsiderTrade, aiPostOffer } from './engine/trade.js';
import gameRoutes from './routes/game.js';
import contentRoutes from './routes/content.js';
import aiRoutes from './routes/ai.js';
import onlineRoutes from './routes/online.js';

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

// Welt + Spieler laden (migriert bestehende Single-Player-Stände beim ersten Start)
const { world, players, migrated } = await bootWorld(pool, game, registryHolder.registry, {
  islandCount: 5, islandSize: 44, gap: 18,
});
if (migrated) log.info(`Migration: Alt-Stand als Insel 0 in Mehr-Insel-Welt eingebettet (${world.width}×${world.height}, ${world.islands.length} Inseln)`);
const human = players.find((p) => p.kind === 'human') || players[0];

// Offline-Progression je aktivem Spieler: verpasste Ticks seit letztem Speichern nachholen
const capTicks = Math.floor((config.offlineCapHours * 3600) / config.tickSeconds);
for (const p of players) {
  if (p.active === false) continue;
  const missed = Math.min(capTicks, Math.floor((Date.now() - (p.lastTickAt || Date.now())) / 1000 / config.tickSeconds));
  if (missed > 0) {
    const events = runTicks(registryHolder.registry, p, game, missed);
    p.lastTickAt = Date.now();
    await savePlayer(pool, p);
    log.info(`Offline-Progression [${p.name}]: ${missed} Ticks nachgeholt (${events.length} Ereignisse)`);
  }
}

// ── App-Kontext für alle Routen ── (ctx.state = menschlicher Spieler; abwärtskompatibel)
const ctx = { config, pool, registryHolder, world, players, human, state: human, game, balance };
fastify.decorate('gameCtx', ctx);

fastify.get('/healthz', async () => ({ ok: true, tick: human.tick }));
await fastify.register(gameRoutes);
await fastify.register(contentRoutes);
await fastify.register(aiRoutes);
await fastify.register(onlineRoutes);

// Gebautes Frontend ausliefern (Multi-Stage-Build legt es nach ./public)
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
await fastify.register(fastifyStatic, { root: publicDir, prefix: '/' });

// ── Tick-Loop (über alle aktiven Spieler) ──
let tickCounter = 0;
const interval = setInterval(async () => {
  try {
    for (const p of players) {
      if (p.active === false) continue;
      if (p.kind === 'ai') runExecutor(registryHolder.registry, p, game); // KI-Zug (Stufe 1)
      const events = runTick(registryHolder.registry, p, game);
      for (const e of events) {
        logEvent(pool, e.type, { ...e.payload, player: p.id }).catch(() => {});
        if (e.type === 'epoch_advance') {
          log.info(`Epochen-Aufstieg [${p.name}]: ${e.payload.from} → ${e.payload.to}`);
          // Insel wächst inselintern (mehr Baufläche), ohne Nachbarn zu überrennen
          if (growIslandRegion(world, p.islandId)) {
            const isl = world.islands.find((i) => i.id === p.islandId);
            if (isl) p.region = { x: isl.x, y: isl.y, w: isl.w, h: isl.h };
            for (const pl of players) if (pl.map) { pl.map.tiles = world.tiles; pl.map.width = world.width; pl.map.height = world.height; }
            await saveWorld(pool, world);
            await savePlayer(pool, p);
            log.info(`Insel [${p.name}] gewachsen → Region ${isl?.w}×${isl?.h} (Welt-Version ${world.version})`);
          }
        }
      }
    }
    // KI-Handel (Stufe 5): KI prüft ab und zu offene Angebote an und stellt eigene ein
    if (tickCounter % 12 === 0) for (const p of players) if (p.kind === 'ai' && p.active !== false) {
      aiConsiderTrade(world, players, p, registryHolder.registry, human.tick);
      aiPostOffer(world, p, registryHolder.registry, human.tick);
    }
    // Schiffe (Stufe 4) über den Ozean vorrücken; angekommene Ladung ausliefern.
    // (Kämpfe laufen NICHT hier — Kriegserklärungen werden im nächtlichen
    //  KI-Lauf aufgelöst, damit Mensch und Tageszug-KI fair bleiben.)
    const delivered = tickShips(world, players, human.tick);
    for (const s of delivered) logEvent(pool, 'ship_arrived', { from: s.owner, to: s.toOwner, cargo: s.cargo }).catch(() => {});
    tickCounter += 1;
    if (delivered.length || tickCounter % config.persistEveryTicks === 0) {
      for (const p of players) {
        if (p.active === false) continue;
        p.lastTickAt = Date.now();
        await savePlayer(pool, p);
      }
      await saveWorld(pool, world);
    }
  } catch (err) {
    log.error(`Tick fehlgeschlagen: ${err.message}`);
  }
}, config.tickSeconds * 1000);

// ── Sauberes Herunterfahren: Zustand sichern ──
const shutdown = async (signal) => {
  log.info(`${signal} empfangen — speichere Spielstände…`);
  clearInterval(interval);
  try {
    for (const p of players) { p.lastTickAt = Date.now(); await savePlayer(pool, p); }
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
