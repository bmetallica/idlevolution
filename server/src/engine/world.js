// Welt-Generierung + Migration für Mehr-Insel-Karten (Stufe 0 der KI-Spieler-
// Roadmap, siehe docs/roadmap-ki-spieler.md). Eine große Karte trägt mehrere
// Insel-Regionen, getrennt durch Ozean. Reine Funktionen, keine Persistenz-/
// Tick-Anbindung — bewusst isoliert, damit der laufende Ablauf unberührt bleibt.

import { generateMap } from './map.js';

/** Deterministischer Sub-Seed je Insel-Platz. */
const islandSeed = (seed, i) => ((seed | 0) + (i + 1) * 0x9e3779b1) | 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Setzt eine Liste von Insel-Terrains (`specs`: {width,height,tiles}) in ein
 * Gitter-Layout zusammen, getrennt durch `gap` Felder Ozean (plus Ozean-Rand).
 * Zellgröße = größte Insel, sodass unterschiedlich große Inseln möglich sind
 * (z.B. eine gewachsene Alt-Insel neben Standard-KI-Inseln).
 */
function assembleWorld(specs, gap, seed) {
  const cols = Math.ceil(Math.sqrt(specs.length));
  const rows = Math.ceil(specs.length / cols);
  const cellW = Math.max(...specs.map((s) => s.width));
  const cellH = Math.max(...specs.map((s) => s.height));
  const stepX = cellW + gap;
  const stepY = cellH + gap;
  const width = gap + cols * stepX;
  const height = gap + rows * stepY;

  const arr = new Array(width * height).fill('W');
  const islands = [];
  for (let i = 0; i < specs.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const ox = gap + c * stepX;
    const oy = gap + r * stepY;
    const s = specs[i];
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) arr[(oy + y) * width + (ox + x)] = s.tiles[y * s.width + x];
    }
    islands.push({
      id: i, x: ox, y: oy, w: s.width, h: s.height,
      spawn: { x: ox + Math.floor(s.width / 2), y: oy + Math.floor(s.height / 2) },
    });
  }
  return { seed, width, height, tiles: arr.join(''), gap, islands };
}

/**
 * Erzeugt eine Weltkarte mit `islandCount` frisch generierten Insel-Plätzen.
 * Platz 0 ist konventionell der menschliche Spieler.
 */
export function generateWorld(seed = 1, opts = {}) {
  const islandCount = clamp(opts.islandCount ?? 5, 1, 8);
  const islandSize = opts.islandSize ?? 44;
  const gap = opts.gap ?? 18;
  const specs = [];
  for (let i = 0; i < islandCount; i++) {
    const isl = generateMap(islandSeed(seed, i), islandSize, islandSize);
    specs.push({ width: islandSize, height: islandSize, tiles: isl.tiles });
  }
  const world = assembleWorld(specs, gap, seed);
  world.islandSize = islandSize;
  return world;
}

/**
 * Baut eine Welt, in der Insel 0 die bestehende (Alt-)Karte ist und die
 * restlichen Plätze frisch generiert werden — für die Migration bestehender
 * Single-Player-Stände. Terrain der Alt-Insel bleibt exakt erhalten.
 */
export function buildWorldFromLegacy(legacyMap, opts = {}) {
  const islandCount = clamp(opts.islandCount ?? 5, 1, 8);
  const aiSize = opts.islandSize ?? 44;
  const gap = opts.gap ?? 18;
  const seed = opts.seed ?? (legacyMap.seed ?? 1);
  const specs = [{ width: legacyMap.width, height: legacyMap.height, tiles: legacyMap.tiles }];
  for (let i = 1; i < islandCount; i++) {
    const isl = generateMap(islandSeed(seed, i), aiSize, aiSize);
    specs.push({ width: aiSize, height: aiSize, tiles: isl.tiles });
  }
  return assembleWorld(specs, gap, seed);
}

/**
 * Bettet einen bestehenden Single-Player-Zustand in Insel 0 der neuen Welt ein:
 * verschiebt Instanzen/Straßen/Deko um den Insel-Offset, setzt Territorium
 * (region) und islandId. Die Karte lebt künftig in der Welt (nicht im Spieler).
 * Rein — mutiert `legacy` nicht.
 */
export function embedLegacyState(legacy, world) {
  const isl = world.islands[0];
  const ox = isl.x, oy = isl.y;
  const shiftKey = (k) => { const c = k.indexOf(','); return `${+k.slice(0, c) + ox},${+k.slice(c + 1) + oy}`; };
  const roadsArr = legacy.roads instanceof Set ? [...legacy.roads] : (legacy.roads || []);
  const clearedArr = legacy.cleared instanceof Set ? [...legacy.cleared] : (legacy.cleared || []);
  const placed = {};
  for (const [k, v] of Object.entries(legacy.placed || {})) placed[shiftKey(k)] = v;
  return {
    ...legacy,
    instances: (legacy.instances || []).map((i) => ({ ...i, x: i.x + ox, y: i.y + oy })),
    roads: new Set(roadsArr.map(shiftKey)),
    cleared: new Set(clearedArr.map(shiftKey)),
    placed,
    region: { x: isl.x, y: isl.y, w: isl.w, h: isl.h },
    islandId: 0,
    mapVersion: (legacy.mapVersion || 0) + 1,
  };
}

/** Liefert die Insel-ID, deren Region (x,y) enthält, sonst null (offener Ozean). */
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
