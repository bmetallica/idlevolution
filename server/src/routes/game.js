import {
  computeNetRates,
  storageCapacity,
  totalHousing,
  buildingUnlockStatus,
  startBuild,
  demolish,
  assignWorkers,
  currentEpoch,
  computeResourceFlows,
} from '../engine/tick.js';
import { describeConditions } from '../engine/rules.js';
import { epochsInOrder } from '../content/loader.js';
import { logEvent } from '../engine/state.js';
import { savePlayer, newPlayerOnIsland, saveWorld } from '../engine/players.js';
import { planTurn } from '../ai/strategist.js';
import { createShipment, findHarbor } from '../engine/ships.js';
import { declareWar, cancelDeclaration, resolveWars, armyOf, defenseOf, logWar } from '../engine/war.js';
import { createOffer, acceptOffer, cancelOffer } from '../engine/trade.js';
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
      mapVersion: ctx.world?.version ?? state.mapVersion ?? 0,
      roads: [...(state.roads || [])],
      placed: state.placed || {},
      cleared: [...(state.cleared || [])],
      logistics: (() => {
        const cov = roadCoverage(state, registry);
        return { roadTiles: state.roads?.size ?? 0, coverage: Math.round(cov * 100) / 100, bonus: Math.round(cov * ROAD_MAX_BONUS * 1000) / 1000 };
      })(),
      population: state.population,
      housing: totalHousing(registry, state, game),
      workers: { total: workforce, assigned, idle: Math.max(0, workforce - assigned) },
      resources: (() => {
        const flows = computeResourceFlows(registry, state, game);
        return [...registry.resources.values()].map((r) => ({
          id: r.id,
          amount: state.resources[r.id] ?? 0,
          capacity: r.storable === false ? null : storageCapacity(registry, state, game, r.id),
          ratePerTick: rates[r.id] ?? 0,
          flow: (flows[r.id] || []).sort((a, b) => b.amount - a.amount), // Zuflüsse zuerst
        }));
      })(),
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
    version: ctx.world?.version ?? ctx.state.mapVersion ?? 0,
    islands: ctx.world?.islands || null, // Mehr-Insel-Welt; null → Client nutzt Einzel-Insel-Fallback
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
    await savePlayer(ctx.pool, st);
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

  // ── Spieler/KI-Verwaltung (Mehr-Insel-Welt) ──
  const AI_NAMES = ['Nordmark', 'Sturmfels', 'Goldbucht', 'Wyrmspitze', 'Silbertal', 'Eisenhort'];

  // Plan eines KI-Spielers via LLM (Stufe 2) erstellen + persistieren. Fehler schlucken.
  async function planFor(p) {
    if (p.kind !== 'ai' || p.active === false) return false;
    try {
      const plan = await planTurn(ctx.registryHolder.registry, p, ctx.game, ctx.config.llm);
      p.plan = plan;
      await savePlayer(ctx.pool, p);
      logEvent(ctx.pool, 'ai_plan', { id: p.id, name: p.name, strategy: plan.strategy, queue: plan.buildQueue.length, chronicle: plan.chronicle }).catch(() => {});
      return true;
    } catch (err) {
      ctx.registryHolder.log?.warn?.(`KI-Plan für ${p.name} fehlgeschlagen: ${err.message}`);
      return false;
    }
  }

  // Liste aller Spieler + Inseln + Render-Instanzen aller Inseln (für die Weltansicht)
  fastify.get('/api/players', async () => {
    const { registry } = ctx.registryHolder;
    const nameOf = (id) => ctx.players.find((x) => x.id === id)?.name || '?';
    return {
      islands: ctx.world?.islands || [],
      maxAi: 4,
      tick: ctx.human?.tick ?? 0,
      freeSlots: (ctx.world?.islands || []).filter((isl) => !ctx.players.some((p) => p.islandId === isl.id && p.active !== false)).map((isl) => isl.id),
      warLog: (ctx.world?.warLog || []).slice(-6).reverse(),
      // Öffentliche Kriegserklärungen (Schlacht in der kommenden Nacht)
      warDeclarations: (ctx.world?.warDeclarations || []).map((d) => ({
        attacker: nameOf(d.attackerId), attackerId: d.attackerId,
        defender: nameOf(d.defenderId), defenderId: d.defenderId,
        soldiers: d.soldiers, retaliation: !!d.retaliation,
      })),
      players: ctx.players.map((p) => ({
        id: p.id, kind: p.kind, name: p.name, islandId: p.islandId, active: p.active !== false,
        population: Math.round(p.population), epoch: currentEpoch(registry, p)?.name?.de || null,
        buildings: (p.instances || []).filter((i) => i.counted).length,
        harbor: !!findHarbor(p),
        army: armyOf(p), defense: defenseOf(p, registry),
        strategy: p.plan?.strategy || null,
        personality: p.plan?.personality || null,
        chronicle: p.plan?.chronicle || null,
        instances: (p.instances || []).map((i) => ({ id: i.id, buildingId: i.buildingId, x: i.x, y: i.y, rot: i.rot ?? 0, done: !!i.counted, owner: p.id })),
      })),
      tickSeconds: ctx.config.tickSeconds,
      // Rohdaten → der Client interpoliert die Position flüssig zwischen den Ticks
      ships: (ctx.world?.ships || []).map((s) => ({
        id: s.id, type: s.type || 'trade', owner: s.owner, toOwner: s.toOwner, cargo: s.cargo,
        from: s.from, to: s.to, departTick: s.departTick, arriveTick: s.arriveTick,
      })),
    };
  });

  // Ware zu einer anderen Insel verschiffen (Stufe 4) — vom menschlichen Spieler
  fastify.post('/api/ship', async (req, reply) => {
    const { toIsland, resourceId, amount } = req.body || {};
    try {
      const ship = createShipment(ctx.world, ctx.players, ctx.human, Number(toIsland), resourceId, Number(amount), ctx.human?.tick ?? 0);
      await savePlayer(ctx.pool, ctx.human);
      await saveWorld(ctx.pool, ctx.world);
      logEvent(ctx.pool, 'ship_sent', { to: ship.toOwner, cargo: ship.cargo }).catch(() => {});
      return { ok: true, ship: { id: ship.id, arriveTick: ship.arriveTick } };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });

  // Kriegserklärung (Stufe 6 v2): tagsüber erklären, die Schlacht schlägt sich
  // im nächtlichen KI-Lauf (fair gegenüber der Tageszug-KI). Kein Erobern —
  // der Sieger plündert nur Beute, jede Insel bleibt bei ihrem Besitzer.
  fastify.post('/api/attack', async (req, reply) => {
    const { targetIsland, soldiers } = req.body || {};
    try {
      const target = ctx.players.find((p) => p.islandId === Number(targetIsland) && p.active !== false);
      if (!target) throw new Error('Zielinsel hat keinen aktiven Bewohner');
      if (target.kind === 'human') throw new Error('Du kannst dich nicht selbst angreifen');
      const decl = declareWar(ctx.world, ctx.human, target, soldiers);
      await savePlayer(ctx.pool, ctx.human);
      await saveWorld(ctx.pool, ctx.world);
      logEvent(ctx.pool, 'war_declared', { target: target.id, soldiers: decl.soldiers }).catch(() => {});
      return { ok: true, soldiers: decl.soldiers };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });

  // Kriegserklärung zurückziehen (vor der nächtlichen Schlacht)
  fastify.post('/api/attack/cancel', async (req, reply) => {
    try {
      const decl = cancelDeclaration(ctx.world, ctx.human, req.body?.targetPlayer);
      await savePlayer(ctx.pool, ctx.human);
      await saveWorld(ctx.pool, ctx.world);
      return { ok: true, soldiers: decl.soldiers };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });

  // Nächtliche Kriegs-Auflösung — token-geschützt, ruft der ai-worker im
  // Tagesrhythmus auf (zusammen mit Content-Generierung und KI-Planung).
  fastify.post('/api/war/resolve', async (req, reply) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const tok = req.headers['x-ai-token'] || req.body?.token || bearer;
    if (!ctx.config.aiImportToken || tok !== ctx.config.aiImportToken) { reply.code(401); return { ok: false, error: 'nicht autorisiert' }; }
    const reports = resolveWars(ctx.world, ctx.players, ctx.registryHolder.registry);
    for (const r of reports) logWar(ctx.world, r, ctx.human?.tick ?? 0);
    for (const p of ctx.players) await savePlayer(ctx.pool, p);
    await saveWorld(ctx.pool, ctx.world);
    for (const r of reports) fastify.log.info(`Krieg: ${r}`);
    return { ok: true, battles: reports.length, reports };
  });

  // ── Handelsmarkt (Stufe 5) ──
  fastify.get('/api/market', async () => ({
    hasHarbor: !!findHarbor(ctx.human),
    offers: (ctx.world?.offers || []).map((o) => ({
      ...o, ownerName: ctx.players.find((p) => p.id === o.owner)?.name || '?', mine: o.owner === ctx.human?.id,
    })),
  }));
  fastify.post('/api/market/offer', async (req, reply) => {
    const { giveRes, giveAmt, wantRes, wantAmt } = req.body || {};
    try {
      const o = createOffer(ctx.world, ctx.human, { resourceId: giveRes, amount: giveAmt }, { resourceId: wantRes, amount: wantAmt }, ctx.human?.tick ?? 0);
      await savePlayer(ctx.pool, ctx.human); await saveWorld(ctx.pool, ctx.world);
      return { ok: true, offerId: o.id };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });
  fastify.post('/api/market/accept', async (req, reply) => {
    try {
      const r = acceptOffer(ctx.world, ctx.players, ctx.human, req.body?.offerId, ctx.human?.tick ?? 0);
      await savePlayer(ctx.pool, ctx.human); await saveWorld(ctx.pool, ctx.world);
      logEvent(ctx.pool, 'trade_accept', { offer: r.offer.id, offerer: r.offerer, by: ctx.human.id }).catch(() => {});
      return { ok: true };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });
  fastify.post('/api/market/cancel', async (req, reply) => {
    try {
      cancelOffer(ctx.world, ctx.human, req.body?.offerId);
      await savePlayer(ctx.pool, ctx.human); await saveWorld(ctx.pool, ctx.world);
      return { ok: true };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });

  // KI-Spieler auf einer freien Insel zuschalten (max. 4)
  fastify.post('/api/players/enable', async (req, reply) => {
    const { registry } = ctx.registryHolder;
    if (ctx.players.filter((p) => p.kind === 'ai' && p.active !== false).length >= 4) { reply.code(400); return { ok: false, error: 'Maximal 4 KI-Spieler' }; }
    const free = (ctx.world?.islands || []).find((isl) => !ctx.players.some((p) => p.islandId === isl.id && p.active !== false));
    if (!free) { reply.code(400); return { ok: false, error: 'Keine freie Insel verfügbar' }; }
    const existing = ctx.players.find((p) => p.islandId === free.id); // reaktivieren?
    let p;
    if (existing) { existing.active = true; p = existing; }
    else {
      const id = Math.max(0, ...ctx.players.map((x) => x.id)) + 1;
      p = newPlayerOnIsland(ctx.game, registry, ctx.world, free.id, { id, kind: 'ai', name: AI_NAMES[(id - 1) % AI_NAMES.length] });
      ctx.players.push(p);
    }
    await savePlayer(ctx.pool, p);
    logEvent(ctx.pool, 'ai_player_enabled', { id: p.id, name: p.name, islandId: p.islandId }).catch(() => {});
    planFor(p).catch(() => {}); // initiale Strategie im Hintergrund holen
    return { ok: true, player: { id: p.id, name: p.name, islandId: p.islandId } };
  });

  // Alle KI-Spieler neu planen lassen (Stufe 2). Token-geschützt — der nächtliche
  // ai-worker ruft das nach der Content-Generierung auf. Läuft asynchron.
  fastify.post('/api/players/plan', async (req, reply) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const tok = req.headers['x-ai-token'] || req.body?.token || bearer;
    if (!ctx.config.aiImportToken || tok !== ctx.config.aiImportToken) { reply.code(401); return { ok: false, error: 'nicht autorisiert' }; }
    const ais = ctx.players.filter((p) => p.kind === 'ai' && p.active !== false);
    (async () => { for (const p of ais) await planFor(p); })().catch(() => {});
    return { ok: true, planning: ais.length };
  });

  // KI-Spieler abschalten (Insel bleibt bestehen, wird nur nicht mehr getickt)
  fastify.post('/api/players/disable', async (req, reply) => {
    const p = ctx.players.find((x) => x.id === Number(req.body?.playerId) && x.kind === 'ai');
    if (!p) { reply.code(404); return { ok: false, error: 'KI-Spieler nicht gefunden' }; }
    p.active = false;
    await savePlayer(ctx.pool, p);
    return { ok: true };
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
      await savePlayer(ctx.pool, ctx.state);
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
      await savePlayer(ctx.pool, ctx.state);
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
