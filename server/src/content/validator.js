// Struktur- und Referenzvalidierung für Content-Packs.
// Wird für menschliche Base-Packs UND KI-generierte Packs identisch verwendet.

import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schemas');
const load = (f) => JSON.parse(readFileSync(path.join(schemaDir, f), 'utf8'));

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
for (const f of ['resource.schema.json', 'building.schema.json', 'epoch.schema.json', 'event.schema.json']) {
  ajv.addSchema(load(f));
}
const validatePackSchema = ajv.compile(load('pack.schema.json'));

/**
 * Strukturprüfung via JSON-Schema.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateStructure(pack) {
  if (validatePackSchema(pack)) return { ok: true, errors: [] };
  const errors = (validatePackSchema.errors || []).map(
    (e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`
  );
  return { ok: false, errors };
}

/**
 * Referenzprüfung: alle IDs müssen in der Registry ODER im selben Pack existieren,
 * keine Kollisionen mit existierenden IDs, Epochen-Order eindeutig.
 * @param {object} pack - das zu prüfende Pack
 * @param {object} registry - gemergte Registry { resources: Map, buildings: Map, epochs: Map }
 * @param {object[]} siblings - weitere Packs desselben Lade-Batches (dürfen sich
 *   gegenseitig referenzieren, z.B. base-Dateien untereinander)
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReferences(pack, registry, siblings = []) {
  const errors = [];
  const newResources = new Map((pack.resources || []).map((r) => [r.id, r]));
  const newBuildings = new Map((pack.buildings || []).map((b) => [b.id, b]));
  const newEpochs = new Map((pack.epochs || []).map((e) => [e.id, e]));
  const sibResources = new Set(siblings.flatMap((p) => (p.resources || []).map((r) => r.id)));
  const sibBuildings = new Set(siblings.flatMap((p) => (p.buildings || []).map((b) => b.id)));
  const sibEpochs = new Set(siblings.flatMap((p) => (p.epochs || []).map((e) => e.id)));

  const resourceExists = (id) =>
    id === '*' || registry.resources.has(id) || newResources.has(id) || sibResources.has(id);
  const buildingExists = (id) => registry.buildings.has(id) || newBuildings.has(id) || sibBuildings.has(id);
  const epochExists = (id) => registry.epochs.has(id) || newEpochs.has(id) || sibEpochs.has(id);

  // ID-Kollisionen mit bestehendem Content und innerhalb des Packs
  const dupCheck = (items, map, type) => {
    const seen = new Set();
    for (const item of items || []) {
      if (map.has(item.id)) errors.push(`${type} '${item.id}' existiert bereits`);
      if (seen.has(item.id)) errors.push(`${type} '${item.id}' ist im Pack doppelt`);
      seen.add(item.id);
    }
  };
  dupCheck(pack.resources, registry.resources, 'Ressource');
  dupCheck(pack.buildings, registry.buildings, 'Gebäude');
  dupCheck(pack.epochs, registry.epochs, 'Epoche');

  for (const r of pack.resources || []) {
    if (!epochExists(r.epoch)) errors.push(`Ressource '${r.id}': Epoche '${r.epoch}' unbekannt`);
  }

  for (const b of pack.buildings || []) {
    if (!epochExists(b.epoch)) errors.push(`Gebäude '${b.id}': Epoche '${b.epoch}' unbekannt`);
    for (const rid of Object.keys(b.cost || {})) {
      if (!resourceExists(rid)) errors.push(`Gebäude '${b.id}': Kosten-Ressource '${rid}' unbekannt`);
    }
    for (const rid of Object.keys(b.production?.inputs || {})) {
      if (!resourceExists(rid)) errors.push(`Gebäude '${b.id}': Input-Ressource '${rid}' unbekannt`);
    }
    for (const rid of Object.keys(b.production?.outputs || {})) {
      if (!resourceExists(rid)) errors.push(`Gebäude '${b.id}': Output-Ressource '${rid}' unbekannt`);
    }
    for (const rid of Object.keys(b.storage || {})) {
      if (!resourceExists(rid)) errors.push(`Gebäude '${b.id}': Lager-Ressource '${rid}' unbekannt`);
    }
    if (b.requires) {
      if (b.requires.epoch && !epochExists(b.requires.epoch))
        errors.push(`Gebäude '${b.id}': requires.epoch '${b.requires.epoch}' unbekannt`);
      for (const bid of Object.keys(b.requires.buildings || {})) {
        if (!buildingExists(bid)) errors.push(`Gebäude '${b.id}': requires-Gebäude '${bid}' unbekannt`);
      }
      for (const rid of Object.keys(b.requires.resources || {})) {
        if (!resourceExists(rid)) errors.push(`Gebäude '${b.id}': requires-Ressource '${rid}' unbekannt`);
      }
    }
  }

  const usedOrders = new Set([...registry.epochs.values()].map((e) => e.order));
  for (const e of pack.epochs || []) {
    if (usedOrders.has(e.order)) errors.push(`Epoche '${e.id}': order ${e.order} ist bereits vergeben`);
    usedOrders.add(e.order);
    if (e.advance) {
      for (const rid of Object.keys(e.advance.resources || {})) {
        if (!resourceExists(rid)) errors.push(`Epoche '${e.id}': advance-Ressource '${rid}' unbekannt`);
      }
      for (const bid of Object.keys(e.advance.buildings || {})) {
        if (!buildingExists(bid)) errors.push(`Epoche '${e.id}': advance-Gebäude '${bid}' unbekannt`);
      }
    }
    // Erreichbarkeit: die Vorgänger-Epoche muss existieren und eine advance-Bedingung
    // haben (vorhanden oder per epochAdvance in diesem Pack nachgeliefert).
    if (e.order > 0) {
      const prev =
        [...registry.epochs.values()].find((p) => p.order === e.order - 1) ||
        (pack.epochs || []).find((p) => p.order === e.order - 1) ||
        siblings.flatMap((p) => p.epochs || []).find((p) => p.order === e.order - 1);
      if (!prev) {
        errors.push(`Epoche '${e.id}': keine Vorgänger-Epoche mit order ${e.order - 1}`);
      } else if (prev.advance == null && !(pack.epochAdvance || {})[prev.id]) {
        errors.push(
          `Epoche '${e.id}': Vorgänger '${prev.id}' hat keine advance-Bedingung — per 'epochAdvance' nachliefern`
        );
      }
    }
  }

  for (const [eid, adv] of Object.entries(pack.epochAdvance || {})) {
    if (!epochExists(eid)) {
      errors.push(`epochAdvance: Epoche '${eid}' unbekannt`);
      continue;
    }
    const existing = registry.epochs.get(eid);
    if (existing && existing.advance != null) {
      errors.push(`epochAdvance: Epoche '${eid}' hat bereits eine advance-Bedingung`);
    }
    for (const rid of Object.keys(adv.resources || {})) {
      if (!resourceExists(rid)) errors.push(`epochAdvance '${eid}': Ressource '${rid}' unbekannt`);
    }
    for (const bid of Object.keys(adv.buildings || {})) {
      if (!buildingExists(bid)) errors.push(`epochAdvance '${eid}': Gebäude '${bid}' unbekannt`);
    }
  }

  for (const ev of pack.events || []) {
    if (ev.epoch && !epochExists(ev.epoch)) errors.push(`Event '${ev.id}': Epoche '${ev.epoch}' unbekannt`);
    for (const rid of Object.keys(ev.modifiers?.production || {})) {
      if (!resourceExists(rid)) errors.push(`Event '${ev.id}': Ressource '${rid}' unbekannt`);
    }
    for (const rid of Object.keys(ev.modifiers?.grant || {})) {
      if (!resourceExists(rid)) errors.push(`Event '${ev.id}': Ressource '${rid}' unbekannt`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Komplettvalidierung: Struktur + Referenzen. */
export function validatePack(pack, registry, siblings = []) {
  const s = validateStructure(pack);
  if (!s.ok) return s;
  return validateReferences(pack, registry, siblings);
}
