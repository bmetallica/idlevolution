// Ruft das lokale LLM (llama.cpp / llama-swap, OpenAI-kompatibel) auf und
// erzeugt ein Content-Pack. Strukturelle Korrektheit wird doppelt gesichert:
// per response_format (Grammatik im LLM-Server) und später durch den Import-Validierer.

// Vereinfachtes Schema für die LLM-Grammatik (ohne $refs/propertyNames, die
// llama.cpp's json-schema-to-grammar nicht zuverlässig unterstützt).
const numberMap = { type: 'object', additionalProperties: { type: 'number' } };
const i18n = {
  type: 'object',
  properties: { de: { type: 'string' }, en: { type: 'string' } },
  required: ['de'],
};
const advance = {
  type: 'object',
  properties: { resources: numberMap, buildings: numberMap, population: { type: 'number' } },
};

export function llmPackSchema() {
  return {
    type: 'object',
    properties: {
      chronicle: {
        type: 'object',
        properties: { de: { type: 'string' } },
        required: ['de'],
      },
      resources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: i18n,
            description: i18n,
            category: { enum: ['raw', 'processed', 'food', 'luxury', 'special'] },
            icon: { type: 'string' },
            epoch: { type: 'string' },
            baseValue: { type: 'number' },
          },
          required: ['id', 'name', 'category', 'epoch', 'baseValue'],
        },
      },
      buildings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: i18n,
            description: i18n,
            category: { enum: ['production', 'storage', 'housing', 'civic'] },
            epoch: { type: 'string' },
            icon: { type: 'string' },
            cost: numberMap,
            buildTimeTicks: { type: 'integer' },
            workers: { type: 'integer' },
            production: {
              type: 'object',
              properties: { inputs: numberMap, outputs: numberMap },
            },
            storage: numberMap,
            housing: { type: 'object', properties: { capacity: { type: 'integer' } } },
            requires: {
              type: 'object',
              properties: {
                epoch: { type: 'string' },
                buildings: numberMap,
                resources: numberMap,
                population: { type: 'number' },
              },
            },
            placement: {
              type: 'object',
              properties: {
                terrain: { type: 'array', items: { enum: ['grass', 'sand', 'forest', 'rock'] } },
                adjacent: { type: 'object', additionalProperties: { type: 'integer' } },
                size: {
                  type: 'object',
                  properties: { w: { type: 'integer' }, h: { type: 'integer' } },
                },
              },
            },
            meta: {
              type: 'object',
              properties: {
                art: {
                  type: 'object',
                  properties: {
                    shape: { type: 'string' },
                    accent: { type: 'string' },
                    wall: { type: 'string' },
                    roof: { type: 'string' },
                  },
                },
              },
            },
          },
          required: ['id', 'name', 'category', 'epoch', 'cost'],
        },
      },
      epochs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            order: { type: 'integer' },
            name: i18n,
            description: i18n,
            advance,
            modifiers: {
              type: 'object',
              properties: {
                productionMultiplier: { type: 'number' },
                populationGrowth: { type: 'number' },
              },
            },
            needs: numberMap,
            tier: { type: 'object', properties: { name: i18n } },
          },
          required: ['id', 'order', 'name'],
        },
      },
      epochAdvance: { type: 'object', additionalProperties: advance },
    },
    required: ['chronicle'],
  };
}

