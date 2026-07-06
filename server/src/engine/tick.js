// Kern der Simulation. Alle Funktionen arbeiten rein auf (registry, state, game) —
// dadurch nutzt die Sandbox-Simulation des KI-Importers exakt dieselbe Logik wie das Live-Spiel.

import { evaluateConditions, epochOrder } from './rules.js';
import { epochsInOrder } from '../content/loader.js';
import { canPlace, roadCoverage } from './map.js';

// Maximaler Produktionsbonus, wenn alle Gebäude an Straßen angebunden sind.
export const ROAD_MAX_BONUS = 0.15;

export function currentEpoch(registry, state) {
  return registry.epochs.get(state.epochId) || null;
}

export function totalHousing(registry, state, game) {
  let cap = game.baseHousing;
  for (const [id, b] of Object.entries(state.buildings)) {
    const def = registry.buildings.get(id);
    if (def?.housing?.capacity) cap += def.housing.capacity * b.count;
  }
  return cap;
}

/** Lagerkapazität je Ressource: Basis + Beiträge aller Lagergebäude ('*' wirkt auf alle). */
export function storageCapacity(registry, state, game, resourceId) {
  let cap = game.baseStorage;
  for (const [id, b] of Object.entries(state.buildings)) {
    const def = registry.buildings.get(id);
    if (!def?.storage) continue;
    const bonus = (def.storage[resourceId] ?? 0) + (def.storage['*'] ?? 0);
    cap += bonus * b.count;
  }
  return cap;
}

function productionMultiplier(registry, state) {
  const epochMult = currentEpoch(registry, state)?.modifiers?.productionMultiplier ?? 1;
  // Logistik: Straßenanbindung steigert den Durchsatz (bis +ROAD_MAX_BONUS)
  const logistics = 1 + roadCoverage(state, registry) * ROAD_MAX_BONUS;
  return epochMult * logistics;
}

/**
 * Produktions-Deltas pro Tick je Gebäudetyp, begrenzt durch Arbeiter-Effizienz und
 * verfügbare Inputs. Gibt {resourceId: delta} zurück (ohne Lager-Cap, ohne Nahrungsverbrauch).
 */
export function computeProductionDeltas(registry, state) {
  const mult = productionMultiplier(registry, state);
  const deltas = {};
  for (const [id, b] of Object.entries(state.buildings)) {
    const def = registry.buildings.get(id);
    if (!def?.production || b.count <= 0) continue;
    const needWorkers = (def.workers ?? 0) * b.count;
    const eff = needWorkers > 0 ? Math.min(1, (b.workers ?? 0) / needWorkers) : 1;
    if (eff <= 0) continue;

    // Input-Limitierung: läuft nur so weit, wie Vorräte reichen
    let inputFactor = 1;
    for (const [rid, rate] of Object.entries(def.production.inputs || {})) {
      const need = rate * b.count * eff;
      if (need <= 0) continue;
      const avail = Math.max(0, (state.resources[rid] ?? 0) + (deltas[rid] ?? 0));
      inputFactor = Math.min(inputFactor, avail / need);
    }
    inputFactor = Math.max(0, Math.min(1, inputFactor));
    if (inputFactor <= 0) continue;

    for (const [rid, rate] of Object.entries(def.production.inputs || {})) {
      deltas[rid] = (deltas[rid] ?? 0) - rate * b.count * eff * inputFactor;
    }
    for (const [rid, rate] of Object.entries(def.production.outputs || {})) {
      deltas[rid] = (deltas[rid] ?? 0) + rate * b.count * eff * inputFactor * mult;
    }
  }
  return deltas;
}

/** Netto-Raten pro Tick inkl. Nahrungs- und Güter-Bedarf — für UI und KI-Export. */
export function computeNetRates(registry, state, game) {
  const rates = computeProductionDeltas(registry, state);
  const foodNeed = state.population * game.foodPerPopPerTick;
  distributeFoodConsumption(registry, state, foodNeed, rates, /* dryRun */ true);
  applyNeeds(registry, state, currentEpoch(registry, state), rates, /* apply */ false);
  return rates;
}

/**
 * Verbraucht die Güter-Bedürfnisse der aktuellen Bevölkerung (epoch.needs) und
 * liefert die Zufriedenheit 0..1 (Anteil gedeckter Bedürfnisse). Ohne Bedürfnisse = 1.
 * data-driven: Die KI definiert je Epoche neue Bedürfnisse und erzwingt so neue Ketten.
 */
