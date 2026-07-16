// Zentrale Konfiguration — ausschließlich aus Umgebungsvariablen (12-Factor).
// Spielinhalte und Balancing-Grenzen liegen NICHT hier, sondern als Daten in DATA_DIR.

const num = (v, fallback) => (v !== undefined && v !== '' ? Number(v) : fallback);

export const config = {
  port: num(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || '',
  dataDir: process.env.DATA_DIR || '/data',

  tickSeconds: num(process.env.TICK_SECONDS, 5),
  persistEveryTicks: num(process.env.PERSIST_EVERY_TICKS, 12),
  offlineCapHours: num(process.env.OFFLINE_CAP_HOURS, 24),

  aiImportToken: process.env.AI_IMPORT_TOKEN || '',
  // E: Optionaler Schreibschutz der Spiel-API (Standard: aus, LAN bleibt frei).
  // Gesetzt → alle schreibenden /api-Aufrufe brauchen den Header x-game-token.
  gameToken: process.env.GAME_TOKEN || '',

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'http://localhost:8080').replace(/\/$/, ''),
    model: process.env.LLM_MODEL || 'gemma4-12b',
    // D4: Modell-Routing pro Rolle — llama-swap kann mehrere Modelle hosten.
    // Nightly = groß/Qualität (Latenz egal), Chat = klein/schnell (Advisor, Strategist).
    // Ohne die Env-Variablen bleibt alles beim Standard-Modell.
    modelNightly: process.env.LLM_MODEL_NIGHTLY || process.env.LLM_MODEL || 'gemma4-12b',
    modelChat: process.env.LLM_MODEL_CHAT || process.env.LLM_MODEL || 'gemma4-12b',
    ctx: num(process.env.LLM_CTX, 32768),
    // Großzügig: Reasoning-Modelle (z.B. Gemma 4) verbrauchen viele Tokens fürs Denken,
    // bevor der eigentliche JSON-Content kommt.
    maxTokens: num(process.env.LLM_MAX_TOKENS, 12288),
    temperature: num(process.env.LLM_TEMPERATURE, 0.7),
  },

  // Online-Modus (Multiplayer über GitHub, docs/roadmap-multiplayer.md).
  // Die Client-ID ist öffentlich — der Device Flow braucht kein Secret.
  online: {
    clientId: process.env.ONLINE_CLIENT_ID || 'Ov23lih2yPEXcAEKwEc3',
    repo: process.env.ONLINE_REPO || 'bmetallica/idlevolution-online',
  },

  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  aiCron: process.env.AI_CRON || '0 3 * * *',
  aiRunOnStart: process.env.AI_RUN_ON_START === 'true',
};
