// Aufbewahrung der Laufzeit-Archive. `data/exports/` und `data/rejected/`
// wuchsen unbegrenzt — je ein Export pro Nacht (~44 KB) plus jedes abgelehnte
// Pack, ohne dass jemand aufräumt.

import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Löscht Dateien, die älter als `days` Tage sind.
 * @returns {Promise<number>} Anzahl gelöschter Dateien
 */
export async function pruneOldFiles(dir, days) {
  if (!(days > 0)) return 0;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // Verzeichnis gibt es (noch) nicht
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const s = await stat(file);
      if (!s.isFile() || s.mtimeMs >= cutoff) continue;
      await unlink(file);
      removed++;
    } catch {
      // Parallel gelöscht oder keine Berechtigung → überspringen
    }
  }
  return removed;
}

/** Räumt die Archive des Nachtlaufs auf. Generierte Content-Packs bleiben unberührt. */
export async function pruneArchives(dataDir, days, log) {
  const results = await Promise.all([
    pruneOldFiles(path.join(dataDir, 'exports'), days),
    pruneOldFiles(path.join(dataDir, 'rejected'), days),
  ]);
  const total = results.reduce((a, b) => a + b, 0);
  if (total) log?.info?.(`[nightly] Archiv aufgeräumt: ${total} Datei(en) älter als ${days} Tage gelöscht`);
  return total;
}
