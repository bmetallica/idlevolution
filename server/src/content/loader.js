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
  dedupeResourceIcons(registry);
  return registry;
}

// Themen-Pools: passendes Icon je nach Name/Kategorie einer Ressource. Innerhalb
// eines Themas wird das erste noch freie Icon vergeben (distinkt + thematisch).
const ICON_THEMES = [
  { re: /erz|ore|mineral|gestein/i, icons: ['⛏️', '⛰️', '🧲'] },
  { re: /barren|ingot|\bbar\b|metall|kupfer|copper|bronze|zinn|tin/i, icons: ['🟧', '🟨', '🟫', '🔶'] },
  { re: /\bton\b|clay|lehm/i, icons: ['🟤', '🧱'] },
  { re: /keramik|ceramic|töpfer|pottery|porzellan|vase|krug|geschirr/i, icons: ['🍶', '🫖', '🏺'] },
  { re: /stoff|tuch|cloth|textil|wolle|wool|leinen|linen|seide|silk|garn|faden/i, icons: ['🧵', '🧶'] },
  { re: /getreide|grain|korn|mehl|flour|brot|bread|weizen|wheat/i, icons: ['🌾', '🍞'] },
  { re: /käse|cheese|milch|milk|obst|fruit|fleisch|meat|gemüse/i, icons: ['🧀', '🍎', '🥩'] },
  { re: /wein|wine|bier|beer|kaffee|coffee|met|rum|schnaps|alk/i, icons: ['🍷', '🍺', '☕'] },
  { re: /salz|salt|gewürz|spice|zucker|sugar/i, icons: ['🧂', '🧉'] },
  { re: /schmuck|jewel|edelstein|gem|diamant|diamond|luxus|luxury/i, icons: ['💎', '🔷', '🔸'] },
  { re: /gold/i, icons: ['🥇', '👑'] },
  { re: /silber|silver/i, icons: ['🥈', '🍽️'] },
  { re: /schwert|sword|waffe|weapon|klinge|blade/i, icons: ['🗡️', '⚔️'] },
  { re: /bogen|bow|pfeil|arrow/i, icons: ['🏹'] },
  { re: /rüstung|armor|schild|shield|harnisch/i, icons: ['🛡️', '🥼'] },
  { re: /glas|glass|fenster/i, icons: ['🪟', '🧊'] },
  { re: /öl|oil|kohle|coal|treibstoff|fuel|teer|pech/i, icons: ['🛢️', '🪔', '🕯️'] },
  { re: /papier|paper|buch|book|schrift/i, icons: ['📜', '📖'] },
  { re: /leder|leather|fell|pelz|fur|haut/i, icons: ['🟫', '🧳'] },
  { re: /medizin|medic|kräuter|herb|trank|potion/i, icons: ['💊', '🧪'] },
  { re: /werkzeug|tool|gerät|instrument/i, icons: ['🔧', '🪛', '⚒️'] },
];
// Neutrale Reserve, falls kein Thema passt oder alle Themen-Icons vergeben sind.
const FALLBACK_ICONS = [
  '🟡', '🟢', '🔵', '🟣', '🟥', '🟩', '🟦', '🟪', '🔷', '🔹', '🧴', '🔗', '⚓', '🪝', '🧭',
  '🔭', '⏳', '🪙', '💰', '📿', '🧿', '🪬', '🗿', '🪵', '🪨', '🎗️', '🏆', '🥉', '🪞', '🔮',
];

/**
 * Sorgt für eindeutige Ressourcen-Icons. Basis-/zuerst geladene Ressourcen behalten
 * ihr Icon; fehlende oder kollidierende Icons (typisch bei KI-generierten Ressourcen)
 * bekommen ein thematisch passendes, freies Fallback — stabil über Reloads.
 */
export function dedupeResourceIcons(registry) {
  const used = new Set();
  const needFix = [];
  // Runde 1: erstes Vorkommen jedes Icons reservieren (Reihenfolge = base zuerst)
  for (const r of registry.resources.values()) {
    const ic = (r.icon || '').trim();
    if (ic && !used.has(ic)) { r.icon = ic; used.add(ic); }
    else needFix.push(r); // fehlt oder Doppelbelegung
  }
  // Runde 2: thematisch passendes, freies Icon vergeben
  for (const r of needFix) {
    const key = `${r.id} ${r.name?.de || ''} ${r.name?.en || ''} ${r.category || ''}`;
    const themed = ICON_THEMES.find((t) => t.re.test(key))?.icons || [];
    const pick = [...themed, ...FALLBACK_ICONS].find((c) => !used.has(c));
    r.icon = pick || '📦';
    used.add(r.icon);
  }
}

/** Epochen sortiert nach order. */
export function epochsInOrder(registry) {
  return [...registry.epochs.values()].sort((a, b) => a.order - b.order);
}

/**
 * Anzeigename eines Content-Items für LLM-Prompts. Items aus übernommenen
 * ONLINE-Packs (fremde Spieler!) liefern nur ihre ID — deren Freitexte
 * erreichen so nie einen Prompt (Prompt-Injection-Schutz). Im UI werden die
 * Namen weiterhin normal angezeigt (dort nur als Text gerendert, harmlos).
 */
export function llmSafeName(item) {
  if (typeof item?._pack === 'string' && item._pack.startsWith('online-')) return item.id;
  return item?.name?.de || item?.id || '';
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