export function applyNeeds(registry, state, epoch, target, apply) {
  const needs = epoch?.needs || null;
  const ids = needs ? Object.keys(needs) : [];
  if (ids.length === 0) return 1;
  let sat = 0;
  for (const rid of ids) {
    const need = state.population * (needs[rid] ?? 0);
    if (need <= 0) { sat += 1; continue; }
    const avail = Math.max(0, state.resources[rid] ?? 0);
    const take = Math.min(avail, need);
    sat += take / need;
    if (apply) state.resources[rid] = avail - take;
    else if (target) target[rid] = (target[rid] ?? 0) - take;
  }
  return sat / ids.length;
}

/** Verteilt den Nahrungsbedarf auf alle Ressourcen der Kategorie 'food'. */
function distributeFoodConsumption(registry, state, need, target, dryRun = false) {
  let remaining = need;
  for (const res of registry.resources.values()) {
    if (res.category !== 'food' || remaining <= 0) continue;
    const avail = Math.max(0, state.resources[res.id] ?? 0);
    const take = Math.min(avail, remaining);
    if (dryRun) {
      target[res.id] = (target[res.id] ?? 0) - take;
      remaining -= take;
    } else {
      state.resources[res.id] = avail - take;
      remaining -= take;
    }
  }
  return remaining; // > 0 → Hunger
}

/**
 * Führt genau einen Tick aus (mutiert state) und liefert aufgetretene Ereignisse.
 * @returns {Array<{type: string, payload: object}>}
 */
export function runTick(registry, state, game) {
  const events = [];
  state.tick += 1;

  // 1) Fertiggestellte Bau-Instanzen übernehmen (inkrementell — Zähler in
  //    state.buildings bleiben Quelle für die Produktion, auch in der Sandbox)
  for (const inst of state.instances || []) {
    if (!inst.counted && inst.doneAtTick <= state.tick) {
      inst.counted = true;
      const b = (state.buildings[inst.buildingId] ??= { count: 0, workers: 0 });
      b.count += 1;
      events.push({
        type: 'build_complete',
        payload: { buildingId: inst.buildingId, count: b.count, x: inst.x, y: inst.y },
      });
    }
  }

  // 2) Produktion anwenden, an Lagerkapazität kappen
  const deltas = computeProductionDeltas(registry, state);
  for (const [rid, delta] of Object.entries(deltas)) {
    const res = registry.resources.get(rid);
    const cap = res?.storable === false ? Infinity : storageCapacity(registry, state, game, rid);
    const next = (state.resources[rid] ?? 0) + delta;
    state.resources[rid] = Math.max(0, Math.min(cap, next));
  }

  // 3) Nahrung + Güter-Bedürfnisse verbrauchen, Bevölkerung entwickeln
  const epochNow = currentEpoch(registry, state);
  const foodNeed = state.population * game.foodPerPopPerTick;
  const unmet = distributeFoodConsumption(registry, state, foodNeed, null, false);
  const satisfaction = applyNeeds(registry, state, epochNow, null, /* apply */ true);
  state.satisfaction = satisfaction;
  const housing = totalHousing(registry, state, game);
  const growth = epochNow?.modifiers?.populationGrowth ?? 0.01;
  if (unmet > 0.000001) {
    // Hunger → Bevölkerung schrumpft
    state.population = Math.max(1, state.population * (1 - game.popDeclineRate));
  } else if (satisfaction < 0.4) {
    // Güter fehlen → Unzufriedenheit, leichte Abwanderung (skaliert mit Fehlbetrag)
    state.population = Math.max(1, state.population * (1 - game.popDeclineRate * (0.4 - satisfaction)));
  } else if (state.population < housing) {
    // Wachstum, durch Zufriedenheit gebremst (0.4→40 %, 1.0→100 % der Wachstumsrate)
    const g = growth * (0.4 + 0.6 * satisfaction);
    state.population = Math.min(housing, state.population + Math.max(0.01, state.population * g));
  }

  // 4) Arbeiterzuweisungen an gesunkene Bevölkerung anpassen
  const workforce = Math.floor(state.population);
  let assigned = Object.values(state.buildings).reduce((s, b) => s + (b.workers ?? 0), 0);
  if (assigned > workforce) {
    for (const b of Object.values(state.buildings)) {
      if (assigned <= workforce) break;
      const take = Math.min(b.workers ?? 0, assigned - workforce);
      b.workers -= take;
      assigned -= take;
    }
  }

  // 5) Epochen-Aufstieg prüfen (advance-Bedingungen der AKTUELLEN Epoche)
  const epoch = currentEpoch(registry, state);
  if (epoch?.advance) {
    const check = evaluateConditions(epoch.advance, registry, state);
    if (check.ok) {
      const next = epochsInOrder(registry).find((e) => e.order === epoch.order + 1);
      if (next) {
        state.epochId = next.id;
        events.push({ type: 'epoch_advance', payload: { from: epoch.id, to: next.id } });
      }
    }
  }

  return events;
}

