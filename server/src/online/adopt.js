// M4: Fremde Online-Inhalte explizit ins eigene Spiel übernehmen.
// Aus der (bereits validierten/gesäuberten) lokalen Kopie eines Nachbarn wird
// ein normales Content-Pack unter data/content/generated/ — es lädt wie ein
// nächtliches KI-Pack und ist über die bestehende Pack-Mechanik deaktivierbar
// (Instanzen werden dabei sauber entfernt).

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadNeighbor } from './sync.js';

/**
 * Fremde Epochen werden NICHT übernommen (sie hätten keine Progression) —
 * Gebäude werden stattdessen auf die eigene Epoche mit gleicher bzw.
 * nächstkleinerer Ordnung gemappt.
 */
function epochRemapper(registry, foreignEpochs) {
  const own = [...registry.epochs.values()].sort((a, b) => a.order - b.order);
  const foreignOrder = Object.fromEntries((foreignEpochs || []).map((e) => [e.id, e.order]));
  return (eid) => {
    if (!eid || registry.epochs.has(eid)) return eid; // Basis-Epoche oder schon bekannt
    const o = foreignOrder[eid] ?? 0;
    const fit = [...own].reverse().find((e) => e.order <= o) || own[0];
    return fit.id;
  };
}

/** Übernimmt die Packs eines Nachbarn. @returns {buildings, resources, packId} */
export async function adoptPack(ctx, owner) {
  const { packs } = await loadNeighbor(ctx, owner);
  if (!packs.buildings?.length && !packs.resources?.length) throw new Error(`${owner} hat keine übernehmbaren Inhalte`);

  const registry = ctx.registryHolder.registry;
  const remap = epochRemapper(registry, packs.epochs);
  const firstEpoch = [...registry.epochs.values()].sort((a, b) => a.order - b.order)[0]?.id;
  const buildings = packs.buildings.map((b) => ({
    ...b,
    epoch: remap(b.epoch) || firstEpoch,
    buildTimeTicks: b.buildTimeTicks ?? 20,
  }));
  const resources = (packs.resources || []).map((r) => ({
    ...r,
    epoch: remap(r.epoch) || firstEpoch, // Pack-Schema verlangt eine Epoche
    baseValue: r.baseValue ?? 1,
  }));

  const packId = `online-${owner.toLowerCase()}`;
  const pack = {
    schemaVersion: 1,
    pack: { id: packId, source: 'ai', createdAt: new Date().toISOString(), origin: `github:${owner}` },
    chronicle: { de: `Über den Online-Modus von ${owner} übernommen — Baupläne aus einer fremden Welt.` },
    resources,
    buildings,
    epochs: [], // bewusst nicht: fremde Epochen haben hier keine Progression
  };

  const file = path.join(ctx.config.dataDir, 'content', 'generated', `${packId}.json`);
  await writeFile(file, JSON.stringify(pack, null, 1));
  await ctx.registryHolder.reload();
  return { packId, buildings: buildings.length, resources: pack.resources.length };
}
