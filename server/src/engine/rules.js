// Generischer Bedingungs-Evaluator. Dieselbe Struktur wird für
// Gebäude-Freischaltungen (building.requires) und Epochen-Aufstieg (epoch.advance) genutzt —
// die KI kann beliebige Kombinationen dieser Schlüssel generieren.

export function epochOrder(registry, epochId) {
  return registry.epochs.get(epochId)?.order ?? -1;
}

/**
 * @param {object|null} cond - { epoch?, buildings?, resources?, population? }
 * @param {object} registry
 * @param {object} state
 * @returns {{ok: boolean, missing: Array<{type: string, id?: string, need: number|string, have: number|string}>}}
 */
export function evaluateConditions(cond, registry, state) {
  const missing = [];
  if (!cond) return { ok: true, missing };

  if (cond.epoch) {
    const need = epochOrder(registry, cond.epoch);
    const have = epochOrder(registry, state.epochId);
    if (have < need) missing.push({ type: 'epoch', need: cond.epoch, have: state.epochId });
  }
  for (const [id, need] of Object.entries(cond.buildings || {})) {
    const have = state.buildings[id]?.count ?? 0;
    if (have < need) missing.push({ type: 'building', id, need, have });
  }
  for (const [id, need] of Object.entries(cond.resources || {})) {
    const have = state.resources[id] ?? 0;
    if (have < need) missing.push({ type: 'resource', id, need, have });
  }
  if (cond.population !== undefined && state.population < cond.population) {
    missing.push({ type: 'population', need: cond.population, have: Math.floor(state.population) });
  }
  return { ok: missing.length === 0, missing };
}

/** Alle Bedingungen mit have/need — auch die bereits erfüllten (für Fortschrittsanzeigen). */
export function describeConditions(cond, registry, state) {
  const items = [];
  if (!cond) return items;
  if (cond.epoch) {
    const have = epochOrder(registry, state.epochId);
    const need = epochOrder(registry, cond.epoch);
    items.push({ type: 'epoch', id: cond.epoch, need: cond.epoch, have: state.epochId, ok: have >= need });
  }
  for (const [id, need] of Object.entries(cond.buildings || {})) {
    const have = state.buildings[id]?.count ?? 0;
    items.push({ type: 'building', id, need, have, ok: have >= need });
  }
  for (const [id, need] of Object.entries(cond.resources || {})) {
    const have = state.resources[id] ?? 0;
    items.push({ type: 'resource', id, need, have: Math.floor(have), ok: have >= need });
  }
  if (cond.population !== undefined) {
    const have = Math.floor(state.population);
    items.push({ type: 'population', need: cond.population, have, ok: have >= cond.population });
  }
  return items;
}
