// Stufe 1 der KI-Spieler-Roadmap: deterministischer Per-Tick-"Taktiker".
// Spielt eine KI-Insel jeden Tick ohne LLM: weist Arbeiter zu (Nahrung zuerst),
// sichert die Nahrungsversorgung und baut bei Bedarf ein sinnvolles Gebäude auf
// der eigenen Insel. Nutzt exakt dieselben Engine-Operationen wie der Mensch.
//
// Datengetrieben: kennt keine festen Gebäude-IDs, sondern arbeitet über
// Kategorien/Produktion/Bedürfnisse — funktioniert also auch mit KI-generiertem
// Content. Der spätere LLM-Stratege (Stufe 2) liefert nur eine buildQueue/Politik.

import { startBuild, buildingUnlockStatus, totalHousing, currentEpoch, computeNetRates } from '../engine/tick.js';
import { describeConditions } from '../engine/rules.js';
import { findFreeSpot } from '../engine/map.js';

const producesFood = (registry, def) =>
  Object.keys(def.production?.outputs || {}).some((rid) => registry.resources.get(rid)?.category === 'food');
const outputValue = (def) => Object.values(def.production?.outputs || {}).reduce((s, v) => s + v, 0);

/** Aktuelle Netto-Nahrungsrate (Summe aller food-Ressourcen). */
function foodNetRate(registry, player, rates) {
  let r = 0;
  for (const res of registry.resources.values()) if (res.category === 'food') r += rates[res.id] || 0;
  return r;
}

/** Verteilt freie Arbeiter auf unterbesetzte Gebäude — Nahrung > Bedürfnisse > Rest. */
function autoAssignWorkers(registry, player) {
  const workforce = Math.floor(player.population);
  let assigned = Object.values(player.buildings).reduce((s, b) => s + (b.workers || 0), 0);
  let idle = workforce - assigned;
  if (idle <= 0) return;
  const epoch = currentEpoch(registry, player);
  const needIds = new Set(Object.keys(epoch?.needs || {}));
  const rawMats = new Set();
  for (const d of registry.buildings.values()) for (const r of Object.keys(d.cost || {})) if (registry.resources.get(r)?.category !== 'food') rawMats.add(r);
  const rank = (bid) => {
    const def = registry.buildings.get(bid);
    if (!def?.production) return 5;
    const outs = Object.keys(def.production.outputs || {});
    if (producesFood(registry, def)) return 0;               // Nahrung zuerst
    if (outs.some((r) => rawMats.has(r))) return 1;          // Baumaterial (Holz/Stein/Bretter)
    if (outs.some((r) => needIds.has(r))) return 2;          // Stufen-Bedürfnisse
    return 3;                                                 // Rest
  };
  const order = Object.keys(player.buildings).sort((a, b) => rank(a) - rank(b));
  for (const bid of order) {
    if (idle <= 0) break;
    const def = registry.buildings.get(bid);
    const b = player.buildings[bid];
    if (!def || !b?.count) continue;
    const max = (def.workers || 0) * b.count;
    while ((b.workers || 0) < max && idle > 0) { b.workers = (b.workers || 0) + 1; idle--; }
  }
}

