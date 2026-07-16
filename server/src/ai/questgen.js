// E1: LLM-Seite der Tagesziele — kleiner Chat-Modell-Call mit kompaktem Snapshot.
// Liefert nur ROHE Vorschläge; validateQuests() (engine/quests.js) entscheidet
// mechanisch über Erreichbarkeit, Mengen und Belohnungen.

import { chatCompletion, extractJSON } from './generator.js';
import { currentEpoch, totalHousing, buildingUnlockStatus } from '../engine/tick.js';

const SYSTEM = `Du bist der Quest-Designer eines deutschen Aufbau-Idle-Spiels (Stil Anno).
Erzeuge GENAU 3 abwechslungsreiche Tagesziele als JSON:
{"quests":[{"type":"build","buildingId":"…","amount":2,"title":{"de":"…"}},{"type":"stock","resourceId":"…","amount":150,"title":{"de":"…"}},{"type":"population","amount":120,"title":{"de":"…"}}]}
Regeln:
- "build": amount (1-3) WEITERE Gebäude eines Typs aus "freigeschaltet" bauen.
- "stock": amount Einheiten einer Ressource aus "ressourcen" lagern — spürbar ÜBER dem aktuellen Vorrat, realistisch für einen Tag.
- "population": Einwohnerzahl etwas über "bevoelkerung", höchstens "wohnraum".
- Nutze NUR IDs aus den Spieldaten. Bevorzuge, was der Siedlung strategisch hilft (Bedürfnisse decken, Engpässe).
- "title": kurz, deutsch, motivierend (z.B. "Die Kornkammern füllen").
Antworte NUR mit dem JSON-Objekt.`;

export async function generateQuestIdeas(ctx) {
  const { registry } = ctx.registryHolder;
  const { state, game } = ctx;
  const epoch = currentEpoch(registry, state);
  const data = {
    epoche: epoch?.id,
    bevoelkerung: Math.floor(state.population),
    wohnraum: totalHousing(registry, state, game),
    beduerfnisse: Object.keys(epoch?.needs || {}),
    gebaut: Object.entries(state.buildings)
      .filter(([, b]) => b.count > 0)
      .slice(0, 12)
      .map(([id, b]) => ({ id, count: b.count })),
    freigeschaltet: [...registry.buildings.values()]
      .filter((d) => buildingUnlockStatus(registry, state, d).ok)
      .map((d) => d.id)
      .slice(0, 30),
    ressourcen: Object.entries(state.resources)
      .filter(([, v]) => v > 0)
      .slice(0, 15)
      .map(([id, v]) => ({ id, menge: Math.floor(v) })),
  };
  // Reasoning-Puffer: Gemma denkt erst (<think>), dann kommt das JSON — 1536 war zu knapp
  const raw = await chatCompletion(
    { ...ctx.config.llm, model: ctx.config.llm.modelChat || ctx.config.llm.model, maxTokens: Math.min(ctx.config.llm.maxTokens, 6144), temperature: 0.7 },
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Spieldaten (JSON):\n${JSON.stringify(data)}` },
    ]
  );
  const parsed = extractJSON(raw);
  return Array.isArray(parsed?.quests) ? parsed.quests : [];
}
