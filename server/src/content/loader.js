// Lädt alle Content-Packs (base + generated) und merged sie zu einer Registry.
// Die Registry ist die einzige Quelle für Spielinhalte zur Laufzeit — nichts ist hartcodiert.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePack } from './validator.js';

function emptyRegistry() {
  return {
    resources: new Map(),
    buildings: new Map(),
    epochs: new Map(),
    events: new Map(),
    packs: [], // Manifeste inkl. Chronik, in Ladereihenfolge
  };
}

async function packFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

export function mergePack(registry, pack, filePath) {
  for (const r of pack.resources || []) registry.resources.set(r.id, { ...r, _pack: pack.pack.id });
  for (const b of pack.buildings || []) registry.buildings.set(b.id, { ...b, _pack: pack.pack.id });
  for (const e of pack.epochs || []) registry.epochs.set(e.id, { ...e, _pack: pack.pack.id });
  for (const ev of pack.events || []) registry.events.set(ev.id, { ...ev, _pack: pack.pack.id });
  // Aufstiegsbedingung einer bisher finalen Epoche nachrüsten (macht neue Epochen erreichbar)
  for (const [eid, adv] of Object.entries(pack.epochAdvance || {})) {
    const epoch = registry.epochs.get(eid);
    if (epoch && epoch.advance == null) registry.epochs.set(eid, { ...epoch, advance: adv });
  }
  registry.packs.push({ ...pack.pack, chronicle: pack.chronicle || null, file: filePath });
}

/**
 * Lädt base- und generated-Packs aus dataDir/content.
 * Ungültige Packs werden übersprungen (Warnung), das Spiel startet mit dem Rest.
 */
export async function loadRegistry(dataDir, log = console, opts = {}) {
  const registry = emptyRegistry();
  const dirs = [path.join(dataDir, 'content', 'base')];
  // generierte KI-Packs standardmäßig mitladen; Tests laden nur base (deterministisch)
  if (opts.includeGenerated !== false) dirs.push(path.join(dataDir, 'content', 'generated'));
  for (const dir of dirs) {
    // Batch-Laden: Packs desselben Verzeichnisses dürfen sich gegenseitig
    // referenzieren (z.B. base: Epochen ↔ Ressourcen ↔ Gebäude über drei Dateien).
    const batch = [];
    for (const file of await packFiles(dir)) {
      try {
        batch.push({ file, pack: JSON.parse(await readFile(file, 'utf8')) });
      } catch (err) {
        log.warn?.(`Pack nicht lesbar (${file}): ${err.message}`);
      }
    }
    for (const { file, pack } of batch) {
      const siblings = batch.filter((b) => b.file !== file).map((b) => b.pack);
      const v = validatePack(pack, registry, siblings);
      if (!v.ok) {
        log.warn?.(`Pack übersprungen (${file}): ${v.errors.join('; ')}`);
        continue;
      }
      mergePack(registry, pack, file);
    }
  }
  return registry;
}

/** Epochen sortiert nach order. */
export function epochsInOrder(registry) {
  return [...registry.epochs.values()].sort((a, b) => a.order - b.order);
}

/** Tiefe Kopie der Registry (für Sandbox-Simulationen des Importers). */
export function cloneRegistry(registry) {
  const clone = emptyRegistry();
  for (const [k, v] of registry.resources) clone.resources.set(k, structuredClone(v));
  for (const [k, v] of registry.buildings) clone.buildings.set(k, structuredClone(v));
  for (const [k, v] of registry.epochs) clone.epochs.set(k, structuredClone(v));
  for (const [k, v] of registry.events) clone.events.set(k, structuredClone(v));
  clone.packs = structuredClone(registry.packs);
  return clone;
}

/** Registry als plain JSON fürs Frontend / den KI-Export. */
export function registryToJSON(registry) {
  return {
    resources: [...registry.resources.values()],
    buildings: [...registry.buildings.values()],
    epochs: epochsInOrder(registry),
    events: [...registry.events.values()],
    packs: registry.packs.map(({ file, ...p }) => p),
  };
}

/**
 * Hält die aktive Registry und erlaubt Hot-Reload nach KI-Import.
 * Alle Konsumenten greifen über holder.registry zu.
 */
export function createRegistryHolder(dataDir, log = console) {
  const holder = {
    registry: emptyRegistry(),
    async reload() {
      holder.registry = await loadRegistry(dataDir, log);
      log.info?.(
        `Content geladen: ${holder.registry.resources.size} Ressourcen, ` +
          `${holder.registry.buildings.size} Gebäude, ${holder.registry.epochs.size} Epochen, ` +
          `${holder.registry.packs.length} Packs`
      );
      return holder.registry;
    },
  };
  return holder;
}