/** Wählt das nächste sinnvoll zu bauende Gebäude (freigeschaltet + leistbar). */
function chooseBuild(registry, player, game) {
  const affordable = (def) => Object.entries(def.cost || {}).every(([r, a]) => (player.resources[r] || 0) >= a);
  const unlocked = (def) => buildingUnlockStatus(registry, player, def).ok;
  const cands = [...registry.buildings.values()].filter((d) => unlocked(d) && affordable(d));
  if (!cands.length) return null;

  const rates = computeNetRates(registry, player, game);
  const housing = totalHousing(registry, player, game);
  const foodNeed = player.population * game.foodPerPopPerTick;
  let foodStock = 0;
  for (const res of registry.resources.values()) if (res.category === 'food') foodStock += player.resources[res.id] || 0;

  const workforce = Math.floor(player.population);
  const assigned = Object.values(player.buildings).reduce((s, b) => s + (b.workers || 0), 0);
  const idle = workforce - assigned;

  // Nur bauen, was mit den aktuell freien Arbeitern besetzt werden kann — sonst
  // häufen sich unbesetzte, nutzlose Gebäude und füllen die Insel.
  const staffable = (d) => (d.workers || 0) <= idle;
  const producerOf = (rid) => cands.filter((d) => (d.production?.outputs || {})[rid] > 0 && staffable(d)).sort((a, b) => outputValue(b) - outputValue(a))[0];
  const bestHouse = () => cands.filter((d) => (d.housing?.capacity || 0) > 0).sort((a, b) => b.housing.capacity - a.housing.capacity)[0];

  // Liefert das nächste JETZT baubare Gebäude, um Ressource `rid` zu produzieren —
  // baut fehlende Vorketten von unten auf (z.B. Stahl → Eisenbarren → Eisenerz → Mine).
  function nextForResource(rid, depth = 0, seen = new Set()) {
    if (depth > 6 || seen.has(rid)) return null;
    seen.add(rid);
    const p = producerOf(rid); // leistbar + freigeschaltet
    if (p) {
      for (const inp of Object.keys(p.production?.inputs || {})) {
        if (!hasProducer(inp) || (player.resources[inp] || 0) < 5) {
          const sub = nextForResource(inp, depth + 1, seen);
          if (sub) return sub; // erst die Vorkette sichern
        }
      }
      return p;
    }
    // kein leistbarer Produzent → evtl. fehlt ein Input eines (teureren) Produzenten
    const any = [...registry.buildings.values()].find((d) => unlocked(d) && (d.production?.outputs || {})[rid] > 0);
    if (any) for (const inp of Object.keys(any.production?.inputs || {})) {
      const sub = nextForResource(inp, depth + 1, seen);
      if (sub) return sub;
    }
    return null;
  }
  const bestFood = () => cands.filter((d) => producesFood(registry, d) && staffable(d)).sort((a, b) => outputValue(b) - outputValue(a))[0];
  const hasProducer = (rid) => Object.entries(player.buildings).some(([bid, b]) => b.count > 0 && (registry.buildings.get(bid)?.production?.outputs || {})[rid] > 0);

  // A) Nahrungs-Notfall: Rate negativ und Vorrat dünn → sofort Nahrung
  if (foodNetRate(registry, player, rates) < 0 && foodStock < foodNeed * 20) {
    const f = bestFood(); if (f) return f;
  }
  // C) Freie Arbeiter zuerst PRODUKTIV/Richtung Tech einsetzen (nicht in Wohnraum
  //    versenken) — sonst wächst nur die Bevölkerung und die Ära stagniert.
  if (idle >= 1) {
    // C1) NAHRUNG zuerst (Überleben) — Produzenten bauen, solange die Rate knapp ist
    if (foodNetRate(registry, player, rates) < foodNeed * 0.4) { const f = bestFood(); if (f) return f; }
    // C2) Baumaterial-Versorgung auf eine Ziel-RATE deckeln (nicht endlos bauen):
    //     Produzenten nur, bis die Netto-Produktion das Ziel erreicht. Verhindert das
    //     Zubauen der ganzen Insel (sonst kein Platz für spätere teure Ketten).
    const RAW_TARGET = 2.5;
    const costMats = new Set();
    for (const d of registry.buildings.values()) if (unlocked(d)) for (const r of Object.keys(d.cost || {})) costMats.add(r);
    for (const rid of costMats) {
      if (registry.resources.get(rid)?.category === 'food') continue;
      if (!hasProducer(rid) || (rates[rid] || 0) < RAW_TARGET) { const p = producerOf(rid); if (p) return p; }
    }
    const epoch = currentEpoch(registry, player);
    // PLAN) LLM-Bauplan des Strategen abarbeiten (Stufe 2), auf dem Sicherheitsnetz
    //       (Nahrung/Baumaterial) aufsetzend: nächstes offenes Ziel bauen; ist es
    //       noch nicht baubar, dessen fehlende Kosten-Vorkette sichern.
    const q = (player.plan?.buildQueue || []).find((it) => it.count > 0);
    if (q) {
      const def = cands.find((c) => c.id === q.buildingId && staffable(c));
      if (def) return def;
      const target = registry.buildings.get(q.buildingId);
      if (target) for (const [rid, amt] of Object.entries(target.cost || {})) {
        if (registry.resources.get(rid)?.category === 'food') continue;
        if ((player.resources[rid] || 0) < amt) { const d = nextForResource(rid); if (d) return d; }
      }
    }
    // C3) STUFEN-BEDÜRFNISSE (halten die Bevölkerung zufrieden) — inkl. Vorkette.
    //     Muss vor dem Aufstieg kommen, sonst kollabiert die Bevölkerung in der neuen Ära.
    for (const [rid, perPop] of Object.entries(epoch?.needs || {})) {
      const short = (rates[rid] || 0) <= 0 || (player.resources[rid] || 0) < player.population * perPop * 8;
      if (short) { const d = nextForResource(rid); if (d) return d; }
    }
    // C4) Aufstieg nur verfolgen, wenn die AKTUELLE Ära stabil ist — sonst prescht
    //     die KI in eine Epoche, deren Bedürfnisse sie nicht deckt, und kollabiert.
    const needsMet = Object.entries(epoch?.needs || {}).every(([rid, pp]) => (rates[rid] || 0) >= -1e-6 && (player.resources[rid] || 0) >= player.population * pp);
    const stable = (player.satisfaction ?? 1) >= 0.7 && foodNetRate(registry, player, rates) > foodNeed * 0.5 && needsMet;
    if (stable && epoch?.advance) {
      for (const item of describeConditions(epoch.advance, registry, player)) {
        if (item.ok) continue;
        if (item.type === 'building') { const d = cands.find((c) => c.id === item.id && staffable(c)); if (d) return d; }
        else if (item.type === 'resource') { const d = nextForResource(item.id); if (d) return d; }
      }
    }
  }
  // B) Wohnraum NUR, wenn Arbeiter knapp sind (idle < 2) und die Bevölkerung am
  //    Limit ist. So folgt die Bevölkerung dem Arbeitsbedarf, statt maßlos zu
  //    wachsen und die Insel mit Hütten zuzubauen (kein Platz mehr für Tech).
  if (idle < 2 && player.population >= housing - 0.5) return bestHouse() || null;
  return null;
}

/** Ein Executor-Schritt für einen KI-Spieler (mutiert player). */
export function runExecutor(registry, player, game) {
  if (player.kind !== 'ai' || player.active === false) return;
  autoAssignWorkers(registry, player);

  // Nicht zu viele gleichzeitige Baustellen → kontrolliertes Wachstum
  const pending = (player.instances || []).filter((i) => !i.counted).length;
  if (pending >= 3) return;

  const def = chooseBuild(registry, player, game);
  if (!def) return;
  const isl = player.region;
  const cx = isl ? isl.x + Math.floor(isl.w / 2) : undefined;
  const cy = isl ? isl.y + Math.floor(isl.h / 2) : undefined;
  const spot = findFreeSpot(player.map, player, registry, def, cx, cy);
  if (!spot) return;
  try {
    startBuild(registry, player, game, def.id, spot.x, spot.y, 0);
    const it = (player.plan?.buildQueue || []).find((x) => x.buildingId === def.id && x.count > 0);
    if (it) it.count -= 1; // Plan-Fortschritt
    autoAssignWorkers(registry, player); // neues Gebäude ggf. gleich besetzen
  } catch {
    // Platzierung/Leistbarkeit kann sich zwischen Prüfung und Bau ändern — ignorieren
  }
}
