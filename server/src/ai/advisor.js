// In-Game-Berater: beantwortet Spielerfragen anhand des aktuellen Spielstands
// über das lokale LLM (dasselbe wie die nächtliche Generierung).

import { computeNetRates, totalHousing, currentEpoch } from '../engine/tick.js';
import { chatCompletion } from './generator.js';
import { llmSafeName } from '../content/loader.js';

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

  // Stufen-Bedürfnisse mit Deckungsstatus + Netto-Rate (deckt drainende Vorräte auf)
  const stufenbeduerfnisse = epoch?.needs
    ? Object.entries(epoch.needs).map(([rid, perPop]) => {
        const need = state.population * perPop;
        const have = state.resources[rid] || 0;
        const rate = rates[rid] || 0;
        return {
          gut: llmSafeName(registry.resources.get(rid)) || rid,
          vorhanden: Math.round(have * 10) / 10,
          bedarfProTick: Math.round(need * 100) / 100,
          nettoRateProTick: Math.round(rate * 1000) / 1000,
          gedeckt: have + 1e-6 >= need,
          vorratSchrumpft: rate < -1e-6,
        };
      })
    : [];

  const buildings = Object.entries(state.buildings)
    .filter(([, b]) => b.count > 0)
    .map(([id, b]) => {
      const def = registry.buildings.get(id);
      return {
        name: llmSafeName(def) || id,
        anzahl: b.count,
        arbeiter: `${b.workers || 0}/${(def?.workers || 0) * b.count}`,
        produziert: Object.keys(def?.production?.outputs || {}),
        verbraucht: Object.keys(def?.production?.inputs || {}),
      };
    });
  const resources = [...registry.resources.values()].map((r) => ({
    name: llmSafeName(r),
    kategorie: r.category,
    menge: Math.round((state.resources[r.id] || 0) * 10) / 10,
    proTick: Math.round((rates[r.id] || 0) * 1000) / 1000,
  }));

  // Militär-Lage (Stufe 6) — sonst kann der Berater Kriegs-Fragen nicht beantworten
  const decls = ctx.world?.warDeclarations || [];
  const militaer = {
    soldaten: Math.floor(state.resources.soldiers || 0),
    verteidigung: (() => {
      let towers = 0;
      for (const i of state.instances || []) {
        if (!i.counted) continue;
        towers += registry.buildings.get(i.buildingId)?.meta?.military?.defense || 0;
      }
      return Math.floor(state.resources.soldiers || 0) + towers + Math.floor((state.population || 0) * 0.05);
    })(),
    eigeneAngriffeHeuteNacht: decls.filter((d) => d.attackerId === state.id).map((d) => d.soldiers),
    angriffeGegenMichHeuteNacht: decls.filter((d) => d.defenderId === state.id).map((d) => d.soldiers),
  };

  return {
    bevoelkerung: Math.round(state.population * 10) / 10,
    wohnraum: housing,
    militaer,
    zufriedenheit: Math.round((state.satisfaction ?? 1) * 100) + '%',
    nahrung: { vorhanden: Math.round(foodAvail * 10) / 10, bedarfProTick: Math.round(foodNeed * 100) / 100, produktionProTick: Math.round(foodRate * 1000) / 1000, ausreichend: foodAvail + 1e-6 >= foodNeed },
    epoche: epoch?.name?.de,
    bevoelkerungsstufe: epoch?.tier?.name?.de,
    stufenbeduerfnisse,
    freieArbeiter: Math.floor(state.population) - buildings.reduce((s, b) => s + (Number(b.arbeiter.split('/')[0]) || 0), 0),
    gebaeude: buildings,
    ressourcen: resources,
  };
}

const SYSTEM = `Du bist ein hilfreicher Berater in einem grafischen Aufbau-Idle-Spiel (Stil Anno).
Beantworte die Frage des Spielers KURZ (höchstens 4 Sätze), konkret und auf Deutsch — ausschließlich anhand der bereitgestellten Spieldaten, ohne Erfindungen.
Wichtige Regeln der Simulation:
- Bevölkerung schrumpft bei Nahrungsmangel (nahrung.ausreichend=false) ODER bei Unzufriedenheit (zufriedenheit < 40 %).
- Unzufriedenheit entsteht, wenn ein Stufenbedürfnis (stufenbeduerfnisse[]) nicht gedeckt ist (gedeckt=false). WICHTIG: Auch ein volles Lager schützt nicht dauerhaft — bei nettoRateProTick < 0 (vorratSchrumpft=true) läuft der Vorrat leer und die Bevölkerung schrumpft trotz aktueller Menge. Prüfe daher zuerst diese Liste, wenn Bevölkerung sinkt aber Nahrung reicht.
- Bevölkerung wächst nur bei Nahrungs-Überschuss und freiem Wohnraum.
- Produktionsgebäude brauchen zugewiesene Arbeiter (arbeiter "zugewiesen/maximal"); ohne Arbeiter keine Produktion. Zu wenig Produktion eines Stufen-Guts → nettoRateProTick negativ → Vorrat drainert.
- KRIEG: Die Kaserne bildet Soldaten aus; Wehranlagen und Miliz (5 % der Bevölkerung) verteidigen. Raubzüge werden tagsüber erklärt und schlagen sich in der NACHT (KI-Lauf) — der Sieger plündert max. 25 % je Vorrat, Inseln wechseln nie den Besitzer. "militaer" zeigt die Lage inkl. heute Nacht anstehender Angriffe.
Nenne die konkrete Ursache und einen umsetzbaren Rat (welches Gebäude bauen / wo Arbeiter zuweisen).`;

/** Beantwortet eine Spielerfrage anhand des Spielstands. */
export async function askAdvisor(question, ctx) {
  const data = snapshot(ctx);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Spieldaten (JSON):\n${JSON.stringify(data)}\n\nFrage des Spielers: ${question}` },
  ];
  // Kleines Budget: 4-Sätze-Antworten brauchen keine 12k Tokens — spart
  // GPU-Zeit, wenn parallel die Nacht-Generierung läuft. (Reasoning-Puffer inkl.)
  const raw = await chatCompletion({ ...ctx.config.llm, maxTokens: Math.min(ctx.config.llm.maxTokens, 2048), temperature: 0.4 }, messages);
  // Reasoning-Modelle liefern manchmal <think>…</think> voran — entfernen
  return String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
