// Online-Modus-Routen (M0): GitHub-Verbindung per Device Flow + Disclaimer.
// Der Poll-Loop läuft serverseitig; der Client fragt nur /status ab.

import { startDeviceFlow, pollToken, fetchGithubUser, loadOnline, saveOnline } from '../online/auth.js';
import { buildIslandExport, buildPacksExport } from '../online/exporter.js';
import { publishFiles, unpublishFiles } from '../online/github.js';
import { syncOnline, listNeighbors, loadNeighbor, loadNeighborTrade } from '../online/sync.js';
import { adoptPack } from '../online/adopt.js';
import { emptyTrade, createOnlineOffer, cancelOnlineOffer, acceptOnlineOffer, settleTrades } from '../online/trade.js';
import { savePlayer } from '../engine/players.js';

export const DISCLAIMER_VERSION = 1;

export default async function onlineRoutes(fastify) {
  const ctx = fastify.gameCtx;
  ctx.online ??= { settings: await loadOnline(ctx.pool), pending: null };

  const clientId = ctx.config.online.clientId;

  // Serverseitiger Poll-Loop bis Token/Expiry (Intervall von GitHub vorgegeben)
  function startPolling(pending) {
    const tick = async () => {
      if (ctx.online.pending !== pending) return; // abgelöst/abgebrochen
      if (Date.now() > pending.expiresAt) {
        ctx.online.pending = { error: 'Code abgelaufen — bitte erneut verbinden.' };
        return;
      }
      try {
        const r = await pollToken(clientId, pending.deviceCode);
        if (r.token) {
          const user = await fetchGithubUser(r.token);
          ctx.online.settings = {
            ...ctx.online.settings,
            token: r.token, username: user.login, avatarUrl: user.avatarUrl,
            connectedAt: new Date().toISOString(),
          };
          await saveOnline(ctx.pool, ctx.online.settings);
          ctx.online.pending = null;
          fastify.log.info(`Online-Modus: verbunden als ${user.login}`);
          return;
        }
        if (r.slowDown) pending.interval += 5;
      } catch (err) {
        ctx.online.pending = { error: err.message };
        return;
      }
      setTimeout(tick, pending.interval * 1000);
    };
    setTimeout(tick, pending.interval * 1000);
  }

  // Verbindung starten → User-Code für github.com/login/device
  fastify.post('/api/online/connect', async (req, reply) => {
    if (!clientId) { reply.code(500); return { ok: false, error: 'ONLINE_CLIENT_ID fehlt' }; }
    try {
      const d = await startDeviceFlow(clientId);
      const pending = {
        deviceCode: d.device_code, userCode: d.user_code,
        verificationUri: d.verification_uri || 'https://github.com/login/device',
        interval: Math.max(5, d.interval || 5),
        expiresAt: Date.now() + (d.expires_in || 900) * 1000,
      };
      ctx.online.pending = pending;
      startPolling(pending);
      return { ok: true, userCode: pending.userCode, verificationUri: pending.verificationUri, expiresIn: d.expires_in };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: err.message };
    }
  });

  // Status (Client pollt hierauf, der Token verlässt den Server NIE)
  fastify.get('/api/online/status', async () => {
    const s = ctx.online.settings;
    const p = ctx.online.pending;
    return {
      connected: !!s.token,
      username: s.username || null,
      avatarUrl: s.avatarUrl || null,
      disclaimerAccepted: (s.disclaimerVersion || 0) >= DISCLAIMER_VERSION,
      publishEnabled: s.publishEnabled !== false,
      pending: p?.userCode ? { userCode: p.userCode, verificationUri: p.verificationUri } : null,
      error: p?.error || null,
      repo: ctx.config.online.repo,
      lastPublish: s.lastPublish || null, // {at, prUrl, instances}
    };
  });

  // ── Veröffentlichen (M1+M3): Insel, Packs UND Handelsdateien als ein PR ──
  const canPublish = () => {
    const s = ctx.online.settings;
    if (!s.token) throw new Error('Nicht mit GitHub verbunden');
    if ((s.disclaimerVersion || 0) < DISCLAIMER_VERSION) throw new Error('Freigabe (Disclaimer) fehlt');
    if (s.publishEnabled === false) throw new Error('Online-Freigabe ist beendet („Offline gegangen")');
    return s;
  };
  let publishing = false;
  async function doPublish() {
    const s = canPublish();
    if (publishing) throw new Error('Veröffentlichung läuft bereits');
    publishing = true;
    try {
      const island = buildIslandExport(ctx, s.username);
      const packs = buildPacksExport(ctx, s.username);
      const trade = s.trade || emptyTrade();
      const files = [
        { path: `islands/${s.username}/island.json`, content: JSON.stringify(island, null, 1) + '\n' },
        { path: `islands/${s.username}/packs.json`, content: JSON.stringify(packs, null, 1) + '\n' },
        { path: `islands/${s.username}/offers.json`, content: JSON.stringify({ version: 1, owner: s.username, offers: trade.offers || [], closed: trade.closed || [] }, null, 1) + '\n' },
        { path: `islands/${s.username}/accepts.json`, content: JSON.stringify({ version: 1, owner: s.username, accepts: trade.accepts || [] }, null, 1) + '\n' },
      ];
      for (const f of files) {
        if (Buffer.byteLength(f.content) > 512 * 1024) throw new Error(`${f.path} überschreitet 512 KB`);
      }
      const { prUrl } = await publishFiles(s.token, s.username, ctx.config.online.repo, files);
      ctx.online.settings = { ...ctx.online.settings, lastPublish: { at: new Date().toISOString(), prUrl, instances: island.instances.length } };
      await saveOnline(ctx.pool, ctx.online.settings);
      fastify.log.info(`Online-Modus: veröffentlicht (${island.instances.length} Gebäude, ${trade.offers?.length || 0} Angebote) → ${prUrl}`);
      return { prUrl, instances: island.instances.length };
    } finally {
      publishing = false;
    }
  }
  fastify.post('/api/online/publish', async (req, reply) => {
    try { return { ok: true, ...(await doPublish()) }; }
    catch (err) { reply.code(err.message.includes('bereits') ? 409 : 400); return { ok: false, error: err.message }; }
  });

  // Vorschau „Was wird veröffentlicht?" (M5) — vor der ersten Freigabe
  fastify.get('/api/online/preview', async (req, reply) => {
    const s = ctx.online.settings;
    if (!s.username) { reply.code(400); return { ok: false, error: 'Nicht verbunden' }; }
    try {
      const island = buildIslandExport(ctx, s.username);
      const packs = buildPacksExport(ctx, s.username);
      return {
        ok: true, username: s.username,
        mapSize: `${island.map.width}×${island.map.height}`,
        instances: island.instances.length, roads: island.roads.length,
        packBuildings: packs.buildings.length, packResources: packs.resources.length,
      };
    } catch (err) { reply.code(500); return { ok: false, error: err.message }; }
  });

  // „Offline gehen" (M5): eigene Dateien per PR entfernen, Nightly-Publish stoppen
  fastify.post('/api/online/unpublish', async (req, reply) => {
    const s = ctx.online.settings;
    if (!s.token) { reply.code(400); return { ok: false, error: 'Nicht mit GitHub verbunden' }; }
    try {
      const paths = ['island.json', 'packs.json', 'offers.json', 'accepts.json'].map((f) => `islands/${s.username}/${f}`);
      const r = await unpublishFiles(s.token, s.username, ctx.config.online.repo, paths);
      ctx.online.settings = { ...ctx.online.settings, publishEnabled: false, lastPublish: null };
      await saveOnline(ctx.pool, ctx.online.settings);
      fastify.log.info(`Online-Modus: offline gegangen (${r.deleted} Datei(en) entfernt)`);
      return { ok: true, ...r };
    } catch (err) { reply.code(502); return { ok: false, error: err.message }; }
  });

  // Disclaimer-Zustimmung („Insel online freigeben — auf eigene Gefahr")
  fastify.post('/api/online/disclaimer', async () => {
    ctx.online.settings = {
      ...ctx.online.settings,
      disclaimerVersion: DISCLAIMER_VERSION,
      disclaimerAcceptedAt: new Date().toISOString(),
      publishEnabled: true, // „Offline gehen" setzt das wieder zurück
    };
    await saveOnline(ctx.pool, ctx.online.settings);
    return { ok: true };
  });

  // Nachbarn synchronisieren (M2) — tokenlos, geht auch OHNE GitHub-Verbindung.
  // Danach Handels-Abwicklung (M3): Accepts/Tombstones der Nachbarn auflösen.
  let syncing = false;
  fastify.post('/api/online/sync', async (req, reply) => {
    if (syncing) { reply.code(409); return { ok: false, error: 'Sync läuft bereits' }; }
    syncing = true;
    try {
      const r = await syncOnline(ctx, fastify.log);
      let tradeEvents = [];
      const s = ctx.online.settings;
      if (s.username && s.trade) {
        tradeEvents = settleTrades(s.trade, ctx.human, s.username, await loadNeighborTrade(ctx));
        if (tradeEvents.length) {
          await savePlayer(ctx.pool, ctx.human);
          for (const e of tradeEvents) fastify.log.info(`Online-Handel: ${e}`);
          // Abschluss-Tombstones sofort publizieren, damit die Gegenseite auflösen kann
          doPublish().catch((err) => fastify.log.warn(`Online-Handel: Publish nach Abwicklung fehlgeschlagen: ${err.message}`));
        }
      }
      ctx.online.settings = { ...ctx.online.settings, lastSyncAt: r.syncedAt };
      await saveOnline(ctx.pool, ctx.online.settings);
      return { ok: true, ...r, tradeEvents };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: err.message };
    } finally {
      syncing = false;
    }
  });

  // ── Online-Handel (M3) ──
  const tradeState = () => (ctx.online.settings.trade ??= emptyTrade());
  const persistTrade = async () => {
    await savePlayer(ctx.pool, ctx.human);
    await saveOnline(ctx.pool, ctx.online.settings);
    doPublish().catch((err) => fastify.log.warn(`Online-Handel: Publish fehlgeschlagen: ${err.message}`));
  };

  // Übersicht: fremde offene Angebote + eigener Handelszustand
  fastify.get('/api/online/trade', async () => {
    const s = ctx.online.settings;
    const registry = ctx.registryHolder.registry;
    const neighborTrade = await loadNeighborTrade(ctx);
    const marketOffers = [];
    for (const [owner, d] of Object.entries(neighborTrade)) {
      for (const o of d.offers?.offers || []) {
        marketOffers.push({
          owner, ...o,
          giveKnown: registry.resources.has(o.give.resourceId),
          wantKnown: registry.resources.has(o.want.resourceId),
          accepted: (s.trade?.accepts || []).some((a) => a.offerId === o.id),
        });
      }
    }
    return {
      connected: !!s.token, username: s.username || null,
      offers: s.trade?.offers || [], closed: (s.trade?.closed || []).slice(-5),
      accepts: s.trade?.accepts || [], marketOffers,
    };
  });

  fastify.post('/api/online/trade/offer', async (req, reply) => {
    try {
      const s = canPublish();
      const { giveRes, giveAmt, wantRes, wantAmt } = req.body || {};
      const spec = (rid) => ctx.registryHolder.registry.resources.get(rid)?.category === 'special';
      if (spec(giveRes) || spec(wantRes)) throw new Error('Militärgüter sind nicht handelbar');
      const offer = createOnlineOffer(tradeState(), ctx.human, s.username, { resourceId: giveRes, amount: giveAmt }, { resourceId: wantRes, amount: wantAmt });
      await persistTrade();
      return { ok: true, offer };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });

  fastify.post('/api/online/trade/cancel', async (req, reply) => {
    try {
      canPublish();
      const offer = cancelOnlineOffer(tradeState(), ctx.human, req.body?.offerId);
      await persistTrade();
      return { ok: true, offer };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });

  fastify.post('/api/online/trade/accept', async (req, reply) => {
    try {
      const s = canPublish();
      const { offerOwner, offerId } = req.body || {};
      const neighborTrade = await loadNeighborTrade(ctx);
      const offer = (neighborTrade[offerOwner]?.offers?.offers || []).find((o) => o.id === offerId);
      if (!offer) throw new Error('Angebot nicht (mehr) verfügbar — erst 🔄 aktualisieren');
      if (!ctx.registryHolder.registry.resources.has(offer.give.resourceId)) {
        throw new Error('Unbekannte Ware — übernimm zuerst die Inhalte dieses Nachbarn (✨ beim Besuchen)');
      }
      const accept = acceptOnlineOffer(tradeState(), ctx.human, s.username, offerOwner, offer);
      await persistTrade();
      return { ok: true, accept };
    } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
  });

  // Liste der synchronisierten Online-Nachbarn (lokale Kopien)
  fastify.get('/api/online/neighbors', async () => ({
    neighbors: await listNeighbors(ctx),
    lastSyncAt: ctx.online.settings.lastSyncAt || null,
  }));

  // Insel + Packs eines Nachbarn für die Besuchen-Ansicht
  fastify.get('/api/online/island/:owner', async (req, reply) => {
    try { return { ok: true, ...(await loadNeighbor(ctx, req.params.owner)) }; }
    catch (err) { reply.code(404); return { ok: false, error: err.message }; }
  });

  // Inhalte eines Nachbarn übernehmen (M4) — wird ein normales, deaktivierbares Pack
  fastify.post('/api/online/adopt', async (req, reply) => {
    try {
      const r = await adoptPack(ctx, req.body?.owner);
      fastify.log.info(`Online-Modus: Inhalte von ${req.body?.owner} übernommen (${r.buildings} Gebäude, ${r.resources} Ressourcen)`);
      return { ok: true, ...r };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err.message };
    }
  });

  // Verbindung trennen (Token löschen; Disclaimer-Zustimmung bleibt dokumentiert)
  fastify.post('/api/online/disconnect', async () => {
    const { token, username, avatarUrl, connectedAt, ...rest } = ctx.online.settings;
    ctx.online.settings = rest;
    ctx.online.pending = null;
    await saveOnline(ctx.pool, ctx.online.settings);
    return { ok: true };
  });
}
