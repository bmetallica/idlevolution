// Sicherer Import-Pfad für KI-generierte Packs:
// Struktur → Referenzen → Balancing (Clamping/Ablehnung) → Sandbox-Simulation → Datei + Hot-Reload.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { validateStructure, validateReferences } from '../content/validator.js';
import { balancePack } from '../content/balancer.js';
import { mergePack, cloneRegistry, epochsInOrder } from '../content/loader.js';
import { runTicks } from '../engine/tick.js';
import { logEvent } from '../engine/state.js';

// Schlüsselwörter → angrenzendes Pflicht-Terrain (Anno-artige Platzierung).
const ADJACENCY_HINTS = [
  { re: /(mine|erz|ore|metal|copper|kupfer|iron|eisen|coal|kohle|stein|stone|quarry|steinbruch|gem|gold|silber|silver|marmor|marble)/i, terrain: 'rock', extraTerrain: [] },
  { re: /(fisch|fish|hafen|harbor|harbour|dock|pier|steg|boot|boat|ship|schiff|salz|salt|muschel|pearl|perle|seetang|algae)/i, terrain: 'water', extraTerrain: ['sand'] },
  { re: /(holz|wood|lumber|timber|forst|forest|wald|jäger|hunter|hunt|köhler|charcoal)/i, terrain: 'forest', extraTerrain: [] },
  { re: /(lehm|clay|ton|brick|ziegel|töpfer|potter)/i, terrain: 'water', extraTerrain: ['sand'] },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Ergänzt fehlende placement-Regeln (terrain/adjacent/size) und meta.art. */
function inferPlacementAndArt(b) {
  const hay = [b.id, b.name?.de, b.name?.en, b.description?.de].filter(Boolean).join(' ').toLowerCase();
  const p = { ...(b.placement || {}) };

  // Terrain: Standard je Kategorie
  if (!Array.isArray(p.terrain) || p.terrain.length === 0) {
    p.terrain = b.category === 'production' ? ['grass'] : ['grass', 'sand'];
  }
  p.terrain = p.terrain.filter((t) => ['grass', 'sand', 'forest', 'rock'].includes(t));
  if (p.terrain.length === 0) p.terrain = ['grass'];

  // Angrenzendes Terrain aus Schlüsselwörtern ableiten (nur wenn LLM keins gab)
  if (!p.adjacent || Object.keys(p.adjacent).length === 0) {
    for (const h of ADJACENCY_HINTS) {
      if (h.re.test(hay)) {
        p.adjacent = { [h.terrain]: 1 };
        for (const t of h.extraTerrain) if (!p.terrain.includes(t)) p.terrain.push(t);
        break;
      }
    }
  }
  // Ungültige adjacent-Keys entfernen
  if (p.adjacent) {
    for (const k of Object.keys(p.adjacent)) {
      if (!['grass', 'sand', 'forest', 'rock', 'water'].includes(k)) delete p.adjacent[k];
      else p.adjacent[k] = clamp(Math.round(p.adjacent[k]) || 1, 1, 8);
    }
    if (Object.keys(p.adjacent).length === 0) delete p.adjacent;
  }

  // Größe: größere Bauten für Zivil/Lager, sonst 1×1; clampen
  if (!p.size) {
    p.size = b.category === 'civic' ? { w: 2, h: 2 } : b.category === 'storage' ? { w: 2, h: 1 } : { w: 1, h: 1 };
  }
  p.size = { w: clamp(Math.round(p.size.w) || 1, 1, 4), h: clamp(Math.round(p.size.h) || 1, 1, 4) };

  b.placement = p;
  b.meta = { ...(b.meta || {}), art: { shape: b.category, ...(b.meta?.art || {}) } };
  return b;
}

/** Ergänzt fehlende Epochen-Felder mit sicheren Defaults (tier/modifiers).
 *  needs bleibt bewusst dem LLM überlassen — ein erfundenes Bedürfnis ohne
 *  Produzenten würde die Ära dauerhaft unzufrieden machen. */
function inferEpochDefaults(e) {
  const order = e.order ?? 0;
  if (!e.tier?.name?.de) {
    e.tier = { name: { de: e.name?.de || e.id, ...(e.name?.en ? { en: e.name.en } : {}) } };
  }
  const defMult = Math.min(100, 1 + Math.min(2, order * 0.15));
  if (!e.modifiers || typeof e.modifiers !== 'object') {
    e.modifiers = { productionMultiplier: defMult, populationGrowth: 0.012 };
  } else {
    if (e.modifiers.productionMultiplier == null) e.modifiers.productionMultiplier = defMult;
    if (e.modifiers.populationGrowth == null) e.modifiers.populationGrowth = 0.012;
  }
  return e;
}

/**
 * Stellt sicher, dass jede neue Epoche ein Güter-Bedürfnis hat. Wenn das LLM keins
 * gesetzt hat, wird ein SICHERES ergänzt: ein Komfortgut (processed/luxury), das
 * nachweislich einen Produzenten besitzt und spätestens in dieser Epoche verfügbar
 * ist — so bleibt das Bedürfnis immer erfüllbar (keine Sackgasse). Nur wenn es kein
 * geeignetes Gut gibt, bleibt needs leer.
 */
function ensureEpochNeeds(pack, registry) {
  if (!Array.isArray(pack.epochs) || pack.epochs.length === 0) return;
  const resById = new Map();
  for (const r of registry.resources.values()) resById.set(r.id, r);
  for (const r of pack.resources || []) resById.set(r.id, r);
  const epochOrder = new Map();
  for (const e of registry.epochs.values()) epochOrder.set(e.id, e.order);
  for (const e of pack.epochs) epochOrder.set(e.id, e.order);

  const hasProducer = (rid) => {
    for (const b of registry.buildings.values()) if ((b.production?.outputs || {})[rid] > 0) return true;
    for (const b of pack.buildings || []) if ((b.production?.outputs || {})[rid] > 0) return true;
    return false;
  };
  const comfort = [...resById.values()]
    .filter((r) => ['processed', 'luxury'].includes(r.category) && hasProducer(r.id))
    .sort((a, b) => (b.baseValue || 0) - (a.baseValue || 0));

  for (const e of pack.epochs) {
    if (e.needs && Object.keys(e.needs).length) continue; // LLM hat needs gesetzt
    const eo = e.order ?? 0;
    const good = comfort.find((r) => (epochOrder.get(r.epoch) ?? 0) <= eo) || comfort[0];
    if (good) e.needs = { [good.id]: 0.01 };
  }
}

function normalizePack(raw) {
  const pack = structuredClone(raw || {});
  pack.schemaVersion = 1;
  if (Array.isArray(pack.buildings)) pack.buildings = pack.buildings.map(inferPlacementAndArt);
  if (Array.isArray(pack.epochs)) pack.epochs = pack.epochs.map(inferEpochDefaults);
  pack.pack = {
    id: pack.pack?.id || `ai-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'ai',
    createdAt: pack.pack?.createdAt || new Date().toISOString(),
    ...(pack.pack?.model ? { model: pack.pack.model } : {}),
  };
  // Nur bekannte Top-Level-Felder durchlassen (LLMs erfinden gern zusätzliche)
  const allowed = ['schemaVersion', 'pack', 'chronicle', 'resources', 'buildings', 'epochs', 'events', 'epochAdvance'];
  for (const key of Object.keys(pack)) {
    if (!allowed.includes(key)) delete pack[key];
  }
  for (const key of ['resources', 'buildings', 'epochs', 'events']) {
    if (Array.isArray(pack[key]) && pack[key].length === 0) delete pack[key];
  }
  if (typeof pack.chronicle === 'string') pack.chronicle = { de: pack.chronicle };
  return pack;
}

const hasProducer = (registry, rid) => {
  for (const b of registry.buildings.values()) if ((b.production?.outputs || {})[rid] > 0) return true;
  return false;
};

/** Findet Fortschritts-Blocker (Soft-Locks) in einer Registry:
 *  unerreichbare Epochen, Bedürfnisse/Inputs ohne Produzent. */
function reachabilityIssues(registry) {
  const issues = new Set();
  const epochs = epochsInOrder(registry);
  const maxOrder = epochs.length ? epochs[epochs.length - 1].order : 0;
  for (const e of epochs) {
    if (e.order < maxOrder && !e.advance) issues.add(`Epoche '${e.id}' ist nicht die letzte, hat aber keine Aufstiegsbedingung → unerreichbare Folge-Epochen`);
    for (const rid of Object.keys(e.needs || {})) if (!hasProducer(registry, rid)) issues.add(`Bedürfnis '${rid}' (Epoche '${e.id}') hat keinen Produzenten`);
  }
  for (const b of registry.buildings.values())
    for (const rid of Object.keys(b.production?.inputs || {}))
      if (!hasProducer(registry, rid)) issues.add(`Gebäude '${b.id}' braucht '${rid}', das niemand produziert`);
  return issues;
}

/** Prüft, ob das Pack NEUE Soft-Locks einführt (vorbestehende zählen nicht). */
function softLockCheck(pack, ctx) {
  const before = reachabilityIssues(ctx.registryHolder.registry);
  const merged = cloneRegistry(ctx.registryHolder.registry);
  mergePack(merged, pack, '<softlock>');
  const after = reachabilityIssues(merged);
  const added = [...after].filter((i) => !before.has(i));
  return { ok: added.length === 0, errors: added };
}

/** Simuliert das Pack gegen eine Kopie des Spielstands — fängt, was Formeln übersehen. */
function sandboxCheck(pack, ctx) {
  const { balance } = ctx;
  const registry = cloneRegistry(ctx.registryHolder.registry);
  mergePack(registry, pack, '<sandbox>');
  const state = structuredClone(ctx.state);
  // Optimistisches Szenario: alles Neue steht einmal und ist voll besetzt
  for (const b of pack.buildings || []) {
    state.buildings[b.id] = { count: 1, workers: b.workers ?? 0 };
    state.population += b.workers ?? 0; // Sandbox darf großzügig sein
  }
  try {
    runTicks(registry, state, ctx.game, balance.sandbox?.ticks ?? 1000);
  } catch (err) {
    return { ok: false, errors: [`Sandbox-Simulation abgestürzt: ${err.message}`] };
  }
  const errors = [];
  const maxAmount = balance.sandbox?.maxResourceAmount ?? 1e9;
  for (const [rid, amount] of Object.entries(state.resources)) {
    if (!Number.isFinite(amount)) errors.push(`Sandbox: Ressource '${rid}' wurde ${amount}`);
    else if (amount > maxAmount) errors.push(`Sandbox: Ressource '${rid}' explodiert (${amount.toExponential(2)})`);
  }
  if (!Number.isFinite(state.population)) errors.push('Sandbox: Bevölkerung wurde nicht-numerisch');
  return { ok: errors.length === 0, errors };
}

async function writeRejected(dataDir, pack, reasons) {
  const dir = path.join(dataDir, 'rejected');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${pack?.pack?.id || 'unknown'}.json`);
  await writeFile(file, JSON.stringify({ reasons, pack }, null, 2));
  return file;
}

async function recordRun(pool, { status, run, accepted, rejected, error }) {
  try {
    await pool.query(
      'INSERT INTO ai_runs (status, export, raw_response, accepted, rejected, error) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        status,
        JSON.stringify(run?.export ?? null),
        JSON.stringify(run?.rawResponse ?? null),
        JSON.stringify(accepted ?? null),
        JSON.stringify(rejected ?? null),
        error ?? null,
      ]
    );
  } catch {
    // Protokollierung darf den Import nicht verhindern
  }
}

