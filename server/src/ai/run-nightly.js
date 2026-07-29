// Nightly-Lauf des ai-workers: Export holen → Pack generieren → Import einreichen.
// Läuft in einem eigenen Container und spricht mit der App ausschließlich über
// die Token-geschützte HTTP-API (dort passieren Validierung, Balancing, Hot-Reload).

import { config } from '../config.js';
import { generatePack, repairPack } from './generator.js';
import { pruneArchives } from './retention.js';
import { generateEvents } from './eventgen.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${config.aiImportToken}`,
};

// Routen, hinter denen ein LLM-Aufruf steckt, brauchen deutlich mehr Zeit als
// reine Spiel-API-Routen: 120 s reichten für /api/quests/generate nicht (das
// Modell braucht auf der lokalen GPU regelmäßig 2–4 min) — die Tagesziele
// fielen dadurch still aus.
const LLM_ROUTES = /^\/api\/(quests\/generate|players\/plan|assist)/;

async function api(method, route, body) {
  const timeout = LLM_ROUTES.test(route) ? 900000 : 120000;
  const res = await fetch(`${config.appUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
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

  // D4: Modell-Routing — die Nacht-Generierung darf das große Qualitäts-Modell nutzen.
  // Temperatur bewusst niedriger als im Chat: Zahlen unter harten Regeln.
  const nightlyLlm = {
    ...config.llm,
    model: config.llm.modelNightly || config.llm.model,
    temperature: config.llm.temperatureNightly ?? config.llm.temperature,
  };

  // Die Content-Generierung ist nur EIN Teil der Nacht. Schlug sie fehl, brach
  // bisher der gesamte Lauf ab — KI-Planung, Tagesziele, Kriegs-Auflösung und
  // Online-Sync fielen tagelang stillschweigend mit aus. Jetzt wird der Fehler
  // festgehalten und der Rest der Nacht läuft trotzdem.
  let result = { status: 'error' };
  let generated;
  try {
    generated = await generatePack(exportData, nightlyLlm, balance);
    log.info?.(`[nightly] LLM-Antwort erhalten (Format: ${generated.formatUsed})`);
  } catch (err) {
    log.error?.(`[nightly] LLM-Generierung fehlgeschlagen: ${err.message}`);
    await api('POST', '/api/ai/runs', { status: 'error', export: exportData, error: err.message }).catch(() => {});
    result = { status: 'error', error: err.message };
  }

  // Ereignisse in eigenem Mini-Aufruf nachreichen (updates.md 3.2): im großen
  // Pack standen sie am Ende und fielen faktisch immer weg.
  if (generated && !generated.pack.events?.length) {
    try {
      const events = await generateEvents(exportData, nightlyLlm);
      if (events.length) {
        generated.pack.events = events;
        log.info?.(`[nightly] ${events.length} Ereignis(se) ergänzt`);
      }
    } catch (err) {
      log.warn?.(`[nightly] Ereignis-Generierung übersprungen: ${err.message}`);
    }
  }

  if (generated) {
    result = await api('POST', '/api/ai/import', {
      pack: generated.pack,
      run: { export: exportData, rawResponse: generated.raw, model: nightlyLlm.model },
    });

    // Reparatur-Runde: Bei kompletter Ablehnung bekommt das LLM die konkreten
    // Fehler EINMAL zurück — konkrete Fehler korrigieren rettet die Nacht.
    if (result.status === 'rejected' && Array.isArray(result.rejected) && result.rejected.length) {
      const reasons = result.rejected.map((r) => r.reason || String(r)).slice(0, 12);
      log.info?.(`[nightly] Pack abgelehnt (${reasons.length} Gründe) → Reparatur-Runde…`);
      try {
        const fixed = await repairPack(exportData, nightlyLlm, balance, generated.raw, reasons);
        result = await api('POST', '/api/ai/import', {
          pack: fixed.pack,
          run: { export: exportData, rawResponse: fixed.raw, model: nightlyLlm.model, repaired: true },
        });
        log.info?.(`[nightly] Reparatur-Ergebnis: ${result.status}`);
      } catch (err) {
        log.warn?.(`[nightly] Reparatur-Runde fehlgeschlagen: ${err.message}`);
      }
    }
  }

  // Nach der Content-Generierung: KI-Spieler ihre Tagesstrategie neu planen lassen (Stufe 2)
  try {
    const pl = await api('POST', '/api/players/plan', {});
    if (pl?.planning) log.info?.(`[nightly] ${pl.planning} KI-Spieler neu geplant`);
  } catch (err) {
    log.warn?.(`[nightly] KI-Planung übersprungen: ${err.message}`);
  }

  // E1: Tagesziele für den menschlichen Spieler generieren (LLM → mechanischer Fallback)
  try {
    const qs = await api('POST', '/api/quests/generate', {});
    if (qs?.count) log.info?.(`[nightly] ${qs.count} Tagesziele generiert (${qs.source})`);
  } catch (err) {
    log.warn?.(`[nightly] Tagesziele übersprungen: ${err.message}`);
  }

  // Kriegssystem (Stufe 6): erklärte Schlachten im Tagesrhythmus auflösen
  try {
    const war = await api('POST', '/api/war/resolve', {});
    if (war?.battles) log.info?.(`[nightly] ${war.battles} Kriegs-Ereignis(se): ${war.reports?.join(' | ')}`);
  } catch (err) {
    log.warn?.(`[nightly] Kriegs-Auflösung übersprungen: ${err.message}`);
  }

  // Online-Modus (Multiplayer M1): Insel nächtlich veröffentlichen — nur wenn
  // der Spieler verbunden ist und der Freigabe zugestimmt hat (sonst 400).
  try {
    const pub = await api('POST', '/api/online/publish', {});
    if (pub?.ok) log.info?.(`[nightly] Insel online veröffentlicht (${pub.instances} Gebäude)`);
  } catch (err) {
    log.info?.(`[nightly] Online-Veröffentlichung übersprungen: ${err.message}`);
  }

  // Online-Modus (M2): fremde Inseln nachziehen (tokenlos, auch ohne Login sinnvoll)
  try {
    const sync = await api('POST', '/api/online/sync', {});
    if (sync?.ok) log.info?.(`[nightly] Online-Sync: ${sync.islands.filter((i) => i.ok).length} Nachbar-Insel(n)`);
  } catch (err) {
    log.info?.(`[nightly] Online-Sync übersprungen: ${err.message}`);
  }

  // Archive beschneiden (data/exports, data/rejected) — wachsen sonst unbegrenzt
  try {
    await pruneArchives(config.dataDir, config.aiArchiveKeepDays, log);
  } catch (err) {
    log.warn?.(`[nightly] Archiv-Aufräumen übersprungen: ${err.message}`);
  }

  // C4+: Ergebnis-Marke für den Watchdog. Der Heartbeat beweist nur, dass der
  // Prozess lebt — genau das war in allen fünf Ausfallnächten der Fall. Diese
  // Datei wird nur bei tatsächlich angekommenem Inhalt aktualisiert.
  if (generated && result.status !== 'rejected') {
    await writeFile(
      path.join(config.dataDir, 'ai-worker.lastcontent'),
      JSON.stringify({ at: new Date().toISOString(), status: result.status, packId: result.packId })
    ).catch(() => {});
  }

  if (!generated) {
    // Der Fehlschlag steht bereits als 'error'-Lauf in ai_runs (oben) — der
    // Client macht daraus einen sichtbaren Chronik-Eintrag. Alle übrigen
    // Nacht-Aufgaben sind gelaufen; jetzt darf der Fehler nach oben, damit der
    // Scheduler ihn protokolliert.
    throw new Error(`Content-Generierung fehlgeschlagen: ${result.error}`);
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
