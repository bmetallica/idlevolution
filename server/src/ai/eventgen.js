// updates.md 3.2 — Ereignisse in eigenem, sehr kurzem Aufruf.
// Im großen Nacht-Pack stand "events" am Ende einer langen Feldliste und fiel
// faktisch immer weg (in den letzten Packs kam kein einziges Ereignis), obwohl
// das System vollständig implementiert ist. Ein eigener Mini-Aufruf mit engem
// Schema kostet wenige hundert Tokens und liefert zuverlässig.

import { chatCompletion, extractJSON } from './generator.js';

const SYSTEM = `Du erfindest TAGES-EREIGNISSE für ein deutsches Aufbau-Idle-Spiel (Stil Anno).
Ereignisse sind temporär, harmlos und stimmungsvoll — kleine Momente, keine Katastrophen.
Antworte NUR mit JSON:
{"events":[{"id":"…","name":{"de":"…"},"description":{"de":"…"},"icon":"🌧️","durationTicks":1440,"modifiers":{"production":{"<ressourceId>":0.9},"grant":{"<ressourceId>":40}}}]}
Regeln:
- id: englisch, lowercase snake_case, NICHT aus der Liste "vergeben".
- Nutze in "production"/"grant" NUR Ressourcen-IDs aus "ressourcen" (oder "*" für alle).
- production-Faktoren zwischen 0.8 und 1.2, grant-Mengen klein (10–80).
- durationTicks zwischen 720 (1 h) und 17280 (1 Tag).
- 1 Emoji als icon, deutscher Name + ein Satz Beschreibung.
- Passe Thema und Ton zur genannten Epoche an (Sturm, Erntefest, Messe, Sonnenwende, Streik, Komet …).`;

/** Schlankes Schema — die Grammatik erzwingt die Struktur, der Validator den Rest. */
export function eventSchema() {
  return {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,40}$' },
            name: { type: 'object', properties: { de: { type: 'string' } }, required: ['de'] },
            description: { type: 'object', properties: { de: { type: 'string' } }, required: ['de'] },
            icon: { type: 'string' },
            epoch: { type: 'string' },
            durationTicks: { type: 'integer' },
            modifiers: {
              type: 'object',
              properties: {
                production: { type: 'object', additionalProperties: { type: 'number' } },
                grant: { type: 'object', additionalProperties: { type: 'number' } },
              },
            },
          },
          required: ['id', 'name', 'durationTicks', 'modifiers'],
        },
      },
    },
    required: ['events'],
  };
}

/**
 * Erzeugt 1–2 Ereignis-Vorschläge. Roh — Validierung/Balancing macht der Importer.
 * @returns {Promise<object[]>}
 */
export async function generateEvents(exportData, llm, count = 2) {
  const epoch = exportData?.epoch;
  const taken = (exportData?.events || []).map((e) => e.id);
  // Bewusst winziger Kontext: nur was für ein Ereignis nötig ist
  const data = {
    epoche: epoch?.name || epoch?.id,
    ressourcen: (exportData?.resources || []).slice(0, 24).map((r) => r.id),
    vergeben: taken,
  };
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Spieldaten (JSON):\n${JSON.stringify(data)}\n\nErfinde genau ${count} zur Epoche passende Ereignisse.`,
    },
  ];
  const raw = await chatCompletion(
    llm,
    messages,
    { type: 'json_schema', json_schema: { name: 'events', schema: eventSchema() } },
    { minOutputTokens: 400 }
  );
  const parsed = extractJSON(raw);
  return Array.isArray(parsed?.events) ? parsed.events.slice(0, count) : [];
}
