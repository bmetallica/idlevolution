// Stufe 2 der KI-Spieler-Roadmap: täglicher LLM-Stratege je KI-Spieler.
// Exportiert den Insel-Zustand, lässt das lokale LLM einen Bauplan + Politik
// festlegen, validiert ihn und liefert einen Plan, den der deterministische
// Executor (Stufe 1) dann Tick für Tick umsetzt.

import { chatCompletion } from './generator.js';
import { currentEpoch, computeNetRates, totalHousing, buildingUnlockStatus } from '../engine/tick.js';
import { epochsInOrder } from '../content/loader.js';
import { describeConditions } from '../engine/rules.js';

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);

/** Kompakter Insel-Zustand + Handlungsoptionen für den LLM-Strategen. */
function snapshot(registry, player, game) {
  const rates = computeNetRates(registry, player, game);
  const epoch = currentEpoch(registry, player);
  const nextEpoch = epoch ? epochsInOrder(registry).find((e) => e.order === epoch.order + 1) : null;
  const housing = totalHousing(registry, player, game);
  const workforce = Math.floor(player.population);
  const assigned = Object.values(player.buildings).reduce((s, b) => s + (b.workers || 0), 0);

  const gebaeude = Object.entries(player.buildings)
    .filter(([, b]) => b.count > 0)
    .map(([id, b]) => ({ id, name: registry.buildings.get(id)?.name?.de || id, anzahl: b.count }));

  const ressourcen = [...registry.resources.values()]
    .map((r) => ({ id: r.id, menge: Math.round((player.resources[r.id] || 0) * 10) / 10, proTick: Math.round((rates[r.id] || 0) * 100) / 100 }))
    .filter((r) => r.menge !== 0 || r.proTick !== 0);

  // Freigeschaltete, prinzipiell baubare Gebäude (Optionen für den Strategen)
  const verfuegbareGebaeude = [...registry.buildings.values()]
    .filter((d) => buildingUnlockStatus(registry, player, d).ok)
    .map((d) => ({
      id: d.id, name: d.name?.de || d.id, kategorie: d.category,
      kosten: d.cost || {}, arbeiter: d.workers || 0,
      produziert: d.production?.outputs || {}, verbraucht: d.production?.inputs || {},
      wohnraum: d.housing?.capacity || 0,
    }));

  return {
    bevoelkerung: workforce, wohnraum: housing,
    zufriedenheit: Math.round((player.satisfaction ?? 1) * 100) + '%',
    freieArbeiter: Math.max(0, workforce - assigned),
    epoche: epoch?.name?.de,
    stufenbeduerfnisse: epoch?.needs || {},
    naechsteEpoche: nextEpoch ? { name: nextEpoch.name?.de, bedingungen: describeConditions(nextEpoch && epoch?.advance, registry, player) } : null,
    gebaeude, ressourcen, verfuegbareGebaeude,
  };
}

const SYSTEM = `Du bist der Stratege eines KI-Spielers in einem grafischen Aufbau-Idle-Spiel (Anno-Stil) auf einer eigenen Insel. Plane den Ausbau für den kommenden Zeitraum.
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt (kein Text drumherum):
{"strategie":"kurz","bauplan":[{"gebaeude":"<id>","anzahl":N}],"politik":{"nahrungsPuffer":0.2,"aggression":0.3},"persoenlichkeit":"kurz","chronik":"1 Satz"}
Regeln:
- Nutze für "gebaeude" NUR ids aus verfuegbareGebaeude.
- Reihenfolge = Priorität. Sichere zuerst Nahrung und Baumaterial (Holz/Stein), decke dann die aktuellen stufenbeduerfnisse, dann baue gezielt Richtung naechsteEpoche (deren bedingungen) und sinnvolle Produktionsketten.
- Baue kein Gebäude, dessen "verbraucht"-Güter du nicht selbst produzierst — plane die Vorkette (z.B. erst Erz-Mine, dann Hütte, dann Verarbeiter).
- "anzahl" klein halten (1–8 je Eintrag), insgesamt max 15 Einträge.
- politik.nahrungsPuffer 0..1 (Sicherheitsmarge Nahrung), aggression 0..1 (für spätere Konflikte).`;

function parsePlan(raw, registry) {
  const txt = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const buildQueue = (Array.isArray(obj.bauplan) ? obj.bauplan : [])
    .filter((x) => x && typeof x.gebaeude === 'string' && registry.buildings.has(x.gebaeude))
    .map((x) => ({ buildingId: x.gebaeude, count: clamp(x.anzahl, 1, 20, 1) | 0 }))
    .slice(0, 15);
  return {
    strategy: String(obj.strategie || '').slice(0, 300),
    buildQueue,
    policies: {
      foodBuffer: clamp(obj.politik?.nahrungsPuffer, 0, 1, 0.2),
      aggression: clamp(obj.politik?.aggression, 0, 1, 0.3),
    },
    personality: String(obj.persoenlichkeit || '').slice(0, 120),
    chronicle: String(obj.chronik || '').slice(0, 200),
    updatedAt: new Date().toISOString(),
  };
}

/** Erstellt (oder aktualisiert) den Plan eines KI-Spielers via LLM. Wirft bei Fehler. */
export async function planTurn(registry, player, game, llm) {
  const data = snapshot(registry, player, game);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Insel-Zustand (JSON):\n${JSON.stringify(data)}\n\nErstelle den Bauplan als JSON.` },
  ];
  const raw = await chatCompletion(llm, messages);
  const plan = parsePlan(raw, registry);
  if (!plan) throw new Error('LLM-Plan nicht parsebar');
  return plan;
}

export const _parsePlan = parsePlan; // für Tests
