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

cron.schedule(config.aiCron, () => {
  runNightly().catch((err) => console.error(`[scheduler] Lauf fehlgeschlagen: ${err.message}`));
});

if (config.aiRunOnStart) {
  console.log('[scheduler] AI_RUN_ON_START=true → starte sofort einen Lauf');
  runNightly().catch((err) => console.error(`[scheduler] Startlauf fehlgeschlagen: ${err.message}`));
}
