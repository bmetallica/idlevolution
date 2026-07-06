// Isometrische Projektion (2:1 Diamant-Tiles). Reine Koordinaten-Mathematik.

export const TILE_W = 64; // Breite eines Tiles in Pixeln
export const TILE_H = 32; // Höhe (halbe Breite → 2:1-Iso)

/** Gitter-Koordinate (Tile) → Pixel-Mittelpunkt des Tiles (vor Kamera-Transform). */
export function gridToScreen(gx, gy) {
  return {
    x: (gx - gy) * (TILE_W / 2),
    y: (gx + gy) * (TILE_H / 2),
  };
}

/** Pixel (Welt-Koordinate nach Kamera-Rücktransform) → Gitter-Koordinate. */
export function screenToGrid(sx, sy) {
  const gx = (sx / (TILE_W / 2) + sy / (TILE_H / 2)) / 2;
  const gy = (sy / (TILE_H / 2) - sx / (TILE_W / 2)) / 2;
  return { gx: Math.floor(gx), gy: Math.floor(gy) };
}

/** Die vier Eckpunkte eines Tile-Diamanten (für fill/stroke). */
export function tileDiamond(gx, gy) {
  const c = gridToScreen(gx, gy);
  return [
    { x: c.x, y: c.y - TILE_H / 2 }, // oben
    { x: c.x + TILE_W / 2, y: c.y }, // rechts
    { x: c.x, y: c.y + TILE_H / 2 }, // unten
    { x: c.x - TILE_W / 2, y: c.y }, // links
  ];
}

// Terrain-Farben (Ober-, Seiten- und Kantenlicht für plastische Kacheln)
export const TERRAIN_COLORS = {
  water: { top: '#2f6d94', side: '#234f6b', h: 0 },
  sand: { top: '#dcc681', side: '#bda766', h: 0 },
  grass: { top: '#6ba04d', side: '#517c38', h: 0 },
  forest: { top: '#4c7a3f', side: '#33532a', h: 7 },
  rock: { top: '#8f897b', side: '#615c50', h: 12 },
};

/** Deterministischer Pseudo-Zufall pro Tile (0..1) — für stabile Deko-Platzierung. */
export function tileRand(gx, gy, salt = 0) {
  let h = (gx * 374761393 + gy * 668265263 + salt * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function poly(g, pts, fill) {
  g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath(); g.fillStyle = fill; g.fill();
}

/** Ein Baum — je nach seed Laub- oder Nadelbaum, mit Licht/Schatten. */
export function drawTree(g, cx, cy, r = 1, seed = 0) {
  g.fillStyle = 'rgba(0,0,0,0.2)';
  g.beginPath(); g.ellipse(cx, cy + 1, 6 * r, 2.6 * r, 0, 0, Math.PI * 2); g.fill();
  const conifer = seed % 100 >= 55;
  // Stamm
  g.fillStyle = '#6b4c2c';
  g.beginPath();
  g.moveTo(cx - 1.6 * r, cy); g.lineTo(cx + 1.6 * r, cy);
  g.lineTo(cx + 1 * r, cy - 8 * r); g.lineTo(cx - 1 * r, cy - 8 * r); g.closePath(); g.fill();

  if (conifer) {
    const hue = 128 + ((seed >> 3) % 16) - 8;
    const dark = `hsl(${hue},38%,24%)`, base = `hsl(${hue},40%,32%)`, lit = `hsl(${hue},44%,42%)`;
    for (let i = 0; i < 3; i++) {
      const ty = cy - 5 * r - i * 8 * r, wdt = (9 - i * 2.2) * r, ht = 11 * r;
      poly(g, [{ x: cx, y: ty - ht }, { x: cx + wdt, y: ty }, { x: cx - wdt, y: ty }], base);
      poly(g, [{ x: cx, y: ty - ht }, { x: cx - wdt, y: ty }, { x: cx - wdt * 0.2, y: ty }], dark); // Schattenseite
      poly(g, [{ x: cx, y: ty - ht }, { x: cx - wdt * 0.55, y: ty - ht * 0.35 }, { x: cx, y: ty - ht * 0.2 }], lit); // Lichtkante
    }
  } else {
    const hue = 96 + ((seed >> 4) % 24) - 12;
    const dark = `hsl(${hue},40%,26%)`, base = `hsl(${hue},42%,34%)`, lit = `hsl(${hue},46%,45%)`;
    const blob = (dx, dy, rad, col) => { g.fillStyle = col; g.beginPath(); g.arc(cx + dx * r, cy - dy * r, rad * r, 0, Math.PI * 2); g.fill(); };
    blob(0, 11, 7, dark);
    blob(3.5, 13, 5.5, base);
    blob(-3.5, 14, 5, base);
    blob(0, 18, 5.5, base);
    blob(-2.5, 17, 3.2, lit); // Lichtakzent oben-links
    blob(-4, 15, 2.4, lit);
  }
}

/** Eine Felsgruppe aus facettierten Brocken (Licht oben, Schatten seitlich). */
export function drawRock(g, cx, cy, r = 1, seed = 0) {
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.beginPath(); g.ellipse(cx, cy + 2, 9 * r, 4 * r, 0, 0, Math.PI * 2); g.fill();
  const facet = (x, y, s, tone) => {
    const top = `hsl(40,8%,${58 + tone}%)`, left = `hsl(40,9%,${40 + tone}%)`, right = `hsl(40,10%,${30 + tone}%)`;
    // Deckfläche (Raute) + zwei Seitenfacetten für Low-Poly-Look
    poly(g, [{ x, y: y - s }, { x: x + s, y }, { x, y: y + s * 0.5 }, { x: x - s, y }], top);
    poly(g, [{ x: x - s, y }, { x, y: y + s * 0.5 }, { x, y: y + s * 1.2 }, { x: x - s, y: y + s * 0.7 }], left);
    poly(g, [{ x: x + s, y }, { x, y: y + s * 0.5 }, { x, y: y + s * 1.2 }, { x: x + s, y: y + s * 0.7 }], right);
  };
  facet(cx - 3.5 * r, cy - 1 * r, 5 * r, (seed % 8));
  facet(cx + 4 * r, cy + 1 * r, 4 * r, ((seed >> 3) % 8) - 2);
  facet(cx + 0.5 * r, cy + 3 * r, 3.5 * r, ((seed >> 6) % 6));
  // gelegentliche Erz-Ader
  if (seed % 100 < 22) { g.fillStyle = 'rgba(210,180,90,0.8)'; g.beginPath(); g.arc(cx - 2 * r, cy - 1 * r, 1.1 * r, 0, Math.PI * 2); g.fill(); }
}
