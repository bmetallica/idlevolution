// Bedarfs-Ökonomie: Was kostet es (in Arbeitern), 1 Einheit/Tick eines Guts
// über die KOMPLETTE Vorkette zu produzieren? Epochen-Bedürfnisse skalieren
// pro Kopf — ohne diesen Deckel kann ein LLM (oder Mensch) Bedürfnisse
// definieren, die mehr Arbeiter erfordern, als es Einwohner gibt
// (historisch: armor 0.01/Kopf = 110 % der Bevölkerung → Todesspirale bis 1).

/** Anteil der Bevölkerung, den EIN Bedürfnis maximal binden darf. */
export const NEED_BUDGET_SHARE = 0.15;
export const NEED_MIN = 0.0001; // Untergrenze (Rundung), 4 Nachkommastellen

/**
 * Arbeiter je 1 Einheit/Tick von `rid` inkl. Vorkette (billigster Produzent).
 * `buildings` = Iterable von Gebäude-Defs (Registry + ggf. neues Pack).
 * Zyklen/ohne Produzent → Infinity.
 */
export function chainWorkerCost(buildings, rid, seen = new Set()) {
  if (seen.has(rid)) return Infinity;
  seen.add(rid);
  let best = Infinity;
  for (const b of buildings) {
    const out = b.production?.outputs?.[rid];
    if (!out || out <= 0) continue;
    let c = (b.workers || 0) / out;
    for (const [inRid, inRate] of Object.entries(b.production?.inputs || {})) {
      c += (inRate / out) * chainWorkerCost(buildings, inRid, new Set(seen));
    }
    best = Math.min(best, c);
  }
  return best;
}

/** Maximal leistbarer Pro-Kopf-Bedarf für ein Gut (nach Ketten-Kosten). */
export function maxAffordableNeed(buildings, rid, budgetShare = NEED_BUDGET_SHARE) {
  const cost = chainWorkerCost(buildings, rid);
  if (!Number.isFinite(cost) || cost <= 0) return NEED_MIN;
  return Math.max(NEED_MIN, Math.floor((budgetShare / cost) * 10000) / 10000);
}

/**
 * Kappt die needs einer Epoche auf leistbare Werte. Mutiert `epoch.needs`.
 * @returns {string[]} Notizen über gekappte Werte
 */
export function clampEpochNeeds(buildings, epoch, budgetShare = NEED_BUDGET_SHARE) {
  const notes = [];
  for (const [rid, per] of Object.entries(epoch.needs || {})) {
    const max = maxAffordableNeed(buildings, rid, budgetShare);
    if (per > max) {
      notes.push(`Epoche '${epoch.id}': need ${rid} ${per} → ${max} gekappt (Vorkette kostet ${chainWorkerCost(buildings, rid).toFixed(1)} Arbeiter/Einheit)`);
      epoch.needs[rid] = max;
    }
  }
  return notes;
}
