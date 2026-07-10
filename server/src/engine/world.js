// Welt-Generierung für Mehr-Insel-Karten (Stufe 0 der KI-Spieler-Roadmap,
// siehe docs/roadmap-ki-spieler.md). Eine große Karte trägt mehrere Insel-
// Regionen, getrennt durch Ozean. Jede Insel wird mit der bestehenden
// Insel-Generierung (generateMap) erzeugt und an ihre Weltposition gestempelt.
//
// Reine Funktionen, keine Persistenz/Tick-Anbindung — bewusst isoliert, damit
// der laufende Single-Player-Ablauf unberührt bleibt.

import { generateMap } from './map.js';

/** Deterministischer Sub-Seed je Insel-Platz. */
const islandSeed = (seed, i) => ((seed | 0) + (i + 1) * 0x9e3779b1) | 0;

/**
 * Erzeugt eine Weltkarte mit `islandCount` reservierten Insel-Plätzen in einem
 * Gitter-Layout, getrennt durch `gap` Felder Ozean (plus Ozean-Rand rundum).
 * Platz 0 ist konventionell der menschliche Spieler.
 *
 * @param {number} seed
 * @param {{islandCount?:number, islandSize?:number, gap?:number}} [opts]
 * @returns {{
 *   seed:number, width:number, height:number, tiles:string,
 *   islandSize:number, gap:number,
 *   islands: Array<{id:number, x:number, y:number, w:number, h:number, spawn:{x:number,y:number}}>
 * }}
 */
export function generateWorld(seed = 1, opts = {}) {
  const islandCount = Math.max(1, Math.min(8, opts.islandCount ?? 5));
  const islandSize = opts.islandSize ?? 44;
  const gap = opts.gap ?? 18;

  const cols = Math.ceil(Math.sqrt(islandCount));
  const rows = Math.ceil(islandCount / cols);
  const cell = islandSize + gap;
  const width = gap + cols * cell;
  const height = gap + rows * cell;

  const arr = new Array(width * height).fill('W'); // Ozean als Grundfläche
  const islands = [];

  for (let i = 0; i < islandCount; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const ox = gap + c * cell;
    const oy = gap + r * cell;
    // Insel mit der bestehenden Logik erzeugen und in die Welt stempeln
    const isl = generateMap(islandSeed(seed, i), islandSize, islandSize);
    for (let y = 0; y < islandSize; y++) {
      for (let x = 0; x < islandSize; x++) {
        arr[(oy + y) * width + (ox + x)] = isl.tiles[y * islandSize + x];
      }
    }
    islands.push({
      id: i,
      x: ox,
      y: oy,
      w: islandSize,
      h: islandSize,
      spawn: { x: ox + Math.floor(islandSize / 2), y: oy + Math.floor(islandSize / 2) },
    });
  }

  return { seed, width, height, tiles: arr.join(''), islandSize, gap, islands };
}

/**
 * Liefert die Insel-ID, deren Region (x,y) enthält, sonst null (offener Ozean).
 * Grundlage für Bau-Beschränkung aufs eigene Territorium und Insel-Wachstum.
 */
export function islandAt(world, x, y) {
  for (const isl of world.islands || []) {
    if (x >= isl.x && x < isl.x + isl.w && y >= isl.y && y < isl.y + isl.h) return isl.id;
  }
  return null;
}

/** Region-Rechteck einer Insel per ID (oder null). */
export function islandById(world, id) {
  return (world.islands || []).find((i) => i.id === id) || null;
}