/** Mehrere Ticks am Stück (Offline-Progression, Sandbox). Liefert gesammelte Events. */
export function runTicks(registry, state, game, n) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...runTick(registry, state, game));
  return events;
}

/** Freischaltstatus eines Gebäudes inkl. Begründung (fürs UI). */
export function buildingUnlockStatus(registry, state, def) {
  const conditions = { ...(def.requires || {}) };
  // Die Epoche des Gebäudes ist implizit immer Voraussetzung
  if (!conditions.epoch) conditions.epoch = def.epoch;
  return evaluateConditions(conditions, registry, state);
}

/**
 * Prüft und startet einen Bauauftrag an Position (x,y) auf der Karte.
 * Wirft Error mit Klartext-Grund bei Ablehnung.
 */
export function startBuild(registry, state, game, buildingId, x, y, rot = 0) {
  const def = registry.buildings.get(buildingId);
  if (!def) throw new Error(`Unbekanntes Gebäude: ${buildingId}`);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Position (x,y) fehlt');
  rot = ((Number(rot) || 0) % 4 + 4) % 4;

  const unlock = buildingUnlockStatus(registry, state, def);
  if (!unlock.ok) throw new Error(`Noch nicht freigeschaltet: ${buildingId}`);

  const existing = (state.instances || []).filter((i) => i.buildingId === buildingId).length;
  if (def.maxCount != null && existing >= def.maxCount) {
    throw new Error(`Maximale Anzahl erreicht: ${buildingId}`);
  }

  const place = canPlace(state.map, state, registry, def, x, y, rot);
  if (!place.ok) throw new Error(`Platzierung ungültig: ${place.reason}`);

  for (const [rid, amount] of Object.entries(def.cost || {})) {
    if ((state.resources[rid] ?? 0) < amount) {
      throw new Error(`Nicht genug ${rid} (benötigt ${amount})`);
    }
  }
  for (const [rid, amount] of Object.entries(def.cost || {})) {
    state.resources[rid] -= amount;
  }

  const buildTime = def.buildTimeTicks ?? 0;
  const inst = {
    id: state.nextInstanceId++,
    buildingId,
    x,
    y,
    rot,
    doneAtTick: state.tick + buildTime,
    counted: buildTime <= 0,
  };
  state.instances.push(inst);
  if (inst.counted) {
    const b = (state.buildings[buildingId] ??= { count: 0, workers: 0 });
    b.count += 1;
  }
  return { instanceId: inst.id, buildingId, x, y, rot, doneAtTick: inst.doneAtTick };
}

/** Reißt eine Instanz ab; die Hälfte der Baukosten wird erstattet. */
export function demolish(registry, state, game, instanceId) {
  const idx = (state.instances || []).findIndex((i) => i.id === instanceId);
  if (idx === -1) throw new Error(`Unbekannte Gebäude-Instanz: ${instanceId}`);
  const inst = state.instances[idx];
  const def = registry.buildings.get(inst.buildingId);
  state.instances.splice(idx, 1);

  const b = state.buildings[inst.buildingId];
  if (inst.counted && b) {
    b.count = Math.max(0, b.count - 1);
    const maxWorkers = (def?.workers ?? 0) * b.count;
    b.workers = Math.min(b.workers ?? 0, maxWorkers);
  }
  for (const [rid, amount] of Object.entries(def?.cost || {})) {
    const cap = registry.resources.get(rid)?.storable === false
      ? Infinity
      : storageCapacity(registry, state, game, rid);
    state.resources[rid] = Math.min(cap, (state.resources[rid] ?? 0) + amount * 0.5);
  }
  return { instanceId, buildingId: inst.buildingId, refunded: true };
}

/** Arbeiter einem Gebäudetyp zuweisen/entziehen. */
export function assignWorkers(registry, state, buildingId, delta) {
  const def = registry.buildings.get(buildingId);
  if (!def) throw new Error(`Unbekanntes Gebäude: ${buildingId}`);
  const b = state.buildings[buildingId];
  if (!b || b.count <= 0) throw new Error(`Gebäude nicht gebaut: ${buildingId}`);

  const workforce = Math.floor(state.population);
  const assignedTotal = Object.values(state.buildings).reduce((s, x) => s + (x.workers ?? 0), 0);
  const idle = workforce - assignedTotal;
  const maxForBuilding = (def.workers ?? 0) * b.count;

  const target = Math.max(0, Math.min(maxForBuilding, (b.workers ?? 0) + delta));
  const actualDelta = target - (b.workers ?? 0);
  if (actualDelta > idle) throw new Error(`Nicht genug freie Arbeiter (frei: ${idle})`);
  b.workers = target;
  return { buildingId, workers: b.workers };
}
