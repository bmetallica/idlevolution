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
    // Nur noch Startwert/Fallback: das echte n_ctx wird beim Server erfragt
    // (discoverContext), weil ein zu hohes LLM_CTX still zu leeren Antworten führte.
    ctx: num(process.env.LLM_CTX, 32768),
    // Obergrenze der Ausgabe; das tatsächliche Budget ist zusätzlich durch
    // (n_ctx − Prompt) gedeckelt.
    maxTokens: num(process.env.LLM_MAX_TOKENS, 12288),
    temperature: num(process.env.LLM_TEMPERATURE, 0.7),
    // Ein Content-Pack ist überwiegend Zahlen unter harten Regeln — dort ist
    // hohe Temperatur nur Risiko (Ausreißer, die der Balancer wieder kappt).
    // Die erzählerische Chronik entsteht im selben Aufruf, deshalb nicht zu tief.
    temperatureNightly: num(process.env.LLM_TEMPERATURE_NIGHTLY, 0.45),
    // Reasoning ("<think>") kostet bei den lokalen Modellen das gesamte
    // Ausgabebudget, bevor JSON kommt. Standard: aus. LLM_THINKING=true reaktiviert es.
    thinking: process.env.LLM_THINKING === 'true',
    // Einbettungs-Modell für die Dubletten-Prüfung (läuft permanent mit)
    embedModel: process.env.LLM_MODEL_EMBED || 'nomic-embed-text',
  },

  // Schwelle der inhaltlichen Dubletten-Sperre (0 = aus). An 66 echten Gebäuden
  // kalibriert: funktionsgleiche, legitim verschiedene Paare bleiben unter 0.76,
  // echte Dubletten liegen bei 0.89 — siehe ai/similarity.js.
  aiDuplicateThreshold: num(process.env.AI_DUPLICATE_THRESHOLD, 0.8),

  // Nächtlicher Lauf: Wiederholversuche, falls der LLM-Server um 03:00 gerade
  // offline ist oder ein anderes Modell lädt. Ohne sie ist die Nacht verloren.
  aiRetries: num(process.env.AI_RETRIES, 3),
  aiRetryDelayMinutes: num(process.env.AI_RETRY_DELAY_MINUTES, 20),
  // Aufbewahrung von data/exports und data/rejected (Tage; 0 = nie löschen).
  aiArchiveKeepDays: num(process.env.AI_ARCHIVE_KEEP_DAYS, 30),

  // Token-Budget des nächtlichen Exports. Der Spielstand wächst unbegrenzt —
  // ohne Deckel frisst der Prompt irgendwann das ganze Kontextfenster.
  aiExportTokenBudget: num(process.env.AI_EXPORT_TOKEN_BUDGET, 6000),

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
