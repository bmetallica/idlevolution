// Entrypoint des ai-worker-Containers: plant den nächtlichen Lauf per Cron.
import cron from 'node-cron';
import { config } from '../config.js';
import { runNightly } from './run-nightly.js';

if (!cron.validate(config.aiCron)) {
  console.error(`Ungültiger AI_CRON-Ausdruck: '${config.aiCron}'`);
  process.exit(1);
}

console.log(`[scheduler] KI-Generierung geplant: '${config.aiCron}' → ${config.llm.baseUrl} (${config.llm.model})`);

cron.schedule(config.aiCron, () => {
  runNightly().catch((err) => console.error(`[scheduler] Lauf fehlgeschlagen: ${err.message}`));
});

if (config.aiRunOnStart) {
  console.log('[scheduler] AI_RUN_ON_START=true → starte sofort einen Lauf');
  runNightly().catch((err) => console.error(`[scheduler] Startlauf fehlgeschlagen: ${err.message}`));
}
