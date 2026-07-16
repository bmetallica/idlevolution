// C3: Balance-Diagnose als dauerhaftes Werkzeug (npm run balance:report).
// Prüft die Invarianten, deren Verletzung die Todesspirale ausgelöst hat:
//   1. productionMultiplier-Kette (MONOTONIE über die Epochen)
//   2. Ketten-Arbeiterkosten aller Epochen-Bedürfnisse (Budget ≤ 15 % je Gut)
//   3. Güter ohne Produzent/Verbraucher (Soft-Lock-Kandidaten)
// Aufruf: DATA_DIR=../data node scripts/balance-report.js  (oder npm run balance:report)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, epochsInOrder } from '../src/content/loader.js';
import { chainWorkerCost, maxAffordableNeed, NEED_BUDGET_SHARE } from '../src/content/needs.js';

const dataDir = process.env.DATA_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const silent = { warn: (m) => console.warn(`  ⚠ ${m}`), info() {} };
const registry = await loadRegistry(dataDir, silent, { includeGenerated: true });
const defs = [...registry.buildings.values()];
const epochs = epochsInOrder(registry);
const REF_POP = Number(process.env.REF_POP || 500); // Referenz-Bevölkerung für %-Angaben

let problems = 0;
const flag = (msg) => { problems++; console.log(`  🔴 ${msg}`); };

console.log(`\n═══ Balance-Report (${new Date().toISOString().slice(0, 16)}) ═══`);
console.log(`Registry: ${epochs.length} Epochen, ${registry.buildings.size} Gebäude, ${registry.resources.size} Ressourcen\n`);

// ── 1) Multiplikator-Kette ──
console.log('── productionMultiplier-Kette (muss monoton steigen) ──');
let prevMult = 0;
for (const e of epochs) {
  const m = e.modifiers?.productionMultiplier ?? 1;
  const mark = m < prevMult ? ' 🔴 REGRESSION!' : '';
  if (m < prevMult) problems++;
  console.log(`  ${String(e.order).padStart(2)} ${e.id.padEnd(24)} ×${m}${mark}`);
  prevMult = Math.max(prevMult, m);
}

// ── 2) Bedürfnis-Kettenkosten ──
console.log(`\n── Epochen-Bedürfnisse (Budget: ≤ ${NEED_BUDGET_SHARE * 100} % der Bevölkerung je Gut, Referenz ${REF_POP} Ew.) ──`);
for (const e of epochs) {
  const needs = Object.entries(e.needs || {});
  if (!needs.length) { console.log(`  ${e.id}: (keine Bedürfnisse)`); continue; }
  for (const [rid, perPop] of needs) {
    const cost = chainWorkerCost(defs, rid);
    if (!Number.isFinite(cost)) { flag(`${e.id}: need '${rid}' hat KEINEN Produzenten (unerfüllbar)`); continue; }
    const workers = REF_POP * perPop * cost;
    const share = workers / REF_POP;
    const max = maxAffordableNeed(defs, rid);
    const mark = share > NEED_BUDGET_SHARE ? ' 🔴 ÜBER BUDGET' : share > NEED_BUDGET_SHARE * 0.8 ? ' 🟡 knapp' : ' ✓';
    if (share > NEED_BUDGET_SHARE) problems++;
    console.log(`  ${e.id}: ${rid} ${perPop}/Kopf × Kette ${cost.toFixed(1)} AK = ${Math.ceil(workers)} Arbeiter (${(share * 100).toFixed(1)} %${mark}, max ${max})`);
  }
}

// ── 3) Produzenten-/Verbraucher-Lücken ──
console.log('\n── Güter ohne Produzent/Verbraucher ──');
const producers = new Set(), consumers = new Set();
for (const b of defs) {
  for (const rid of Object.keys(b.production?.outputs || {})) producers.add(rid);
  for (const rid of Object.keys(b.production?.inputs || {})) consumers.add(rid);
}
const neededByEpochs = new Set(epochs.flatMap((e) => Object.keys(e.needs || {})));
let clean = true;
for (const r of registry.resources.values()) {
  if (!producers.has(r.id) && (consumers.has(r.id) || neededByEpochs.has(r.id))) {
    flag(`'${r.id}' wird verbraucht/gebraucht, aber NIEMAND produziert es`);
    clean = false;
  } else if (!producers.has(r.id) && r.category !== 'special') {
    console.log(`  🟡 '${r.id}' hat keinen Produzenten (wird aber auch nicht gebraucht)`);
    clean = false;
  }
}
if (clean) console.log('  ✓ alle Güter versorgt');

console.log(`\n═══ Ergebnis: ${problems === 0 ? '✓ keine kritischen Befunde' : `🔴 ${problems} kritische Befunde`} ═══\n`);
process.exit(problems === 0 ? 0 : 1);
