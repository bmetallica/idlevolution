// Client-seitiger Spiegel der Server-Platzierungsregeln (server/src/engine/map.js) —
// für die Live-Vorschau (grün/rot) beim Bauen. Der Server validiert immer erneut.

export const terrainAt = (map, x, y) => {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return map.legend[map.tiles[y * map.width + x]];
};

export const footprintOf = (def, rot = 0) => {
  const w = def.placement?.size?.w ?? 1, h = def.placement?.size?.h ?? 1;
  return rot % 2 ? { w: h, h: w } : { w, h };
};

export function occupiedTiles(instances, defIndex) {
  const occ = new Set();
  for (const inst of instances || []) {
    const { w, h } = footprintOf(defIndex[inst.buildingId] || {}, inst.rot ?? 0);
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) occ.add(`${inst.x + dx},${inst.y + dy}`);
  }
  return occ;
}

export function canPlaceClient(map, instances, defIndex, def, x, y, rot = 0) {
  const { w, h } = footprintOf(def, rot);
  const allowed = def.placement?.terrain ?? ['grass'];

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const t = terrainAt(map, x + dx, y + dy);
      if (t === null) return { ok: false, reason: 'außerhalb der Karte' };
      if (!allowed.includes(t)) return { ok: false, reason: `braucht ${allowed.join('/')}` };
    }
  }
  const occ = occupiedTiles(instances, defIndex);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (occ.has(`${x + dx},${y + dy}`)) return { ok: false, reason: 'bereits bebaut' };
    }
  }
  for (const [terrain, need] of Object.entries(def.placement?.adjacent || {})) {
    let found = 0;
    for (let dy = -1; dy <= h; dy++) {
      for (let dx = -1; dx <= w; dx++) {
        if (dx >= 0 && dx < w && dy >= 0 && dy < h) continue;
        if (terrainAt(map, x + dx, y + dy) === terrain) found++;
      }
    }
    if (found < need) return { ok: false, reason: `braucht ${need}× ${terrain} angrenzend` };
  }
  return { ok: true };
}
