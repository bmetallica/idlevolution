// Nightly-Lauf des ai-workers: Export holen → Pack generieren → Import einreichen.
// Läuft in einem eigenen Container und spricht mit der App ausschließlich über
// die Token-geschützte HTTP-API (dort passieren Validierung, Balancing, Hot-Reload).

import { config } from '../config.js';
import { generatePack } from './generator.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${config.aiImportToken}`,
};

async function api(method, route, body) {
  const res = await fetch(`${config.appUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 422) throw new Error(`${route} → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function runNightly(log = console) {
  log.info?.('[nightly] Starte Content-Generierung…');
  let exportData;
  try {
    exportData = await api('GET', '/api/ai/export');
    log.info?.(`[nightly] Export: Epoche ${exportData.epoch?.id}, ${exportData.gaps?.length ?? 0} Lücken erkannt`);
  } catch (err) {
    log.error?.(`[nightly] Export fehlgeschlagen: ${err.message}`);
    throw err;
  }

  const balance = JSON.parse(
    await readFile(path.join(config.dataDir, 'balance.config.json'), 'utf8')
  ).balance;

  let generated;
  try {
    generated = await generatePack(exportData, config.llm, balance);
    log.info?.(`[nightly] LLM-Antwort erhalten (Format: ${generated.formatUsed})`);
  } catch (err) {
    log.error?.(`[nightly] LLM-Generierung fehlgeschlagen: ${err.message}`);
    await api('POST', '/api/ai/runs', { status: 'error', export: exportData, error: err.message }).catch(() => {});
    throw err;
  }

  const result = await api('POST', '/api/ai/import', {
    pack: generated.pack,
    run: { export: exportData, rawResponse: generated.raw, model: config.llm.model },
  });

  // Nach der Content-Generierung: KI-Spieler ihre Tagesstrategie neu planen lassen (Stufe 2)
  try {
    const pl = await api('POST', '/api/players/plan', {});
    if (pl?.planning) log.info?.(`[nightly] ${pl.planning} KI-Spieler neu geplant`);
  } catch (err) {
    log.warn?.(`[nightly] KI-Planung übersprungen: ${err.message}`);
  }

  if (result.status === 'rejected') {
    log.warn?.(`[nightly] Pack abgelehnt: ${JSON.stringify(result.rejected).slice(0, 500)}`);
  } else {
    log.info?.(
      `[nightly] Import ${result.status}: +${result.accepted?.buildings?.length ?? 0} Gebäude, ` +
        `+${result.accepted?.resources?.length ?? 0} Ressourcen, +${result.accepted?.epochs?.length ?? 0} Epochen ` +
        `(${result.rejected?.length ?? 0} Items abgelehnt)`
    );
  }
  return result;
}

// Direktaufruf: node src/ai/run-nightly.js
if (process.argv[1] && process.argv[1].endsWith('run-nightly.js')) {
  runNightly()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
