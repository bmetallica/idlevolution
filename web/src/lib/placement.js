// Client-seitiger Spiegel der Server-Platzierungsregeln (server/src/engine/map.js) —
// für die Live-Vorschau (grün/rot) beim Bauen. Der Server validiert immer erneut.

export const terrainAt = (map, x, y) => {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return map.legend[map.tiles[y * map.width + x]];
};

/**
 * Spiegelt effectiveTerrain() des Servers: SELBST GESETZTE Deko zählt fürs
 * Bauen und für die Nachbarschaft, gerodete Felder werden zu Gras.
 * Ohne das galt ein per Werkzeug gesetzter Fels clientseitig weiter als Gras —
 * die Mine daneben blieb rot, obwohl der Server sie erlaubt hätte, und der
 * Client hat den Bauauftrag gar nicht erst abgeschickt.
 * @param {object} deco { placed: {"x,y": 'tree'|'rock'}, clearedSet: Set<string> }
 */
export const effectiveTerrainClient = (map, deco, x, y) => {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  const key = `${x},${y}`;
  const p = deco?.placed?.[key];
  if (p === 'tree') return 'forest';
  if (p === 'rock') return 'rock';
  const t = map.legend[map.tiles[y * map.width + x]];
  if ((t === 'forest' || t === 'rock') && deco?.clearedSet?.has(key)) return 'grass';
  return t;
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

export function canPlaceClient(map, instances, defIndex, def, x, y, rot = 0, deco = null) {
  const { w, h } = footprintOf(def, rot);
  const allowed = def.placement?.terrain ?? ['grass'];
  const terrain = (px, py) => effectiveTerrainClient(map, deco, px, py);

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const t = terrain(x + dx, y + dy);
      if (t === null) return { ok: false, reason: 'außerhalb der Karte' };
      // Wald/Fels darf von Gras/Sand-Gebäuden gerodet werden
      const clearable = (t === 'forest' || t === 'rock') && (allowed.includes('grass') || allowed.includes('sand'));
      if (!allowed.includes(t) && !clearable) return { ok: false, reason: `braucht ${allowed.join('/')}` };
    }
  }
  const occ = occupiedTiles(instances, defIndex);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (occ.has(`${x + dx},${y + dy}`)) return { ok: false, reason: 'bereits bebaut' };
    }
  }
  for (const [needTerrain, need] of Object.entries(def.placement?.adjacent || {})) {
    let found = 0;
    for (let dy = -1; dy <= h; dy++) {
      for (let dx = -1; dx <= w; dx++) {
        if (dx >= 0 && dx < w && dy >= 0 && dy < h) continue;
        if (terrain(x + dx, y + dy) === needTerrain) found++;
      }
    }
    if (found < need) return { ok: false, reason: `braucht ${need}× ${needTerrain} angrenzend (gefunden: ${found})` };
  }
  return { ok: true };
}
