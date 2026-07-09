// In-Game-Berater: beantwortet Spielerfragen anhand des aktuellen Spielstands
// über das lokale LLM (dasselbe wie die nächtliche Generierung).

import { computeNetRates, totalHousing, currentEpoch } from '../engine/tick.js';
import { chatCompletion } from './generator.js';

/** Kompakte, für Beratung relevante Momentaufnahme des Spielstands. */
function snapshot(ctx) {
  const { registry } = ctx.registryHolder;
  const { state, game } = ctx;
  const rates = computeNetRates(registry, state, game);
  const epoch = currentEpoch(registry, state);
  const housing = totalHousing(registry, state, game);
  const foodNeed = state.population * game.foodPerPopPerTick;
  let foodAvail = 0, foodRate = 0;
  for (const r of registry.resources.values()) if (r.category === 'food') { foodAvail += state.resources[r.id] || 0; foodRate += rates[r.id] || 0; }

  const buildings = Object.entries(state.buildings)
    .filter(([, b]) => b.count > 0)
    .map(([id, b]) => {
      const def = registry.buildings.get(id);
      return {
        name: def?.name?.de || id,
        anzahl: b.count,
        arbeiter: `${b.workers || 0}/${(def?.workers || 0) * b.count}`,
        produziert: Object.keys(def?.production?.outputs || {}),
        verbraucht: Object.keys(def?.production?.inputs || {}),
      };
    });
  const resources = [...registry.resources.values()].map((r) => ({
    name: r.name?.de || r.id,
    kategorie: r.category,
    menge: Math.round((state.resources[r.id] || 0) * 10) / 10,
    proTick: Math.round((rates[r.id] || 0) * 1000) / 1000,
  }));

  return {
    bevoelkerung: Math.round(state.population * 10) / 10,
    wohnraum: housing,
    zufriedenheit: Math.round((state.satisfaction ?? 1) * 100) + '%',
    nahrung: { vorhanden: Math.round(foodAvail * 10) / 10, bedarfProTick: Math.round(foodNeed * 100) / 100, produktionProTick: Math.round(foodRate * 1000) / 1000, ausreichend: foodAvail + 1e-6 >= foodNeed },
    epoche: epoch?.name?.de,
    bevoelkerungsstufe: epoch?.tier?.name?.de,
    stufenbeduerfnisse: epoch?.needs || null,
    freieArbeiter: Math.floor(state.population) - buildings.reduce((s, b) => s + (Number(b.arbeiter.split('/')[0]) || 0), 0),
    gebaeude: buildings,
    ressourcen: resources,
  };
}

const SYSTEM = `Du bist ein hilfreicher Berater in einem grafischen Aufbau-Idle-Spiel (Stil Anno).
Beantworte die Frage des Spielers KURZ (höchstens 4 Sätze), konkret und auf Deutsch — ausschließlich anhand der bereitgestellten Spieldaten, ohne Erfindungen.
Wichtige Regeln der Simulation:
- Bevölkerung schrumpft bei Nahrungsmangel (nahrung.ausreichend=false bzw. produktionProTick ≤ bedarfProTick) ODER bei Unzufriedenheit (zufriedenheit < 40%, weil Stufenbedürfnisse fehlen).
- Bevölkerung wächst nur bei Nahrungs-Überschuss und freiem Wohnraum.
- Produktionsgebäude brauchen zugewiesene Arbeiter (arbeiter "zugewiesen/maximal"); ohne Arbeiter keine Produktion.
Nenne die konkrete Ursache und einen umsetzbaren Rat (welches Gebäude bauen / wo Arbeiter zuweisen).`;

/** Beantwortet eine Spielerfrage anhand des Spielstands. */
export async function askAdvisor(question, ctx) {
  const data = snapshot(ctx);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Spieldaten (JSON):\n${JSON.stringify(data)}\n\nFrage des Spielers: ${question}` },
  ];
  const raw = await chatCompletion(ctx.config.llm, messages);
  // Reasoning-Modelle liefern manchmal <think>…</think> voran — entfernen
  return String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
