// Ruft das lokale LLM (llama.cpp / llama-swap, OpenAI-kompatibel) auf und
// erzeugt ein Content-Pack. Strukturelle Korrektheit wird doppelt gesichert:
// per response_format (Grammatik im LLM-Server) und später durch den Import-Validierer.

// Vereinfachtes Schema für die LLM-Grammatik (ohne $refs/propertyNames, die
// llama.cpp's json-schema-to-grammar nicht zuverlässig unterstützt).
import { BUILDING_SHAPES } from '../content/shapes.js';

const numberMap = { type: 'object', additionalProperties: { type: 'number' } };
// ID-Form schon in der Grammatik erzwingen — eliminiert eine ganze Fehlerklasse
// an der Quelle. Unterstützt eine llama.cpp-Version das Pattern nicht, greift
// die Format-Kaskade in generatePack() (json_object → none) plus Validator.
const idStr = { type: 'string', pattern: '^[a-z][a-z0-9_]{1,40}$' };
const i18n = {
  type: 'object',
  properties: { de: { type: 'string' }, en: { type: 'string' } },
  required: ['de'],
};
const advance = {
  type: 'object',
  properties: { resources: numberMap, buildings: numberMap, population: { type: 'number' } },
};

/**
 * @param {object} [opts]
 * @param {boolean} [opts.allowEpochs] Epochen-Feld überhaupt anbieten. Aus, wenn der
 *   Aufstieg noch fern ist — das Modell legte sonst reihenweise existierende Epochen
 *   erneut an (mit 16 Nennungen der häufigste Ablehnungsgrund überhaupt). Was nicht
 *   im Schema steht, kann die Grammatik nicht erzeugen.
 * @param {number} [opts.nextOrder] Einzig zulässige order einer neuen Epoche.
 */
export function llmPackSchema({ allowEpochs = true, nextOrder } = {}) {
  const schema = {
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
            id: idStr,
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
            id: idStr,
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
                    shape: { enum: BUILDING_SHAPES },
                    accent: { type: 'string' },
                    wall: { type: 'string' },
                    roof: { type: 'string' },
                  },
                },
                military: {
                  type: 'object',
                  properties: { defense: { type: 'number' } },
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
            id: idStr,
            // Genau EIN zulässiger Wert — so kann die Grammatik keine bereits
            // vergebene order mehr erzeugen.
            order: nextOrder != null ? { const: nextOrder } : { type: 'integer' },
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
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: idStr,
            name: i18n,
            description: i18n,
            icon: { type: 'string' },
            epoch: { type: 'string' },
            durationTicks: { type: 'integer' },
            modifiers: {
              type: 'object',
              properties: {
                production: numberMap,
                grant: numberMap,
              },
            },
          },
          required: ['id', 'name', 'durationTicks', 'modifiers'],
        },
      },
      epochAdvance: { type: 'object', additionalProperties: advance },
    },
    required: ['chronicle'],
  };
  if (!allowEpochs) {
    delete schema.properties.epochs;
    delete schema.properties.epochAdvance;
  }
  return schema;
}

/**
 * Ist ein Epochen-Aufstieg nah genug, um eine neue Epoche generieren zu lassen?
 * Nur dann wird das Feld überhaupt angeboten (siehe llmPackSchema).
 */
export function epochsWelcome(exportData) {
  const epochs = exportData?.allEpochs || [];
  if (!epochs.length) return true;
  const last = epochs.reduce((a, b) => (b.order > a.order ? b : a), epochs[0]);
  const cur = exportData?.epoch?.order ?? 0;
  // Die letzte Epoche ist erreicht → es gibt nichts mehr, worauf man aufsteigen könnte
  return cur >= last.order;
}

/** Nächste freie Epochen-order (die einzige, die ein Pack belegen darf). */
export function nextEpochOrder(exportData) {
  const epochs = exportData?.allEpochs || [];
  return epochs.reduce((m, e) => Math.max(m, e.order ?? 0), -1) + 1;
}

