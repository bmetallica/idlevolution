// Exportiert den "Siedlungs-Status" als kompaktes JSON für die nächtliche KI:
// Was existiert, was fehlt, wo klemmt die Wirtschaft, was wurde zuletzt abgelehnt.

import { computeNetRates, storageCapacity, totalHousing, currentEpoch } from '../engine/tick.js';
import { describeConditions } from '../engine/rules.js';
import { epochsInOrder, llmSafeName } from '../content/loader.js';
import { config } from '../config.js';
import { estimateTokens } from './generator.js';

/** Entfernt leere/neutrale Felder — jedes gesparte Feld ist Kontext für echte Inhalte. */
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (v === 0 && (k === 'count' || k === 'amount' || k === 'netPerTick')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Baut den Siedlungs-Status und hält ihn unter einem Token-Budget: Reicht die
 * volle Detailtiefe nicht, wird das Detailfenster schrittweise auf die jüngsten
 * Epochen verengt. Ohne diesen Deckel wächst der Prompt mit dem Spielstand,
 * bis er das Kontextfenster des lokalen Modells sprengt.
 */
export async function buildExport(ctx) {
  const budget = ctx.config?.aiExportTokenBudget ?? config.aiExportTokenBudget;
  let last;
  for (const window of [2, 1, 0]) {
    last = await buildExportAt(ctx, window);
    if (estimateTokens(JSON.stringify(last)) <= budget) return last;
  }
  return last; // engstes Fenster — mehr lässt sich ohne Informationsverlust nicht kürzen
}

async function buildExportAt(ctx, detailWindow) {
  const { registry } = ctx.registryHolder;
  const { state, game, pool } = ctx;
  const rates = computeNetRates(registry, state, game);
  const epoch = currentEpoch(registry, state);
  const epochs = epochsInOrder(registry);

  const producersOf = (rid) =>
    [...registry.buildings.values()].filter((b) => (b.production?.outputs || {})[rid] > 0).map((b) => b.id);
  const consumersOf = (rid) =>
    [...registry.buildings.values()].filter((b) => (b.production?.inputs || {})[rid] > 0).map((b) => b.id);

  // Detailtiefe nach Relevanz: Der Spielstand wächst unbegrenzt, das Kontext-
  // fenster nicht. Inhalte der aktuellen und der direkt benachbarten Epochen
  // bekommen volle Details (daran wird angebaut), ältere nur so viel, dass die
  // KI ihre IDs kennt (Duplikat-Sperre) und sie als Input/requires referenzieren
  // kann. Das war der Grund, warum die Nächte ab 24.07. kippten.
  const curOrder = epoch?.order ?? 0;
  const orderOf = (eid) => epochs.find((e) => e.id === eid)?.order ?? 0;
  const detailed = (eid) => orderOf(eid) >= curOrder - detailWindow;

  const resources = [...registry.resources.values()].map((r) => {
    const base = { id: r.id, category: r.category, epoch: r.epoch, baseValue: r.baseValue };
    if (!detailed(r.epoch)) return base; // Altbestand: nur referenzierbar halten
    return prune({
      ...base,
      name: llmSafeName(r),
      amount: Math.round((state.resources[r.id] ?? 0) * 10) / 10,
      capacity: r.storable === false ? null : storageCapacity(registry, state, game, r.id),
      netPerTick: Math.round((rates[r.id] ?? 0) * 1000) / 1000,
      producers: producersOf(r.id),
      consumers: consumersOf(r.id),
    });
  });

  const buildings = [...registry.buildings.values()].map((b) => {
    const base = { id: b.id, epoch: b.epoch };
    if (!detailed(b.epoch)) return base;
    return prune({
      ...base,
      name: llmSafeName(b),
      category: b.category,
      count: state.buildings[b.id]?.count ?? 0,
      workersPerBuilding: b.workers ?? 0,
      cost: b.cost,
      production: b.production,
    });
  });

  // Lücken-Analyse: wo lohnt sich neue Inhalte zu generieren?
  // WICHTIG: immer auf der Registry rechnen, nicht auf den (nach Relevanz
  // gekürzten) Export-Arrays — sonst verschwinden Lücken alter Epochen genau
  // dann aus dem Blick, wenn der Export eng wird.
  const shortages = [];
  const gaps = [];
  for (const e of epochs) {
    const bCount = buildings.filter((b) => b.epoch === e.id).length;
    const rCount = resources.filter((r) => r.epoch === e.id).length;
    if (bCount < 3) gaps.push(`Epoche '${e.id}' hat nur ${bCount} Gebäude`);
    if (rCount < 2) gaps.push(`Epoche '${e.id}' hat nur ${rCount} Ressourcen`);
  }
  for (const r of registry.resources.values()) {
    const net = Math.round((rates[r.id] ?? 0) * 1000) / 1000;
    if (producersOf(r.id).length === 0) gaps.push(`Ressource '${r.id}' hat keinen Produzenten`);
    if (consumersOf(r.id).length === 0 && r.category !== 'food') gaps.push(`Ressource '${r.id}' hat keinen Verbraucher`);
    // Mangel ist die dringendste Klasse — separat sammeln, damit sie den Deckel überlebt
    if (net < 0) shortages.push(`Ressource '${r.id}' ist im Mangel (${net}/Tick)`);
  }
  const lastEpoch = epochs[epochs.length - 1];
  const epochWarning = lastEpoch
    ? `ACHTUNG Epochen: Eine neue Epoche MUSS order ${lastEpoch.order + 1} und eine komplett NEUE id haben` +
      (lastEpoch.advance == null ? ` sowie einen 'epochAdvance'-Eintrag für '${lastEpoch.id}'.` : `.`) +
      ` Wenn dir keine sinnvolle neue Epoche einfällt, lasse "epochs" WEG und ergänze nur Gebäude/Ressourcen.`
    : null;

  // Deckel mit Priorität: Warnung → Mängel (dringend) → strukturelle Lücken.
  // Die Liste der existierenden Epochen-IDs stand hier doppelt (steht bereits
  // in allEpochs und in der VERBOTEN-Liste des Prompts) — entfernt.
  const rankedGaps = [
    ...(epochWarning ? [epochWarning] : []),
    ...shortages.slice(0, 8),
    ...gaps.slice(0, 12),
  ];

  // Feedback-Schleife: Ablehnungen der letzten Läufe, damit die KI daraus lernt.
  // Kompakt (nur Gründe als Strings) — volle JSON-Blobs verschwenden Tokens.
  let recentRejections = [];
  let recentClamps = [];
  try {
    const { rows } = await pool.query(
      "SELECT started_at, status, rejected, error FROM ai_runs WHERE status IN ('rejected','partial','error') ORDER BY id DESC LIMIT 5"
    );
    recentRejections = rows.map((r) => ({
      at: r.started_at,
      status: r.status,
      reasons: (Array.isArray(r.rejected) ? r.rejected : []).map((x) => x?.reason || String(x)).slice(0, 8),
      ...(r.error ? { error: String(r.error).slice(0, 200) } : {}),
    }));
    // Clamp-Notizen akzeptierter Läufe: sagen dem Modell, WO seine Zahlen-
    // intuition daneben lag (z.B. "baseValue 5000 → 1000 gekappt").
    const acc = await pool.query(
      "SELECT accepted FROM ai_runs WHERE status IN ('accepted','partial') AND accepted IS NOT NULL ORDER BY id DESC LIMIT 3"
    );
    recentClamps = acc.rows.flatMap((r) => r.accepted?.notes || []).slice(0, 10);
  } catch {
    // DB nicht erreichbar → Export funktioniert trotzdem
  }

  // Karten-Übersicht: Terrain-Verteilung, damit die KI sinnvolle placement-Regeln wählt
  const terrainCounts = {};
  for (const c of state.map?.tiles || '') {
    const name = { W: 'water', S: 'sand', G: 'grass', F: 'forest', R: 'rock' }[c];
    terrainCounts[name] = (terrainCounts[name] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    tick: state.tick,
    map: state.map && {
      width: state.map.width,
      height: state.map.height,
      terrainCounts,
      placedBuildings: (state.instances || []).length,
    },
    epoch: epoch && {
      id: epoch.id,
      order: epoch.order,
      name: epoch.name.de,
      tier: epoch.tier?.name?.de || null,
      needs: epoch.needs || null,
      advanceProgress: describeConditions(epoch.advance, registry, state),
    },
    satisfaction: Math.round((state.satisfaction ?? 1) * 100) / 100,
    allEpochs: epochs.map((e) => ({ id: e.id, order: e.order, name: e.name.de, hasAdvance: e.advance != null })),
    population: Math.floor(state.population),
    housing: totalHousing(registry, state, game),
    idleWorkers:
      Math.floor(state.population) -
      Object.values(state.buildings).reduce((s, b) => s + (b.workers ?? 0), 0),
    resources,
    buildings,
    // Sagt dem Modell ausdrücklich, dass ältere Einträge nur verkürzt vorliegen —
    // sonst hält es fehlende Felder für „gibt es nicht" und baut Dubletten.
    detailHinweis:
      detailWindow < 99
        ? `Einträge älterer Epochen sind auf id/epoch verkürzt (Kontext-Budget). Sie EXISTIEREN und dürfen referenziert, aber nie neu angelegt werden.`
        : undefined,
    gaps: rankedGaps,
    recentRejections,
    recentClamps,
  };
}
