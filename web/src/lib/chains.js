// Produktionsketten-Analyse (Client): Wer liefert was, wer verbraucht was,
// und wo hakt die Kette (Engpässe). Rein aus Content + Spielzustand abgeleitet.

/** Index: welche Gebäudetypen erzeugen / verbrauchen welche Ressource. */
export function buildChainIndex(buildings = []) {
  const producers = {}; // rid -> [buildingId]
  const consumers = {}; // rid -> [buildingId]
  for (const b of buildings) {
    for (const rid of Object.keys(b.production?.outputs || {})) (producers[rid] ??= []).push(b.id);
    for (const rid of Object.keys(b.production?.inputs || {})) (consumers[rid] ??= []).push(b.id);
  }
  return { producers, consumers };
}

/** Summe der positiven Zuflüsse (Produktion) aus der Fluss-Aufschlüsselung. */
const inflowOf = (r) => (r.flow || []).filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);

/**
 * ECHTER Mangel: verbraucht, (fast) leer UND es fließt nichts nach → die
 * Produktion der Verbraucher steht wirklich. Ressourcen, die "von der Hand in
 * den Mund" leben (leer, aber Zufluss > 0 wird sofort wieder verbraucht),
 * sind KEIN Mangel — siehe computeBottlenecks.
 */
export function computeShortages(state, chain) {
  const short = new Set();
  if (!state) return short;
  for (const r of state.resources) {
    const consumed = (chain.consumers[r.id] || []).length > 0;
    if (!consumed) continue;
    const cap = r.capacity ?? Infinity;
    const nearlyEmpty = r.amount < Math.max(1, (Number.isFinite(cap) ? cap : 0) * 0.03);
    if (nearlyEmpty && r.ratePerTick <= 0 && inflowOf(r) < 0.001) short.add(r.id);
  }
  return short;
}

/**
 * Durchlauf-Engpass: (fast) leer, aber es wird produziert — der Nachschub wird
 * sofort ab Werk verbraucht. Läuft, aber ohne Puffer; Ausbau erhöht den Durchsatz.
 */
export function computeBottlenecks(state, chain) {
  const tight = new Set();
  if (!state) return tight;
  for (const r of state.resources) {
    const consumed = (chain.consumers[r.id] || []).length > 0;
    if (!consumed) continue;
    const cap = r.capacity ?? Infinity;
    const nearlyEmpty = r.amount < Math.max(1, (Number.isFinite(cap) ? cap : 0) * 0.03);
    if (nearlyEmpty && r.ratePerTick <= 0.001 && inflowOf(r) >= 0.001) tight.add(r.id);
  }
  return tight;
}

/** Gilt ein platziertes Gebäude als "ausgehungert" (ein Input fehlt)? */
export function isStarved(def, shortages) {
  if (!def?.production) return false;
  return Object.keys(def.production.inputs || {}).some((rid) => shortages.has(rid));
}

/**
 * Ketten-Nachbarn eines gewählten Gebäudes unter den platzierten Instanzen.
 * @returns {{suppliers: {rid,inst}[], customers: {rid,inst}[]}}
 */
export function chainNeighbors(inst, def, instances, defIndex, maxPer = 3) {
  const suppliers = [], customers = [];
  if (!def?.production) return { suppliers, customers };
  const inputs = Object.keys(def.production.inputs || {});
  const outputs = Object.keys(def.production.outputs || {});
  const dist2 = (a) => (a.x - inst.x) ** 2 + (a.y - inst.y) ** 2;

  for (const rid of inputs) {
    const src = instances
      .filter((o) => o.id !== inst.id && o.done && Object.keys(defIndex[o.buildingId]?.production?.outputs || {}).includes(rid))
      .sort((a, b) => dist2(a) - dist2(b))
      .slice(0, maxPer);
    for (const o of src) suppliers.push({ rid, inst: o });
  }
  for (const rid of outputs) {
    const dst = instances
      .filter((o) => o.id !== inst.id && o.done && Object.keys(defIndex[o.buildingId]?.production?.inputs || {}).includes(rid))
      .sort((a, b) => dist2(a) - dist2(b))
      .slice(0, maxPer);
    for (const o of dst) customers.push({ rid, inst: o });
  }
  return { suppliers, customers };
}