export function buildMessages(exportData, balance, opts = {}) {
  // Ist der Aufstieg fern, wird das Epochen-Thema komplett aus dem Prompt
  // genommen — passend zum Schema, das das Feld dann gar nicht erst anbietet.
  const allowEpochs = opts.allowEpochs ?? epochsWelcome(exportData);
  const nextOrder = opts.nextOrder ?? nextEpochOrder(exportData);
  const system = `Du bist der Content-Designer eines datengetriebenen Idle-Aufbauspiels (Stil: Anno).
Du erweiterst das Spiel jede Nacht um neue Inhalte, die zum aktuellen Spielstand passen.

Du antwortest AUSSCHLIESSLICH mit einem JSON-Objekt (Content-Pack) mit diesen optionalen Feldern:
- "chronicle": { "de": "..." } — PFLICHT: kurzer erzählerischer Tagesbericht (2-4 Sätze, Deutsch), der die neuen Inhalte narrativ einführt.
- "resources": Array neuer Ressourcen: { id, name:{de,en}, description:{de}, category (raw|processed|food|luxury|special), icon (1 Emoji, thematisch passend und möglichst EINDEUTIG — nicht dasselbe Emoji wie eine bereits existierende Ressource), epoch, baseValue }
- "buildings": Array neuer Gebäude: { id, name:{de,en}, description:{de}, category (production|storage|housing|civic), epoch, icon (1 Emoji), cost:{ressourceId:menge}, buildTimeTicks, workers, production:{inputs:{},outputs:{}}, storage:{ressourceId:kapazität} oder {"*":kapazität}, housing:{capacity}, requires:{epoch,buildings:{},resources:{},population}, placement:{terrain:["grass"|"sand"], adjacent:{"forest"|"rock"|"water"|"grass": anzahl 1-8}} }
  FREISCHALTUNG ("requires"): Damit gatest du ein Gebäude hinter Voraussetzungen — "requires.buildings":{"id":anzahl} verlangt, dass der Spieler diese Vorläufer-Gebäude zuerst errichtet (thematische Abfolge!), "requires.resources"/"requires.population"/"requires.epoch" analog. Nutze das, damit fortgeschrittene Anlagen erst nach ihrer plausiblen Vorstufe verfügbar werden (siehe Regel 13).
  Das Spiel hat eine Insel-Karte mit den Terrains grass, sand, forest, rock, water. "placement.terrain" = worauf gebaut wird (Standard: grass), "placement.adjacent" = welches Terrain angrenzen muss (z.B. Mine braucht rock, Fischer braucht water), "placement.size" = Grundfläche {w,h} in Feldern (1-4, Standard 1×1; Lager/Zivilbauten gern 2×1 oder 2×2). Setze IMMER ein glaubwürdiges placement passend zur Funktion des Gebäudes.
  GRAFIK ("meta.art"): Die Engine zeichnet Gebäude prozedural. Wähle mit "meta.art.shape" die passende Silhouette — erlaubt: house, farm, woodcutter, sawmill, gatherer, mine, quarry, smelter (Schmelze/Ofen, glüht), workshop, fishery, harbor (Steg/Kai), market, temple (Kuppel), tower, warehouse, fountain (Brunnen/Becken mit Fontäne). Wähle die Silhouette, die zur FUNKTION passt — ein Brunnen ist "fountain", kein "temple". (Ohne shape wird der Typ automatisch aus Funktion/Name erraten.) Für neue Zeitalter/Materialien kannst du das Aussehen anpassen: "meta.art.accent" = Signaturfarbe (Hex, z.B. "#c94f2a"), "meta.art.wall"/"meta.art.roof" = Wand-/Dachfarbe (Hex) für epochentypische Baustoffe.
  MILITÄR ("meta.military"): Das Spiel hat ein Kriegssystem (Soldaten, Raubzüge, Verteidigung). Du darfst epochentypische WEHRANLAGEN einführen (category "civic", z.B. Palisade → Steinmauer → Bastion): "meta.military.defense" = Verteidigungswert (10–15 × Epochen-Order, workers 0, shape "tower"). Selten einsetzen (höchstens 1 je Pack, nur wenn die Epoche noch keine hat).
${!allowEpochs ? `- (Neue EPOCHEN sind in diesem Pack NICHT vorgesehen — die Siedlung hat die letzte Epoche noch nicht erreicht. Lasse "epochs" und "epochAdvance" weg und konzentriere dich auf Gebäude, Ressourcen und Ereignisse.)
` : `- "epochs": Array mit maximal EINER neuen Epoche: { id, order (MUSS exakt ${nextOrder} sein), name:{de,en}, description:{de}, advance (oder null wenn vorerst final), modifiers, tier, needs }. Bei einer neuen Epoche sind PFLICHT:
    • "modifiers": { "productionMultiplier": (steigt je Epoche, z.B. +0.2 gegenüber der Vorepoche), "populationGrowth": (klein, z.B. 0.012–0.02) }
    • "tier": { "name": {de,en} } = wie die Bevölkerung dieser Stufe heißt (Steinzeit "Jäger & Sammler" → "Siedler" → "Bürger" → …).
    • "needs": { ressourceId: mengeProKopfProTick } = 1–3 Güter, welche die Bevölkerung dieser Ära zum Zufriedensein verlangt. KRITISCH: Der Wert skaliert PRO KOPF, die Produktion aber pro Gebäude — rechne die GESAMTE Vorkette in Arbeitern je Einheit/Tick durch (Gebäude-workers/outputRate + Vorprodukte)! Ein Gut mit tiefer Kette (z.B. Stahlwaren: Erz→Barren→Stahl→Ware ≈ 100 Arbeiter je Einheit/Tick) verträgt höchstens 0.001–0.002 pro Kopf; nur flache Ketten (1 Gebäude) vertragen 0.005–0.01. Faustregel: needWert × KettenArbeiterkosten ≤ 0.15 (max. 15 % der Bevölkerung arbeiten für EIN Bedürfnis). Zu hohe Werte werden automatisch gekappt. Führe für JEDES need-Gut auch einen Produzenten ein (in diesem Pack neu oder bereits existierend), sonst stagniert die Ära.`}
- "events": Array neuer Tages-Ereignisse (0-2 pro Pack): { id, name:{de,en}, description:{de}, icon (1 Emoji), epoch (ab welcher Epoche es auftreten kann), durationTicks (720=1h bis 17280=1Tag), modifiers:{ production:{ressourceId oder "*": faktor 0.8-1.2}, grant:{ressourceId: menge} } }. Ereignisse sind TEMPORÄR und harmlos — kleine Stimmungs-Momente („Sturm: Holz ×0.85 für 2h", „Erntefest: Nahrung ×1.15 + 60 Nahrung geschenkt"). Erfinde thematisch zur Epoche passende Ereignisse (Seuche/Komet/Messe/Streik/Sonnenwende …).
${allowEpochs ? `- "epochAdvance": { "<epochen-id>": {resources:{},buildings:{},population} } — Aufstiegsbedingung für eine existierende Epoche, die noch keine hat. PFLICHT, wenn du eine neue Epoche anlegst.` : ''}

HARTE REGELN:
1. IDs: englisch, lowercase snake_case (z.B. "copper_mine"). Niemals existierende IDs wiederverwenden.
2. Referenziere nur Ressourcen/Gebäude/Epochen, die im Spielstand existieren ODER die du im selben Pack neu anlegst.
3. Produktionsraten sind Mengen PRO TICK und klein (typisch 0.1 bis 1.0).
4. Balancing: Netto-Wertschöpfung pro Tick (Σ outputs×baseValue − Σ inputs×baseValue) darf höchstens workers × ${balance.workerValuePerTick} × ${balance.netValueSlack} × ${balance.epochValueGrowth}^epochenOrder betragen. Produktionsgebäude ohne Arbeiter sind verboten.
5. Neue Gebäude dürfen maximal ${Math.round((balance.maxIncreaseOverBest ?? 0.25) * 100)}% besser sein als das beste existierende Gebäude ihrer Epoche.
6. Baukosten müssen sich frühestens nach ${balance.minAmortizationTicks} Ticks amortisieren (cost-Wert ≥ ${balance.minAmortizationTicks} × Netto-Wert/Tick).
7. Maximal ${balance.maxNewResourcesPerPack ?? 3} Ressourcen, ${balance.maxNewBuildingsPerPack ?? 4} Gebäude, ${balance.maxNewEpochsPerPack ?? 1} Epoche pro Pack.
8. ${allowEpochs ? `Eine neue Epoche braucht order genau ${nextOrder}, einen "epochAdvance"-Eintrag für die bisherige letzte Epoche UND zwingend modifiers, tier und needs (mit passenden Produzenten für die need-Güter).` : `Lege KEINE neue Epoche an — "epochs"/"epochAdvance" gehören nicht in dieses Pack.`}
9. Baue sinnvolle Produktionsketten: neue Ressourcen brauchen Produzenten, verarbeitende Gebäude brauchen existierende Inputs. SELBST-CHECK vor der Ausgabe: Gehe jeden "inputs"-Eintrag JEDES neuen Gebäudes sowie jedes "needs"-Gut durch — für JEDE dieser Ressourcen MUSS es einen Produzenten geben (ein Gebäude mit dieser Ressource in "outputs"), entweder bereits im Spielstand oder als NEUES Gebäude in DIESEM Pack. Verbrauchst du z.B. "wool", dann liefere im selben Pack auch das Gebäude, das "wool" produziert (z.B. eine Schäferei). Gibt es keinen Produzenten, lasse das Gebäude/need WEG. Unerreichbare Inputs führen zur Ablehnung.
10. Beachte die "recentRejections" im Spielstand: wiederhole abgelehnte Fehler nicht.
11. VIELFALT & TERRAIN: Nutze das Terrain thematisch — Fischer/Häfen an "water" (placement.adjacent {water}), Minen/Steinbrüche an "rock", Förster/Jäger an "forest", Farmen/Gärten auf "grass". Variiere die Gebäude-Typen (unterschiedliche meta.art.shape statt immer "workshop").
12. WOHNEN & KOMFORT: Führe pro neuer Epoche mindestens ein besseres Wohngebäude ein (mehr housing.capacity als die Vorepoche) sowie 1-2 "luxury"-Güter (Komfortwaren), die als Epochen-"needs" die Zufriedenheit der höheren Bevölkerungsstufe tragen — mit passenden Produzenten.
13. THEMATISCHE KONTINUITÄT & PLAUSIBLE ABFOLGE: Ein fortgeschrittenes Gut darf nicht "aus dem Nichts" entstehen — es braucht eine glaubwürdige Vorstufe, die der Spieler vorher errichten muss. Modelliere das auf EINE dieser zwei Arten:
   (a) PRODUKTIONSKETTE — das Gut wird aus einem thematisch passenden Vorprodukt hergestellt. Beispiel: "Satellitendaten" entstehen NICHT direkt in einem Basisgebäude, sondern in einer Bodenstation, die den Rohstoff "Satellit" verbraucht; "Satellit" wiederum baut eine Raketenfabrik aus vorhandener "Elektronik" + "Treibstoff". Die inputs eines neuen Gebäudes sollen konzeptionell zum output passen (Erz→Metall→Werkzeug, nicht Getreide→Mikrochip).
   (b) FREISCHALT-GATE via "requires.buildings" — das erzeugende Gebäude verlangt zuerst seinen thematischen Vorläufer. Beispiel: bodenstation → requires:{buildings:{raketen_startplatz:1}}. So MUSS der Spieler die Rakete/den Startplatz tatsächlich bauen, bevor er Satellitendaten erntet.
   MASSVOLL bleiben: 1 nachvollziehbare Zwischenstufe genügt, kein tiefer Techbaum. Ziel ist Logik in der Abfolge (was setzt was voraus?), nicht Bürokratie. SELBST-CHECK: Würde ein Spieler bei diesem neuen Gut fragen „wo kommt das her, das habe ich doch nie aufgebaut?" — dann fehlt die Vorstufe.`;

  // Verbotsliste PROMINENT an den Anfang: die häufigste historische Ablehnung
  // war das erneute Anlegen existierender Epochen/IDs — tief in gaps[] vergraben
  // hat das Modell die Info übersehen. Kompakt + zuerst = stark gewichtet.
  const existing = [
    `VERBOTEN — diese IDs existieren bereits und dürfen NIEMALS neu angelegt werden:`,
    `- Epochen: ${(exportData.allEpochs || []).map((e) => `${e.id}(order ${e.order})`).join(', ') || '—'}`,
    `- Ressourcen: ${(exportData.resources || []).map((r) => r.id).join(', ') || '—'}`,
    `- Gebäude: ${(exportData.buildings || []).map((b) => b.id).join(', ') || '—'}`,
  ].join('\n');

  // D4: Themen-Rotation gegen Content-Monotonie — ohne Fokus erfindet ein kleines
  // Modell gern die x-te Werkstatt-Variante. Der Wochentag rotiert das Themenfeld;
  // dringende Wirtschaftslücken haben trotzdem Vorrang (steht im Prompt).
  const THEMES = [
    'Kultur & Gemeinwesen (Feste, Bildung, Denkmäler)',
    'Nahrung & Landwirtschaft (neue Nahrungsketten, Veredelung)',
    'Handwerk & Industrie (Werkstoffe, Verarbeitungsketten)',
    'Luxus & Handel (Komfortgüter, Marktleben)',
    'Infrastruktur & Logistik (Lager, Häfen, Versorgung)',
    'Militär & Verteidigung (epochengerechte Wehranlagen)',
    'Kuriosum & Wunder (Ungewöhnliches, Ereignisse, kleine Geschichten)',
  ];
  const focus = THEMES[new Date().getDay() % THEMES.length];

  // Kompaktes JSON (keine Einrückung) — spart ~30 % Tokens gegenüber null,1
  const user = `${existing}

FOKUS-THEMA heute: ${focus} — bevorzuge Inhalte aus diesem Themenfeld, SOFERN die Wirtschaft nichts Dringenderes braucht (gaps zuerst!).

Aktueller Siedlungs-Status (JSON):
${JSON.stringify(exportData)}

Analysiere die "gaps" und den Zustand der Wirtschaft. Erzeuge ein Content-Pack mit 1-3 neuen Gebäuden und 0-2 neuen Ressourcen, das die größten Lücken schließt und die nächste Spielphase vorbereitet. Achte auf THEMATISCHE KONTINUITÄT (Regel 13): baue an das an, was schon existiert, und gib jedem fortgeschrittenen Gut eine nachvollziehbare Vorstufe (Kette oder requires-Gate) — nichts soll entstehen, das der Spieler nie aufgebaut hat. Falls der Epochen-Aufstieg nah ist und die Folge-Epoche fehlt oder leer ist, fülle sie. Antworte nur mit dem JSON-Objekt.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function extractJSON(text) {
  const cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // Reasoning-Präambel
    .replace(/```(?:json)?/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('keine JSON-Struktur in der Antwort');
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (err) {
    // Häufige LLM-Kleinfehler reparieren statt die Nacht zu verlieren:
    // NBSP, rohe Steuerzeichen in Strings, trailing commas.
    const repaired = slice
      .replace(/\u00a0/g, ' ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(repaired); } catch { throw err; }
  }
}

// ── Kontext-Budgetierung ─────────────────────────────────────────────────────
// Der LLM-Server erzwingt sein eigenes n_ctx. Ein zu großes LLM_CTX führte dazu,
// dass max_tokens still auf den Rest gekappt wurde und ein Reasoning-Modell
// mitten im Denken auslief: finish_reason 'length', content leer, Nacht verloren
// (gemma4-12b liefert real 16384 statt der konfigurierten 32768). Deshalb: echtes
// n_ctx einmalig beim Server erfragen und das Ausgabebudget daraus ableiten.

const CTX_CACHE = new Map(); // model → n_ctx

/** Bewusst leicht pessimistische Schätzung (dt. Text + JSON ≈ 3,1 Zeichen/Token). */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3.1);
}

