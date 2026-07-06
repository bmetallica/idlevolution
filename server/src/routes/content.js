import { registryToJSON } from '../content/loader.js';

export default async function contentRoutes(fastify) {
  const ctx = fastify.gameCtx;

  // Gemergte Content-Definitionen — das Frontend rendert ausschließlich, was hier ankommt.
  fastify.get('/api/content', async () => registryToJSON(ctx.registryHolder.registry));
}
