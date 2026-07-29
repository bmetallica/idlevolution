// Erlaubte Gebäude-Silhouetten. Einzige Quelle für LLM-Grammatik und Importer —
// vorher stand die Liste nur im Prompt-Fließtext und im Client (sprites.js),
// wodurch ungültige Werte still bis in die Content-Packs durchrutschten.
// Spiegelbild von ARCH_RULES in web/src/lib/sprites.js.
export const BUILDING_SHAPES = [
  'house', 'farm', 'woodcutter', 'sawmill', 'gatherer', 'mine', 'quarry',
  'smelter', 'workshop', 'fishery', 'harbor', 'market', 'temple', 'tower',
  'warehouse', 'fountain',
];

const SHAPES = new Set(BUILDING_SHAPES);

export const isKnownShape = (s) => typeof s === 'string' && SHAPES.has(s);