/** Prompt-Größe inkl. Rollenmarker des Chat-Templates. */
export function messagesTokens(messages) {
  return messages.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
}

/**
 * Ermittelt die tatsächliche Kontextgröße eines Modells: Ein absichtlich
 * überlanger Prompt wird von llama.cpp VOR der Inferenz abgelehnt und nennt
 * n_ctx im Fehlertext — exakt und ohne GPU-Kosten. Ergebnis je Modell gecacht;
 * scheitert die Abfrage, bleibt es beim konfigurierten LLM_CTX.
 */
export async function discoverContext(llm) {
  if (CTX_CACHE.has(llm.model)) return CTX_CACHE.get(llm.model);
  let ctx = llm.ctx;
  try {
    // ~3× das erwartete Fenster, gedeckelt — garantiert den Überlauf, bleibt aber klein genug
    const words = Math.min(Math.max(llm.ctx * 3, 60000), 200000);
    const res = await fetch(`${llm.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: 'user', content: 'Wort '.repeat(words) }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json().catch(() => ({}));
    const found = Number(data?.error?.n_ctx);
    if (Number.isFinite(found) && found > 0) ctx = found;
  } catch {
    // Server antwortet nicht wie erwartet → konfigurierter Wert muss reichen
  }
  CTX_CACHE.set(llm.model, ctx);
  return ctx;
}

export function _resetContextCache() { CTX_CACHE.clear(); } // für Tests

/**
 * Ein Chat-Completion-Aufruf mit hartem Kontext-Budget.
 * @param {object} opts
 * @param {number} [opts.minOutputTokens] Mindest-Ausgabebudget, sonst Fehler statt Fehlschlag-Nacht
 * @param {boolean} [opts.thinking] Reasoning zulassen (Standard: aus — siehe unten)
 */
export async function chatCompletion(llm, messages, responseFormat, opts = {}) {
  const ctx = await discoverContext(llm);
  const promptTokens = messagesTokens(messages);
  const reserve = 256; // Template-Overhead + Sicherheitsmarge
  const minOutput = opts.minOutputTokens ?? 512;
  const budget = ctx - promptTokens - reserve;
  if (budget < minOutput) {
    throw new Error(
      `Prompt zu groß für '${llm.model}': ~${promptTokens} von ${ctx} Kontext-Tokens belegt, ` +
        `nur ${budget} für die Antwort übrig (mindestens ${minOutput} nötig) — ` +
        `Export kürzen (AI_EXPORT_TOKEN_BUDGET) oder Modell mit größerem Kontext wählen (LLM_MODEL_NIGHTLY)`
    );
  }
  const maxTokens = Math.max(1, Math.min(llm.maxTokens || budget, budget));

  const body = {
    model: llm.model,
    messages,
    temperature: llm.temperature,
    max_tokens: maxTokens,
  };
  if (responseFormat) body.response_format = responseFormat;
  // Reasoning kostet hier nur Budget: Struktur erzwingt ohnehin die Grammatik,
  // und ein denkendes Modell verbrauchte regelmäßig das gesamte Fenster, bevor
  // das erste JSON-Zeichen kam. Abschaltbar über llm.thinking / LLM_THINKING.
  if (!(opts.thinking ?? llm.thinking)) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
  }

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
  let content = choice?.message?.content;
  // Denkt das Modell trotz enable_thinking=false, landet alles in reasoning_content.
  // Steckt dort brauchbares JSON, retten wir den Lauf daraus statt ihn zu verlieren.
  if (!content) content = choice?.message?.reasoning_content || '';
  if (!content) {
    if (choice?.finish_reason === 'length') {
      throw new Error(
        `Token-Budget erschöpft, bevor Content kam (max_tokens=${maxTokens}, ` +
          `Prompt ~${promptTokens} von ${ctx} Kontext-Tokens)`
      );
    }
    throw new Error('leere LLM-Antwort');
  }
  return content;
}

/**
 * E: Streaming-Variante (SSE des LLM-Servers konsumieren) — für den Advisor,
 * damit Antworten tokenweise im Panel erscheinen statt als 30-s-Blackbox.
 * <think>…</think>-Reasoning wird im Stream unterdrückt (Gemma-Modelle).
 * @param {(token: string) => void} onToken
 * @returns {Promise<string>} vollständiger (gefilterter) Text
 */
export async function chatCompletionStream(llm, messages, onToken, opts = {}) {
  const ctx = await discoverContext(llm);
  const promptTokens = messagesTokens(messages);
  const budget = ctx - promptTokens - 256;
  if (budget < (opts.minOutputTokens ?? 256)) {
    throw new Error(
      `Prompt zu groß für '${llm.model}': ~${promptTokens} von ${ctx} Kontext-Tokens belegt`
    );
  }
  const body = {
    model: llm.model,
    messages,
    temperature: llm.temperature,
    max_tokens: Math.max(1, Math.min(llm.maxTokens || budget, budget)),
    stream: true,
  };
  if (!(opts.thinking ?? llm.thinking)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  const res = await fetch(`${llm.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let thinking = false; // innerhalb eines <think>-Blocks → nicht weiterreichen
  let pending = ''; // Puffer gegen zerteilte <think>-Tags an Chunk-Grenzen
  const emit = (chunk) => {
    pending += chunk;
    // Tags können über Token-Grenzen zerfallen — nur bis zum letzten sicheren Punkt emittieren
    for (;;) {
      if (thinking) {
        const close = pending.indexOf('</think>');
        if (close === -1) { pending = pending.slice(-10); return; } // Rest verwerfen, Tail für Tag-Erkennung behalten
        pending = pending.slice(close + 8);
        thinking = false;
      } else {
        const open = pending.indexOf('<think>');
        if (open === -1) {
          // alles bis auf einen möglichen Tag-Anfang ausgeben
          const safe = Math.max(0, pending.length - 7);
          const out = pending.slice(0, safe);
          if (out) { full += out; onToken(out); }
          pending = pending.slice(safe);
          return;
        }
        const out = pending.slice(0, open);
        if (out) { full += out; onToken(out); }
        pending = pending.slice(open + 7);
        thinking = true;
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { if (!thinking && pending) { full += pending; onToken(pending); } return full.trim(); }
      try {
        const t = JSON.parse(data).choices?.[0]?.delta?.content;
        if (t) emit(t);
      } catch { /* halbe JSON-Zeile → nächster Chunk */ }
    }
  }
  if (!thinking && pending) { full += pending; onToken(pending); }
  return full.trim();
}

async function completeWithFormats(llm, messages, schemaOpts) {
  const schema = llmPackSchema(schemaOpts);
  const formats = [
    { name: 'json_schema', rf: { type: 'json_schema', json_schema: { name: 'content_pack', schema } } },
    { name: 'json_object+schema', rf: { type: 'json_object', schema } },
    { name: 'none', rf: null },
  ];
  let lastErr;
  for (const { name, rf } of formats) {
    try {
      // Ein Content-Pack braucht realistisch ~1500 Tokens; weniger Budget heißt
      // abgeschnittenes JSON — dann lieber sofort mit klarer Diagnose scheitern.
      const raw = await chatCompletion(llm, messages, rf, { minOutputTokens: 1500 });
      const pack = extractJSON(raw);
      pack.pack = { ...(pack.pack || {}), model: llm.model };
      return { pack, raw, formatUsed: name };
    } catch (err) {
      lastErr = err;
      // Ein zu großer Prompt trifft jedes Format gleich — die Kaskade würde nur
      // dreimal dieselbe Minute verbrennen. Sofort durchreichen.
      if (/Prompt zu groß/.test(err.message)) throw err;
      // Bei HTTP 4xx (Format nicht unterstützt) nächstes Format probieren,
      // bei Parse-Fehlern ebenfalls — strengere Validierung folgt ohnehin.
    }
  }
  throw new Error(`Generierung fehlgeschlagen: ${lastErr?.message}`);
}

/**
 * Erzeugt ein Content-Pack. Probiert strukturierte Ausgabeformate in absteigender
 * Strenge — je nach llama.cpp-Version wird json_schema oder json_object unterstützt.
 * @returns {{pack: object, raw: string, formatUsed: string}}
 */
export async function generatePack(exportData, llm, balance) {
  return completeWithFormats(llm, buildMessages(exportData, balance), schemaOptsFor(exportData));
}

/** Schema-Zuschnitt für den aktuellen Spielstand (Epochen-Gate + erzwungene order). */
function schemaOptsFor(exportData) {
  return { allowEpochs: epochsWelcome(exportData), nextOrder: nextEpochOrder(exportData) };
}

/**
 * Reparatur-Runde: Ein abgelehntes Pack wird mit der konkreten Fehlerliste
 * EINMAL ans LLM zurückgegeben. Konkrete Fehler korrigieren können auch kleine
 * Modelle zuverlässig — das rettet Nächte, die sonst komplett verloren wären.
 * @returns {{pack: object, raw: string, formatUsed: string}}
 */
export async function repairPack(exportData, llm, balance, previousRaw, reasons) {
  const messages = [
    ...buildMessages(exportData, balance),
    { role: 'assistant', content: String(previousRaw).slice(0, 24000) },
    {
      role: 'user',
      content: `Dein Content-Pack wurde bei der Prüfung ABGELEHNT. Konkrete Gründe:
${reasons.map((r) => `- ${r}`).join('\n')}

Korrigiere GENAU diese Punkte (verbotene/duplizierte IDs entfernen oder umbenennen, fehlende Produzenten im selben Pack ergänzen oder das betroffene Item weglassen, Zahlen in die erlaubten Grenzen bringen). Ändere sonst NICHTS. Antworte erneut NUR mit dem vollständigen, korrigierten JSON-Objekt.`,
    },
  ];
  return completeWithFormats(llm, messages, schemaOptsFor(exportData));
}
