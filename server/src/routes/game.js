import {
  computeNetRates,
  storageCapacity,
  totalHousing,
  buildingUnlockStatus,
  startBuild,
  demolish,
  assignWorkers,
  currentEpoch,
} from '../engine/tick.js';
import { describeConditions } from '../engine/rules.js';
import { epochsInOrder } from '../content/loader.js';
import { logEvent, saveState } from '../engine/state.js';
import { TERRAIN, setRoad, roadCoverage, footprintOf, canPlace, setDeco } from '../engine/map.js';
import { ROAD_MAX_BONUS } from '../engine/tick.js';
import { askAdvisor } from '../ai/advisor.js';
import { rename, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function findPackFile(dataDir, packId) {
  const walk = async (d) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { const r = await walk(full); if (r) return r; }
      else if (e.name === `${packId}.json`) return full;
    }
    return null;
  };
  return walk(path.join(dataDir, 'content', 'generated'));
}

export default async function gameRoutes(fastify) {
  const ctx = fastify.gameCtx;

  fastify.get('/api/state', async () => {
    const { registry } = ctx.registryHolder;
    const { state, game } = ctx;
    const rates = computeNetRates(registry, state, game);
    const epoch = currentEpoch(registry, state);
    const nextEpoch = epoch ? epochsInOrder(registry).find((e) => e.order === epoch.order + 1) : null;
    const workforce = Math.floor(state.population);
    const assigned = Object.values(state.buildings).reduce((s, b) => s + (b.workers ?? 0), 0);

    // Bevölkerungs-Trend + Grund (damit sichtbar ist, WARUM sie schrumpft)
    const foodNeed = state.population * game.foodPerPopPerTick;
    let foodAvail = 0, foodRate = 0;
    for (const r of registry.resources.values()) if (r.category === 'food') { foodAvail += state.resources[r.id] || 0; foodRate += rates[r.id] || 0; }
    const sat = state.satisfaction ?? 1;
    const housingCap = totalHousing(registry, state, game);

    // Stufen-Bedürfnisse (epoch.needs) inkl. Netto-Rate — deckt auf, wenn ein
    // gefordertes Gut schneller verbraucht als produziert wird (drainender Vorrat).
    const needsDetail = epoch?.needs
      ? Object.entries(epoch.needs).map(([rid, perPop]) => {
          const need = state.population * perPop;
          const have = state.resources[rid] ?? 0;
          const rate = rates[rid] ?? 0; // Netto pro Tick NACH Bedarf (computeNetRates zieht Bedarf ab)
          return {
            id: rid,
            name: registry.resources.get(rid)?.name?.de || rid,
            perPop,
            need: Math.round(need * 100) / 100,
            have: Math.round(have * 10) / 10,
            rate: Math.round(rate * 1000) / 1000,
            ok: have + 1e-6 >= need,
            draining: rate < -1e-6, // Vorrat schrumpft trotz evtl. aktuellem Puffer
          };
        })
      : [];
    const missingNeeds = needsDetail.filter((n) => !n.ok);
    const drainingNeeds = needsDetail.filter((n) => n.ok && n.draining);

    let popTrend = 'stable', popReason = null;
    if (foodAvail + 1e-6 < foodNeed) { popTrend = 'shrinking'; popReason = 'Nahrungsmangel — es wird zu wenig Nahrung produziert'; }
    else if (sat < 0.4) {
      popTrend = 'shrinking';
      const names = missingNeeds.map((n) => n.name).join(', ') || 'benötigte Güter';
      popReason = `Unzufriedenheit — es fehlt: ${names} (Stufen-Bedarf der Bevölkerung nicht gedeckt)`;
    }
    else if (drainingNeeds.length) { popReason = `Warnung — Vorrat schrumpft: ${drainingNeeds.map((n) => n.name).join(', ')} (bald Unzufriedenheit)`; if (state.population + 1e-6 < housingCap) popTrend = 'growing'; }
    else if (state.population + 1e-6 < housingCap) { popTrend = 'growing'; popReason = null; }

    return {
      tick: state.tick,
      tickSeconds: ctx.config.tickSeconds,
      epoch: epoch && {
        id: epoch.id,
        order: epoch.order,
        name: epoch.name,
        tier: epoch.tier?.name || null,
        next: nextEpoch ? { id: nextEpoch.id, name: nextEpoch.name } : null,
        progress: describeConditions(epoch.advance, registry, state),
        needs: needsDetail,
      },
      satisfaction: state.satisfaction ?? 1,
      popTrend,
      popReason,
      food: {
        available: Math.round(foodAvail * 10) / 10,
        needPerTick: Math.round(foodNeed * 100) / 100,
        rate: Math.round(foodRate * 1000) / 1000,
        sufficient: foodAvail + 1e-6 >= foodNeed,
      },
      mapVersion: state.mapVersion || 0,
      roads: [...(state.roads || [])],
      placed: state.placed || {},
      cleared: [...(state.cleared || [])],
      logistics: (() => {
        const cov = roadCoverage(state, registry);
        return { roadTiles: state.roads?.size ?? 0, coverage: Math.round(cov * 100) / 100, bonus: Math.round(cov * ROAD_MAX_BONUS * 1000) / 1000 };
      })(),
      population: state.population,
      housing: totalHousing(registry, state, game),
      workers: { total: workforce, assigned, idle: workforce - assigned },
      resources: [...registry.resources.values()].map((r) => ({
        id: r.id,
        amount: state.resources[r.id] ?? 0,
        capacity: r.storable === false ? null : storageCapacity(registry, state, game, r.id),
        ratePerTick: rates[r.id] ?? 0,
      })),
      buildings: Object.entries(state.buildings).map(([id, b]) => ({
        id,
        count: b.count,
        workers: b.workers ?? 0,
        pending: state.instances.filter((i) => i.buildingId === id && !i.counted).length,
      })),
      instances: state.instances.map((i) => ({
        id: i.id,
        buildingId: i.buildingId,
        x: i.x,
        y: i.y,
        rot: i.rot ?? 0,
        done: !!i.counted,
        ticksLeft: i.counted ? 0 : Math.max(0, i.doneAtTick - state.tick),
      })),
      unlocks: Object.fromEntries(
        [...registry.buildings.values()].map((def) => {
          const u = buildingUnlockStatus(registry, state, def);
          return [def.id, { unlocked: u.ok, missing: u.missing }];
        })
      ),
    };
  });

  // Statische Weltkarte (Terrain ändert sich nie — einmal laden reicht)
  fastify.get('/api/map', async () => ({
    width: ctx.state.map.width,
    height: ctx.state.map.height,
    tiles: ctx.state.map.tiles,
    version: ctx.state.mapVersion || 0,
    legend: TERRAIN,
  }));

  fastify.post('/api/build', async (req, reply) => {
    const { buildingId, x, y, rot } = req.body || {};
    const { registry } = ctx.registryHolder;
    try {
      const result = startBuild(registry, ctx.state, ctx.game, buildingId, x, y, rot);
      logEvent(ctx.pool, 'build_start', result).catch(() => {});
      return { ok: true, ...result };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err.message };
    }
  });

  // Platziertes Gebäude um 90° drehen (bei rechteckigem Footprint mit Kollisionsprüfung)
  fastify.post('/api/rotate', async (req, reply) => {
    const { instanceId } = req.body || {};
    const { registry } = ctx.registryHolder;
    const st = ctx.state;
    const inst = (st.instances || []).find((i) => i.id === Number(instanceId));
    if (!inst) { reply.code(404); return { ok: false, error: 'Gebäude nicht gefunden' }; }
    const def = registry.buildings.get(inst.buildingId);
    const newRot = ((inst.rot ?? 0) + 1) % 4;
    const fp = footprintOf(def || {}, inst.rot ?? 0);
    if (fp.w !== fp.h) {
      // Gedrehte Fläche muss passen — Instanz selbst aus der Belegung nehmen
      const without = { ...st, instances: st.instances.filter((i) => i.id !== inst.id) };
      const check = canPlace(st.map, without, registry, def, inst.x, inst.y, newRot);
      if (!check.ok) { reply.code(400); return { ok: false, error: 'Hier nicht drehbar: ' + check.reason }; }
    }
    inst.rot = newRot;
    await saveState(ctx.pool, st);
    return { ok: true, instanceId: inst.id, rot: newRot };
  });

  fastify.post('/api/demolish', async (req, reply) => {
    const { instanceId } = req.body || {};
    const { registry } = ctx.registryHolder;
    try {
      const result = demolish(registry, ctx.state, ctx.game, Number(instanceId));
      logEvent(ctx.pool, 'demolish', result).catch(() => {});
      return { ok: true, ...result };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err.message };
    }
  });

  // Straße setzen/entfernen. Body: { x, y, on } oder { tiles:[{x,y}], on } für Reihen.
  fastify.post('/api/road', async (req, reply) => {
    const { registry } = ctx.registryHolder;
    const body = req.body || {};
    const tiles = Array.isArray(body.tiles) ? body.tiles : [{ x: body.x, y: body.y }];
    const on = body.on !== false;
    try {
      const changed = [];
      for (const t of tiles) {
        const r = setRoad(ctx.state.map, ctx.state, registry, Number(t.x), Number(t.y), on);
        changed.push(r);
      }
      return { ok: true, changed, roadTiles: ctx.state.roads.size };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err.message };
    }
  });

  // KI-Berater: beantwortet Spielerfragen anhand des Spielstands (lokales LLM)
  fastify.post('/api/assist', async (req, reply) => {
    const question = (req.body?.question || '').toString().slice(0, 500).trim();
    if (!question) { reply.code(400); return { ok: false, error: 'Frage fehlt' }; }
    try {
      const answer = await askAdvisor(question, ctx);
      return { ok: true, answer };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: 'Berater nicht erreichbar: ' + err.message };
    }
  });

  // ── KI-Transparenz: Protokoll der Läufe (öffentlich, read-only) ──
  fastify.get('/api/ai-log', async () => {
    const { rows } = await ctx.pool.query(
      'SELECT id, started_at, status, accepted, rejected, error FROM ai_runs ORDER BY id DESC LIMIT 30'
    );
    return rows;
  });

  // Ein generiertes Pack deaktivieren (Datei → content/disabled, Hot-Reload,
  // verwaiste Instanzen aufräumen). Basis-Packs sind geschützt.
  fastify.post('/api/pack/disable', async (req, reply) => {
    const { packId } = req.body || {};
    if (!packId) { reply.code(400); return { ok: false, error: 'packId fehlt' }; }
    try {
      const { rows } = await ctx.pool.query('SELECT source, file_path FROM content_packs WHERE id = $1', [packId]);
      if (rows[0]?.source === 'human') { reply.code(400); return { ok: false, error: 'Basis-Pack kann nicht deaktiviert werden' }; }
      let filePath = rows[0]?.file_path;
      if (!filePath || !(await exists(filePath))) filePath = await findPackFile(ctx.config.dataDir, packId);
      if (!filePath) { reply.code(404); return { ok: false, error: 'Pack-Datei nicht gefunden' }; }

      const disabledDir = path.join(ctx.config.dataDir, 'content', 'disabled');
      await mkdir(disabledDir, { recursive: true });
      await rename(filePath, path.join(disabledDir, `${packId}.json`));
      await ctx.pool.query("UPDATE content_packs SET status = 'disabled' WHERE id = $1", [packId]).catch(() => {});
      await ctx.registryHolder.reload();

      // Verwaiste platzierte Instanzen + Gebäudezähler entfernen (deren Def fehlt jetzt)
      const reg = ctx.registryHolder.registry;
      const before = ctx.state.instances.length;
      ctx.state.instances = ctx.state.instances.filter((i) => reg.buildings.has(i.buildingId));
      for (const bid of Object.keys(ctx.state.buildings)) if (!reg.buildings.has(bid)) delete ctx.state.buildings[bid];
      await saveState(ctx.pool, ctx.state);
      logEvent(ctx.pool, 'pack_disabled', { packId }).catch(() => {});
      return { ok: true, packId, removedInstances: before - ctx.state.instances.length };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  // Deko (Bäume/Felsen) setzen/entfernen. Body: { tiles:[{x,y}], type:'tree'|'rock', on }
  fastify.post('/api/deco', async (req, reply) => {
    const { registry } = ctx.registryHolder;
    const body = req.body || {};
    const tiles = Array.isArray(body.tiles) ? body.tiles : [{ x: body.x, y: body.y }];
    const on = body.on !== false;
    const type = body.type === 'rock' ? 'rock' : 'tree';
    try {
      let changed = 0;
      for (const t of tiles) {
        try { setDeco(ctx.state.map, ctx.state, registry, Number(t.x), Number(t.y), type, on); changed++; }
        catch { /* einzelne ungültige Felder überspringen */ }
      }
      await saveState(ctx.pool, ctx.state);
      return { ok: true, changed };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err.message };
    }
  });

  fastify.post('/api/workers', async (req, reply) => {
    const { buildingId, delta } = req.body || {};
    const { registry } = ctx.registryHolder;
    try {
      return { ok: true, ...assignWorkers(registry, ctx.state, buildingId, Number(delta)) };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err.message };
    }
  });
}