/**
 * @param {object} rawPack - von der KI geliefertes Pack (ungeprüft)
 * @param {object|null} run - optionale Lauf-Metadaten { export, rawResponse, model }
 * @param {object} ctx - App-Kontext
 */
export async function importPack(rawPack, run, ctx) {
  const registry = ctx.registryHolder.registry;
  const pack = normalizePack(rawPack);
  ensureEpochNeeds(pack, registry); // fehlende Epochen-Bedürfnisse sicher ergänzen
  const reject = async (reasons, status = 'rejected') => {
    const file = await writeRejected(ctx.config.dataDir, pack, reasons);
    await recordRun(ctx.pool, { status, run, rejected: reasons });
    return { status, packId: pack.pack.id, accepted: null, rejected: reasons, rejectedFile: file };
  };

  const s = validateStructure(pack);
  if (!s.ok) return reject(s.errors.map((e) => ({ type: 'structure', reason: e })));

  const refs = validateReferences(pack, registry);
  if (!refs.ok) return reject(refs.errors.map((e) => ({ type: 'reference', reason: e })));

  const { pack: balanced, rejected, notes } = balancePack(pack, registry, ctx.balance);
  const itemCount =
    (balanced.resources?.length ?? 0) +
    (balanced.buildings?.length ?? 0) +
    (balanced.epochs?.length ?? 0) +
    (balanced.events?.length ?? 0) +
    Object.keys(balanced.epochAdvance || {}).length;
  if (itemCount === 0) return reject([...rejected, { type: 'balance', reason: 'kein Item hat das Balancing überstanden' }]);

  const soft = softLockCheck(balanced, ctx);
  if (!soft.ok) return reject([...rejected, ...soft.errors.map((e) => ({ type: 'reachability', reason: e }))]);

  const sandbox = sandboxCheck(balanced, ctx);
  if (!sandbox.ok) return reject([...rejected, ...sandbox.errors.map((e) => ({ type: 'sandbox', reason: e }))]);

  // Persistieren + Hot-Reload
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ctx.config.dataDir, 'content', 'generated', day);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${balanced.pack.id}.json`);
  await writeFile(file, JSON.stringify(balanced, null, 2));
  await ctx.registryHolder.reload();

  const accepted = {
    resources: (balanced.resources || []).map((r) => r.id),
    buildings: (balanced.buildings || []).map((b) => b.id),
    epochs: (balanced.epochs || []).map((e) => e.id),
    events: (balanced.events || []).map((e) => e.id),
    epochAdvance: Object.keys(balanced.epochAdvance || {}),
    notes,
  };
  const status = rejected.length > 0 ? 'partial' : 'accepted';
  await recordRun(ctx.pool, { status, run, accepted, rejected });
  try {
    await ctx.pool.query(
      'INSERT INTO content_packs (id, source, status, file_path, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
      [balanced.pack.id, balanced.pack.source, 'active', file, JSON.stringify(balanced)]
    );
    await logEvent(ctx.pool, 'ai_import', { packId: balanced.pack.id, accepted, rejected });
  } catch {
    // Audit-Fehler blockieren den Import nicht
  }

  return { status, packId: balanced.pack.id, file, accepted, rejected, notes, chronicle: balanced.chronicle || null };
}
