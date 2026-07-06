// Exportiert den "Siedlungs-Status" als kompaktes JSON für die nächtliche KI:
// Was existiert, was fehlt, wo klemmt die Wirtschaft, was wurde zuletzt abgelehnt.

import { computeNetRates, storageCapacity, totalHousing, currentEpoch } from '../engine/tick.js';
import { describeConditions } from '../engine/rules.js';
import { epochsInOrder } from '../content/loader.js';

export async function buildExport(ctx) {
  const { registry } = ctx.registryHolder;
  const { state, game, pool } = ctx;
  const rates = computeNetRates(registry, state, game);
  const epoch = currentEpoch(registry, state);
  const epochs = epochsInOrder(registry);

  const producersOf = (rid) =>
    [...registry.buildings.values()].filter((b) => (b.production?.outputs || {})[rid] > 0).map((b) => b.id);
  const consumersOf = (rid) =>
    [...registry.buildings.values()].filter((b) => (b.production?.inputs || {})[rid] > 0).map((b) => b.id);

  const resources = [...registry.resources.values()].map((r) => ({
    id: r.id,
    name: r.name.de,
    category: r.category,
    epoch: r.epoch,
    baseValue: r.baseValue,
    amount: Math.round((state.resources[r.id] ?? 0) * 10) / 10,
    capacity: r.storable === false ? null : storageCapacity(registry, state, game, r.id),
    netPerTick: Math.round((rates[r.id] ?? 0) * 1000) / 1000,
    producers: producersOf(r.id),
    consumers: consumersOf(r.id),
  }));

  const buildings = [...registry.buildings.values()].map((b) => ({
    id: b.id,
    name: b.name.de,
    category: b.category,
    epoch: b.epoch,
    count: state.buildings[b.id]?.count ?? 0,
    workersAssigned: state.buildings[b.id]?.workers ?? 0,
    workersPerBuilding: b.workers ?? 0,
    cost: b.cost,
    production: b.production,
  }));

  // Lücken-Analyse: wo lohnt sich neue Inhalte zu generieren?
  const gaps = [];
  for (const e of epochs) {
    const bCount = buildings.filter((b) => b.epoch === e.id).length;
    const rCount = resources.filter((r) => r.epoch === e.id).length;
    if (bCount < 3) gaps.push(`Epoche '${e.id}' hat nur ${bCount} Gebäude`);
    if (rCount < 2) gaps.push(`Epoche '${e.id}' hat nur ${rCount} Ressourcen`);
  }
  for (const r of resources) {
    if (r.producers.length === 0) gaps.push(`Ressource '${r.id}' hat keinen Produzenten`);
    if (r.consumers.length === 0 && r.category !== 'food') gaps.push(`Ressource '${r.id}' hat keinen Verbraucher`);
    if (r.netPerTick < 0) gaps.push(`Ressource '${r.id}' ist im Mangel (${r.netPerTick}/Tick)`);
  }
  const lastEpoch = epochs[epochs.length - 1];
  if (lastEpoch && lastEpoch.advance == null) {
    gaps.push(
      `Epoche '${lastEpoch.id}' (order ${lastEpoch.order}) ist die letzte — eine Folge-Epoche (order ${lastEpoch.order + 1}) inkl. 'epochAdvance' für '${lastEpoch.id}' kann ergänzt werden`
    );
  }

  // Feedback-Schleife: Ablehnungen der letzten Läufe, damit die KI daraus lernt
  let recentRejections = [];
  try {
    const { rows } = await pool.query(
      "SELECT started_at, status, rejected, error FROM ai_runs WHERE status IN ('rejected','partial','error') ORDER BY id DESC LIMIT 5"
    );
    recentRejections = rows.map((r) => ({
      at: r.started_at,
      status: r.status,
      rejected: r.rejected,
      error: r.error,
    }));
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
    gaps,
    recentRejections,
  };
}
