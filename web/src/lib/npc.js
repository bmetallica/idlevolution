// Client-seitige NPC-Simulation: Siedler pendeln zwischen Wohnhaus und Arbeitsstätte
// und laufen dabei auf Straßen, wenn Start und Ziel ans Wegenetz angebunden sind.
// Rein kosmetisch (die Wirtschaft läuft im Server-Tick) — belebt die Karte.

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function spotsByRole(instances, defIndex) {
  const homes = [], jobs = [], any = [];
  for (const i of instances) {
    if (!i.done) continue;
    const p = { x: i.x + 0.5, y: i.y + 0.5 };
    any.push(p);
    const cat = defIndex?.[i.buildingId]?.category;
    if (cat === 'housing') homes.push(p);
    else if (cat === 'production') jobs.push(p);
  }
  return { homes, jobs, any };
}
const near = (a, bx, by) => Math.abs(a.x - bx) < 0.6 && Math.abs(a.y - by) < 0.6;

// ── Wegfindung über Straßen ───────────────────────────────────────────────────
const MAX_LINK = 9; // ≤3 Tile Abstand: nur nahe Straßen werden genutzt
function nearestRoad(roads, p) {
  let best = null, bd = Infinity;
  for (const k of roads) {
    const c = k.indexOf(',');
    const x = +k.slice(0, c), y = +k.slice(c + 1);
    const d = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best && bd <= MAX_LINK ? best : null;
}
/** BFS über Straßenfelder von Tile `from` zu `to`; liefert Tile-Liste oder null. */
function pathAlongRoads(roads, from, to) {
  if (!roads || roads.size === 0) return null;
  const s = nearestRoad(roads, from), g = nearestRoad(roads, to);
  if (!s || !g) return null;
  if (s.x === g.x && s.y === g.y) return [s];
  const q = [s], prev = new Map([[`${s.x},${s.y}`, null]]);
  let head = 0, found = false;
  while (head < q.length) {
    const cur = q[head++];
    if (cur.x === g.x && cur.y === g.y) { found = true; break; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy, k = `${nx},${ny}`;
      if (roads.has(k) && !prev.has(k)) { prev.set(k, cur); q.push({ x: nx, y: ny }); }
    }
  }
  if (!found) return null;
  const path = [];
  for (let c = g; c; c = prev.get(`${c.x},${c.y}`)) path.push(c);
  return path.reverse();
}

export function createNpcSystem() {
  let npcs = [];

  function assign(n, roles) {
    n.home = pick(roles.homes.length ? roles.homes : roles.any);
    n.job = pick(roles.jobs.length ? roles.jobs : roles.any);
    n.going = 'job'; n.route = [{ x: n.job.x, y: n.job.y }]; n.tx = n.job.x; n.ty = n.job.y;
  }

  /** Legt die Wegpunkte zum aktuellen Ziel fest (über Straßen, falls angebunden). */
  function setRoute(n, roads, dest) {
    const from = { x: Math.round(n.x - 0.5), y: Math.round(n.y - 0.5) };
    const to = { x: Math.round(dest.x - 0.5), y: Math.round(dest.y - 0.5) };
    const path = pathAlongRoads(roads, from, to);
    const wps = path ? path.map((t) => ({ x: t.x + 0.5, y: t.y + 0.5 })) : [];
    wps.push({ x: dest.x, y: dest.y });
    n.route = wps;
    const w = n.route.shift();
    n.tx = w.x; n.ty = w.y;
  }

  function sync(population, instances, defIndex) {
    const roles = spotsByRole(instances, defIndex);
    const target = Math.min(80, Math.max(0, Math.floor(population)));
    if (roles.any.length === 0) { npcs = []; return; }
    while (npcs.length < target) {
      const n = { speed: 0.014 + Math.random() * 0.02, pause: 0, hue: 20 + Math.random() * 30, shirt: 15 + Math.random() * 40, phase: Math.random() * Math.PI * 2 };
      assign(n, roles);
      n.x = n.home.x; n.y = n.home.y;
      npcs.push(n);
    }
    if (npcs.length > target) npcs.length = target;
    for (const n of npcs) {
      const homeGone = !roles.any.some((s) => near(s, n.home?.x, n.home?.y));
      const jobGone = !roles.any.some((s) => near(s, n.job?.x, n.job?.y));
      if (homeGone || jobGone) assign(n, roles);
    }
  }

  // `mult` = Anzahl der Basis-Schritte (60-fps-Äquivalent), die dieser Aufruf abdeckt.
  // So bleibt die Lauf-/Pausengeschwindigkeit konstant, auch wenn seltener gesteppt wird.
  function step(instances, defIndex, roads, mult = 1) {
    const roles = spotsByRole(instances, defIndex);
    if (roles.any.length === 0) return npcs;
    for (const n of npcs) {
      if (n.pause > 0) { n.pause -= mult; n.moving = false; continue; }
      const dx = n.tx - n.x, dy = n.ty - n.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.05) {
        if (n.route && n.route.length) {
          const w = n.route.shift(); n.tx = w.x; n.ty = w.y; // nächster Wegpunkt
        } else {
          n.pause = 25 + Math.floor(Math.random() * 70);
          n.going = n.going === 'job' ? 'home' : 'job';
          setRoute(n, roads, n.going === 'job' ? n.job : n.home);
        }
        n.moving = false;
      } else {
        const move = Math.min(dist, n.speed * mult); // nicht über den Wegpunkt hinausschießen
        n.x += (dx / dist) * move;
        n.y += (dy / dist) * move;
        n.moving = true;
      }
    }
    return npcs;
  }

  return { sync, step, get: () => npcs };
}
