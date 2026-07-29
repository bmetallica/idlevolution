// Entrypoint des ai-worker-Containers: plant den nächtlichen Lauf per Cron.
import cron from 'node-cron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { runNightly } from './run-nightly.js';

if (!cron.validate(config.aiCron)) {
  console.error(`Ungültiger AI_CRON-Ausdruck: '${config.aiCron}'`);
  process.exit(1);
}

// C4: Heartbeat für den compose-Healthcheck — der Scheduler starb bisher lautlos
// (Cron-Prozess ohne Port). Alle 60 s ein Zeitstempel; der Healthcheck schlägt
// Alarm, wenn die Datei älter als 3 min ist.
const heartbeatFile = path.join(config.dataDir, 'ai-worker.heartbeat');
const beat = () => writeFile(heartbeatFile, String(Date.now())).catch(() => {});
beat();
setInterval(beat, 60000).unref?.();

console.log(`[scheduler] KI-Generierung geplant: '${config.aiCron}' → ${config.llm.baseUrl} (${config.llm.model})`);

/** Antwortet der LLM-Server überhaupt? Billiger Vorabcheck vor einem langen Lauf. */
async function llmReachable() {
  try {
    const res = await fetch(`${config.llm.baseUrl}/v1/models`, { signal: AbortSignal.timeout(15000) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Führt den Nachtlauf aus und wiederholt ihn bei Fehlschlag mit wachsendem
 * Abstand. Der Cron feuert nur EINMAL um 03:00 — ist der LLM-Server in genau
 * dem Moment offline oder lädt gerade ein anderes Modell, war die Nacht bisher
 * verloren, ohne dass der Watchdog etwas gemerkt hätte (der Prozess lebt ja).
 */
async function runWithRetries(label) {
  const attempts = Math.max(1, config.aiRetries);
  for (let i = 1; i <= attempts; i++) {
    if (!(await llmReachable())) {
      console.warn(`[scheduler] LLM-Server ${config.llm.baseUrl} antwortet nicht (Versuch ${i}/${attempts})`);
    } else {
      try {
        await runNightly();
        if (i > 1) console.log(`[scheduler] ${label} im ${i}. Versuch erfolgreich`);
        return;
      } catch (err) {
        console.error(`[scheduler] ${label} fehlgeschlagen (Versuch ${i}/${attempts}): ${err.message}`);
      }
    }
    if (i < attempts) {
      const waitMin = config.aiRetryDelayMinutes * i; // 20, 40, 60 … min
      console.log(`[scheduler] nächster Versuch in ${waitMin} min`);
      await sleep(waitMin * 60000);
    }
  }
  console.error(`[scheduler] ${label} endgültig aufgegeben nach ${attempts} Versuchen`);
}

let running = false;
/** Verhindert Überlappung, wenn ein Lauf mit Wiederholungen über den nächsten Cron hinausläuft. */
async function trigger(label) {
  if (running) return console.warn(`[scheduler] ${label} übersprungen — vorheriger Lauf läuft noch`);
  running = true;
  try { await runWithRetries(label); } finally { running = false; }
}

cron.schedule(config.aiCron, () => { trigger('Lauf'); });

if (config.aiRunOnStart) {
  console.log('[scheduler] AI_RUN_ON_START=true → starte sofort einen Lauf');
  trigger('Startlauf');
}
