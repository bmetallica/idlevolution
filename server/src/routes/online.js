// Online-Modus-Routen (M0): GitHub-Verbindung per Device Flow + Disclaimer.
// Der Poll-Loop läuft serverseitig; der Client fragt nur /status ab.

import { startDeviceFlow, pollToken, fetchGithubUser, loadOnline, saveOnline } from '../online/auth.js';

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
      pending: p?.userCode ? { userCode: p.userCode, verificationUri: p.verificationUri } : null,
      error: p?.error || null,
      repo: ctx.config.online.repo,
    };
  });

  // Disclaimer-Zustimmung („Insel online freigeben — auf eigene Gefahr")
  fastify.post('/api/online/disclaimer', async () => {
    ctx.online.settings = {
      ...ctx.online.settings,
      disclaimerVersion: DISCLAIMER_VERSION,
      disclaimerAcceptedAt: new Date().toISOString(),
    };
    await saveOnline(ctx.pool, ctx.online.settings);
    return { ok: true };
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
