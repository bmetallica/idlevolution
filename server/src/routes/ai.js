import { buildExport } from '../ai/exporter.js';
import { importPack } from '../ai/importer.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export default async function aiRoutes(fastify) {
  const ctx = fastify.gameCtx;

  // Alle /api/ai/*-Routen sind nur mit dem AI_IMPORT_TOKEN erreichbar
  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/ai/')) return;
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!ctx.config.aiImportToken || token !== ctx.config.aiImportToken) {
      reply.code(401).send({ ok: false, error: 'ungültiges Token' });
    }
  });

  // Siedlungs-Status für die KI (wird zusätzlich in data/exports archiviert)
  fastify.get('/api/ai/export', async () => {
    const exp = await buildExport(ctx);
    try {
      const dir = path.join(ctx.config.dataDir, 'exports');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, `${exp.generatedAt.replace(/[:.]/g, '-')}.json`),
        JSON.stringify(exp, null, 2)
      );
    } catch {
      // Archivierung ist optional
    }
    return exp;
  });

  // Import eines KI-generierten Packs (validiert, gebalanced, sandbox-getestet)
  fastify.post('/api/ai/import', async (req, reply) => {
    const { pack, run } = req.body || {};
    if (!pack) {
      reply.code(400);
      return { ok: false, error: "Body muss { pack, run? } enthalten" };
    }
    const result = await importPack(pack, run || null, ctx);
    if (result.status === 'rejected') reply.code(422);
    return result;
  });

  // Fehlgeschlagene Läufe protokollieren (z.B. LLM nicht erreichbar)
  fastify.post('/api/ai/runs', async (req) => {
    const { status = 'error', export: exp, error } = req.body || {};
    await ctx.pool.query('INSERT INTO ai_runs (status, export, error) VALUES ($1,$2,$3)', [
      status,
      JSON.stringify(exp ?? null),
      error ?? null,
    ]);
    return { ok: true };
  });

  // Letzte Läufe einsehen (Debugging/Transparenz)
  fastify.get('/api/ai/runs', async () => {
    const { rows } = await ctx.pool.query(
      'SELECT id, started_at, status, accepted, rejected, error FROM ai_runs ORDER BY id DESC LIMIT 20'
    );
    return rows;
  });
}
