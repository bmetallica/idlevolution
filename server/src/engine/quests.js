// E1: Tagesziele (Quests) — die lokale KI gibt erstmals GAMEPLAY-Richtung,
// nicht nur Content. Sicherheitsmodell: Das LLM liefert nur Ziel-Vorschläge
// (Typ, Ziel, Menge, Titel); Erreichbarkeit, Mengen-Kappung und BELOHNUNGEN
// werden ausschließlich MECHANISCH bestimmt — Validierung rein aus dem State,
// nichts, was ein Modell kaputt-balancen könnte.

import { storageCapacity, totalHousing, buildingUnlockStatus, currentEpoch } from './tick.js';

export const MAX_QUESTS = 3;
const REWARD_VALUE_PER_ORDER = 60; // Warenwert der Belohnung je Epochen-Order+1

/** Mechanischer Fortschritt eines Ziels. */
export function questProgress(state, q) {
  let have = 0;
  if (q.type === 'build') have = Math.max(0, (state.buildings[q.buildingId]?.count ?? 0) - (q.baseline ?? 0));
  else if (q.type === 'population') have = Math.floor(state.population);
  else if (q.type === 'stock') have = Math.floor(state.resources[q.resourceId] ?? 0);
  const need = q.amount;
  return { have: Math.min(have, need), need, done: have >= need };
}

/** Belohnung mechanisch bestimmen: knappstes Bedarfs-Gut der Epoche, sonst Holz. */
function pickReward(registry, state) {
  const epoch = currentEpoch(registry, state);
  const order = epoch?.order ?? 0;
  const value = REWARD_VALUE_PER_ORDER * (order + 1);
  let rid = 'wood';
  let worst = Infinity;
  for (const needRid of Object.keys(epoch?.needs || {})) {
    const stock = state.resources[needRid] ?? 0;
    if (stock < worst && registry.resources.has(needRid)) { worst = stock; rid = needRid; }
  }
  const base = registry.resources.get(rid)?.baseValue || 1;
  return { resourceId: rid, amount: Math.max(1, Math.round(value / base)) };
}

/**
 * Validiert & normalisiert LLM-Quest-Vorschläge gegen den State.
 * Unbrauchbare Vorschläge fallen raus; Mengen werden erreichbar gekappt.
 */
export function validateQuests(raw, registry, state, game) {
  const items = [];
  const seen = new Set();
  for (const q of Array.isArray(raw) ? raw : []) {
    if (items.length >= MAX_QUESTS) break;
    const type = q?.type;
    const title = (q?.title?.de || q?.title || '').toString().slice(0, 120);
    let item = null;
    if (type === 'build' && registry.buildings.has(q.buildingId)) {
      if (!buildingUnlockStatus(registry, state, registry.buildings.get(q.buildingId)).ok) continue;
      const amount = Math.max(1, Math.min(5, Math.round(q.amount) || 1));
      item = { type, buildingId: q.buildingId, amount, baseline: state.buildings[q.buildingId]?.count ?? 0 };
    } else if (type === 'population') {
      const housing = totalHousing(registry, state, game);
      const cur = Math.floor(state.population);
      const amount = Math.min(Math.round(q.amount) || cur + 10, housing); // nie über Wohnraum
      if (amount <= cur) continue; // schon erreicht → kein Ziel
      item = { type, amount };
    } else if (type === 'stock' && registry.resources.has(q.resourceId)) {
      const cap = storageCapacity(registry, state, game, q.resourceId);
      const cur = Math.floor(state.resources[q.resourceId] ?? 0);
      const amount = Math.max(cur + 1, Math.min(Math.round(q.amount) || cur + 10, Math.floor(cap)));
      if (amount <= cur) continue;
      item = { type, resourceId: q.resourceId, amount };
    }
    if (!item) continue;
    const key = `${item.type}:${item.buildingId || item.resourceId || 'pop'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    item.id = `q${items.length + 1}`;
    item.title = title || defaultTitle(registry, item);
    item.reward = pickReward(registry, state);
    item.claimed = false;
    items.push(item);
  }
  return items;
}

function defaultTitle(registry, q) {
  if (q.type === 'build') return `Baue ${q.amount}× ${registry.buildings.get(q.buildingId)?.name?.de || q.buildingId}`;
  if (q.type === 'population') return `Erreiche ${q.amount} Einwohner`;
  return `Lagere ${q.amount}× ${registry.resources.get(q.resourceId)?.name?.de || q.resourceId}`;
}

/** Mechanische Fallback-Ziele, falls das LLM nicht liefert (Nacht gerettet). */
export function fallbackQuests(registry, state, game) {
  const raw = [];
  // 1) Das knappste Bedarfs-Gut bevorraten — ohne Epochen-needs: Nahrung/Holz.
  //    Fast volle Lager (> 80 % Kapazität) überspringen — „lagere 1 mehr" wäre trivial.
  const epoch = currentEpoch(registry, state);
  const needIds = Object.keys(epoch?.needs || {});
  const roomLeft = (rid) => {
    const cap = storageCapacity(registry, state, game, rid);
    return cap > 0 && (state.resources[rid] ?? 0) < cap * 0.8;
  };
  const stockRid = [...needIds.sort((a, b) => (state.resources[a] ?? 0) - (state.resources[b] ?? 0)), 'food', 'wood']
    .find((rid) => registry.resources.has(rid) && roomLeft(rid));
  if (stockRid) {
    const cur = Math.floor(state.resources[stockRid] ?? 0);
    raw.push({ type: 'stock', resourceId: stockRid, amount: Math.ceil((cur + 20) * 1.25) });
  }
  // 2) Ein freigeschaltetes Produktionsgebäude erweitern (das häufigste — sicher sinnvoll)
  const built = Object.entries(state.buildings || {})
    .filter(([id, b]) => b.count > 0 && registry.buildings.get(id)?.production)
    .sort((a, b) => b[1].count - a[1].count);
  if (built.length) raw.push({ type: 'build', buildingId: built[0][0], amount: 2 });
  // 3) Bevölkerung Richtung Wohnraum wachsen — ist der Wohnraum voll, stattdessen
  //    ein Wohngebäude bauen (genau das blockiert das Wachstum!)
  const housing = totalHousing(registry, state, game);
  const target = Math.min(housing, Math.ceil(state.population * 1.1));
  if (target > Math.floor(state.population)) {
    raw.push({ type: 'population', amount: target });
  } else {
    const home = [...registry.buildings.values()].find(
      (d) => d.housing?.capacity > 0 && buildingUnlockStatus(registry, state, d).ok
    );
    if (home) raw.push({ type: 'build', buildingId: home.id, amount: 1 });
  }
  return validateQuests(raw, registry, state, game);
}

/** Belohnung einlösen (mechanisch geprüft). Wirft bei Fehler. */
export function claimQuest(registry, state, game, questId) {
  const q = (state.quests?.items || []).find((x) => x.id === questId);
  if (!q) throw new Error('Ziel nicht gefunden');
  if (q.claimed) throw new Error('Belohnung bereits eingelöst');
  if (!questProgress(state, q).done) throw new Error('Ziel noch nicht erreicht');
  const { resourceId, amount } = q.reward || {};
  if (resourceId && amount > 0) {
    const cap = registry.resources.get(resourceId)?.storable === false
      ? Infinity
      : storageCapacity(registry, state, game, resourceId);
    state.resources[resourceId] = Math.min(cap, (state.resources[resourceId] ?? 0) + amount);
  }
  q.claimed = true;
  return q;
}