export function buildMessages(exportData, balance) {
  const system = `Du bist der Content-Designer eines datengetriebenen Idle-Aufbauspiels (Stil: Anno).
Du erweiterst das Spiel jede Nacht um neue Inhalte, die zum aktuellen Spielstand passen.

Du antwortest AUSSCHLIESSLICH mit einem JSON-Objekt (Content-Pack) mit diesen optionalen Feldern:
- "chronicle": { "de": "..." } — PFLICHT: kurzer erzählerischer Tagesbericht (2-4 Sätze, Deutsch), der die neuen Inhalte narrativ einführt.
- "resources": Array neuer Ressourcen: { id, name:{de,en}, description:{de}, category (raw|processed|food|luxury|special), icon (1 Emoji), epoch, baseValue }
- "buildings": Array neuer Gebäude: { id, name:{de,en}, description:{de}, category (production|storage|housing|civic), epoch, icon (1 Emoji), cost:{ressourceId:menge}, buildTimeTicks, workers, production:{inputs:{},outputs:{}}, storage:{ressourceId:kapazität} oder {"*":kapazität}, housing:{capacity}, requires:{epoch,buildings:{},resources:{},population}, placement:{terrain:["grass"|"sand"], adjacent:{"forest"|"rock"|"water"|"grass": anzahl 1-8}} }
  Das Spiel hat eine Insel-Karte mit den Terrains grass, sand, forest, rock, water. "placement.terrain" = worauf gebaut wird (Standard: grass), "placement.adjacent" = welches Terrain angrenzen muss (z.B. Mine braucht rock, Fischer braucht water), "placement.size" = Grundfläche {w,h} in Feldern (1-4, Standard 1×1; Lager/Zivilbauten gern 2×1 oder 2×2). Setze IMMER ein glaubwürdiges placement passend zur Funktion des Gebäudes.
  GRAFIK ("meta.art"): Die Engine zeichnet Gebäude prozedural. Wähle mit "meta.art.shape" die passende Silhouette — erlaubt: house, farm, woodcutter, sawmill, gatherer, mine, quarry, smelter (Schmelze/Ofen, glüht), workshop, fishery, market, temple, tower, warehouse. (Ohne shape wird der Typ automatisch aus Funktion/Name erraten.) Für neue Zeitalter/Materialien kannst du das Aussehen anpassen: "meta.art.accent" = Signaturfarbe (Hex, z.B. "#c94f2a"), "meta.art.wall"/"meta.art.roof" = Wand-/Dachfarbe (Hex) für epochentypische Baustoffe.
- "epochs": Array mit maximal EINER neuen Epoche: { id, order, name:{de,en}, description:{de}, advance (oder null wenn vorerst final), modifiers, tier, needs }. Bei einer neuen Epoche sind PFLICHT:
    • "modifiers": { "productionMultiplier": (steigt je Epoche, z.B. +0.2 gegenüber der Vorepoche), "populationGrowth": (klein, z.B. 0.012–0.02) }
    • "tier": { "name": {de,en} } = wie die Bevölkerung dieser Stufe heißt (Steinzeit "Jäger & Sammler" → "Siedler" → "Bürger" → …).
    • "needs": { ressourceId: mengeProKopfProTick } = 1–3 Güter, welche die Bevölkerung dieser Ära zum Zufriedensein verlangt (klein, 0.005–0.03; typisch ein verarbeitetes Gut oder Luxusgut der Epoche). Erfüllte needs → volles Wachstum, unerfüllte → Unzufriedenheit/Abwanderung. Führe für JEDES need-Gut auch einen Produzenten ein (in diesem Pack neu oder bereits existierend), sonst stagniert die Ära.
- "epochAdvance": { "<epochen-id>": {resources:{},buildings:{},population} } — Aufstiegsbedingung für eine existierende Epoche, die noch keine hat. PFLICHT, wenn du eine neue Epoche anlegst.

HARTE REGELN:
1. IDs: englisch, lowercase snake_case (z.B. "copper_mine"). Niemals existierende IDs wiederverwenden.
2. Referenziere nur Ressourcen/Gebäude/Epochen, die im Spielstand existieren ODER die du im selben Pack neu anlegst.
3. Produktionsraten sind Mengen PRO TICK und klein (typisch 0.1 bis 1.0).
4. Balancing: Netto-Wertschöpfung pro Tick (Σ outputs×baseValue − Σ inputs×baseValue) darf höchstens workers × ${balance.workerValuePerTick} × ${balance.netValueSlack} × ${balance.epochValueGrowth}^epochenOrder betragen. Produktionsgebäude ohne Arbeiter sind verboten.
5. Neue Gebäude dürfen maximal ${Math.round((balance.maxIncreaseOverBest ?? 0.25) * 100)}% besser sein als das beste existierende Gebäude ihrer Epoche.
6. Baukosten müssen sich frühestens nach ${balance.minAmortizationTicks} Ticks amortisieren (cost-Wert ≥ ${balance.minAmortizationTicks} × Netto-Wert/Tick).
7. Maximal ${balance.maxNewResourcesPerPack ?? 3} Ressourcen, ${balance.maxNewBuildingsPerPack ?? 4} Gebäude, ${balance.maxNewEpochsPerPack ?? 1} Epoche pro Pack.
8. Eine neue Epoche braucht order = höchste existierende order + 1, einen "epochAdvance"-Eintrag für die bisherige letzte Epoche UND zwingend modifiers, tier und needs (mit passenden Produzenten für die need-Güter).
9. Baue sinnvolle Produktionsketten: neue Ressourcen brauchen Produzenten, verarbeitende Gebäude brauchen existierende Inputs.
10. Beachte die "recentRejections" im Spielstand: wiederhole abgelehnte Fehler nicht.
11. VIELFALT & TERRAIN: Nutze das Terrain thematisch — Fischer/Häfen an "water" (placement.adjacent {water}), Minen/Steinbrüche an "rock", Förster/Jäger an "forest", Farmen/Gärten auf "grass". Variiere die Gebäude-Typen (unterschiedliche meta.art.shape statt immer "workshop").
12. WOHNEN & KOMFORT: Führe pro neuer Epoche mindestens ein besseres Wohngebäude ein (mehr housing.capacity als die Vorepoche) sowie 1-2 "luxury"-Güter (Komfortwaren), die als Epochen-"needs" die Zufriedenheit der höheren Bevölkerungsstufe tragen — mit passenden Produzenten.`;

  const user = `Hier ist der aktuelle Siedlungs-Status als JSON:

${JSON.stringify(exportData, null, 1)}

Analysiere die "gaps" und den Zustand der Wirtschaft. Erzeuge ein Content-Pack mit 1-3 neuen Gebäuden und 0-2 neuen Ressourcen, das die größten Lücken schließt und die nächste Spielphase vorbereitet. Falls der Epochen-Aufstieg nah ist und die Folge-Epoche fehlt oder leer ist, fülle sie. Antworte nur mit dem JSON-Objekt.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractJSON(text) {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('keine JSON-Struktur in der Antwort');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function chatCompletion(llm, messages, responseFormat) {
  const body = {
    model: llm.model,
    messages,
    temperature: llm.temperature,
    max_tokens: llm.maxTokens,
  };
  if (responseFormat) body.response_format = responseFormat;
  const res = await fetch(`${llm.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    if (choice?.finish_reason === 'length') {
      throw new Error(
        'Token-Budget erschöpft, bevor Content kam (Reasoning-Modell?) — LLM_MAX_TOKENS erhöhen'
      );
    }
    throw new Error('leere LLM-Antwort');
  }
  return content;
}

/**
 * Erzeugt ein Content-Pack. Probiert strukturierte Ausgabeformate in absteigender
 * Strenge — je nach llama.cpp-Version wird json_schema oder json_object unterstützt.
 * @returns {{pack: object, raw: string, formatUsed: string}}
 */
export async function generatePack(exportData, llm, balance) {
  const messages = buildMessages(exportData, balance);
  const schema = llmPackSchema();
  const formats = [
    { name: 'json_schema', rf: { type: 'json_schema', json_schema: { name: 'content_pack', schema } } },
    { name: 'json_object+schema', rf: { type: 'json_object', schema } },
    { name: 'none', rf: null },
  ];
  let lastErr;
  for (const { name, rf } of formats) {
    try {
      const raw = await chatCompletion(llm, messages, rf);
      const pack = extractJSON(raw);
      pack.pack = { ...(pack.pack || {}), model: llm.model };
      return { pack, raw, formatUsed: name };
    } catch (err) {
      lastErr = err;
      // Bei HTTP 4xx (Format nicht unterstützt) nächstes Format probieren,
      // bei Parse-Fehlern ebenfalls — strengere Validierung folgt ohnehin.
    }
  }
  throw new Error(`Generierung fehlgeschlagen: ${lastErr?.message}`);
}
