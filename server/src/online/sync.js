// M2: Online-Nachbarn synchronisieren. Lädt index.json + Inseln TOKENLOS über
// raw.githubusercontent.com (öffentliches Repo; ~5 Min CDN-Cache ist für den
// Daily-Sync egal), validiert alles erneut (validate.js) und legt die Daten
// strikt isoliert unter data/online/<owner>/ ab — sie werden NIE in die
// eigene Content-Registry gemischt (Übernahme erst in M4, explizit).

import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { validateIsland, sanitizePacks, sanitizeOffers, sanitizeAccepts, checkOwner } from './validate.js';

const RAW = 'https://raw.githubusercontent.com';
const MAX_BYTES = 700 * 1024;
const MAX_ISLANDS = 100;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'idlevolution' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`Antwort zu groß (${text.length} B): ${url}`);
  return JSON.parse(text);
}

const onlineDir = (ctx) => path.join(ctx.config.dataDir, 'online');

/** Synchronisiert alle fremden Inseln aus dem Index. @returns Zusammenfassung */
export async function syncOnline(ctx, log = console) {
  const repo = ctx.config.online.repo;
  const me = ctx.online?.settings?.username || null;
  const base = `${RAW}/${repo}/main`;

  const index = await fetchJson(`${base}/index.json`);
  if (!Array.isArray(index?.islands)) throw new Error('index.json ungültig');

  // Moderations-Blockliste (M5): geblockte Ordner werden auch client-seitig ignoriert
  let blocked = new Set();
  try { const bl = await fetchJson(`${base}/blocklist.json`); blocked = new Set(Array.isArray(bl?.blocked) ? bl.blocked : []); } catch { /* keine Blockliste */ }

  const dir = onlineDir(ctx);
  await mkdir(dir, { recursive: true });
  const seen = new Set();
  const results = [];

  for (const entry of index.islands.slice(0, MAX_ISLANDS)) {
    const owner = entry?.owner;
    if (!checkOwner(owner) || owner === me || blocked.has(owner)) continue;
    try {
      const rawIsland = await fetchJson(`${base}/islands/${owner}/island.json`);
      const island = validateIsland(rawIsland, owner);
      let packs = { version: 1, owner, buildings: [], resources: [], epochs: [] };
      if (entry.hasPacks) {
        try { packs = sanitizePacks(await fetchJson(`${base}/islands/${owner}/packs.json`), owner); }
        catch (err) { log.warn?.(`[online-sync] packs von ${owner} verworfen: ${err.message}`); }
      }
      // Handel (M3): Angebote/Accepts sind optional — 404 ⇒ leer
      let offers = { version: 1, owner, offers: [], closed: [] };
      let accepts = { version: 1, owner, accepts: [] };
      try { offers = sanitizeOffers(await fetchJson(`${base}/islands/${owner}/offers.json`), owner); } catch { /* keine */ }
      try { accepts = sanitizeAccepts(await fetchJson(`${base}/islands/${owner}/accepts.json`), owner); } catch { /* keine */ }
      const d = path.join(dir, owner);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, 'island.json'), JSON.stringify(island));
      await writeFile(path.join(d, 'packs.json'), JSON.stringify(packs));
      await writeFile(path.join(d, 'offers.json'), JSON.stringify(offers));
      await writeFile(path.join(d, 'accepts.json'), JSON.stringify(accepts));
      seen.add(owner);
      results.push({ owner, name: island.name, population: island.population, ok: true });
    } catch (err) {
      results.push({ owner, ok: false, error: err.message });
      log.warn?.(`[online-sync] Insel von ${owner} übersprungen: ${err.message}`);
    }
  }

  // Verwaiste lokale Kopien entfernen (Insel aus dem Index verschwunden/geblockt)
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && !seen.has(e.name)) await rm(path.join(dir, e.name), { recursive: true, force: true });
  }

  return { islands: results, syncedAt: new Date().toISOString() };
}

/** Liste der lokal synchronisierten Nachbarn (Metadaten aus island.json). */
export async function listNeighbors(ctx) {
  const dir = onlineDir(ctx);
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !checkOwner(e.name)) continue;
    try {
      const d = JSON.parse(await readFile(path.join(dir, e.name, 'island.json'), 'utf8'));
      out.push({ owner: d.owner, name: d.name, epoch: d.epoch, population: d.population, exportedAt: d.exportedAt, chronicle: d.chronicle || null });
    } catch { /* defekte Kopie → beim nächsten Sync ersetzt */ }
  }
  return out.sort((a, b) => b.population - a.population);
}

/** Vollständige Insel + Packs eines Nachbarn (für die Besuchen-Ansicht). */
export async function loadNeighbor(ctx, owner) {
  if (!checkOwner(owner)) throw new Error('Ungültiger Name');
  const d = path.join(onlineDir(ctx), owner);
  const island = JSON.parse(await readFile(path.join(d, 'island.json'), 'utf8'));
  const packs = JSON.parse(await readFile(path.join(d, 'packs.json'), 'utf8').catch(() => '{"buildings":[],"resources":[],"epochs":[]}'));
  return { island, packs };
}

/** Handelsdaten aller synchronisierten Nachbarn (für die Abwicklung, M3). */
export async function loadNeighborTrade(ctx) {
  const dir = onlineDir(ctx);
  const out = {};
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !checkOwner(e.name)) continue;
    const read = async (f) => JSON.parse(await readFile(path.join(dir, e.name, f), 'utf8').catch(() => 'null'));
    out[e.name] = { offers: await read('offers.json'), accepts: await read('accepts.json') };
  }
  return out;
}
