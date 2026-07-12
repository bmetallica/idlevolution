// Prozedurale isometrische Gebäude-Sprites (reines Canvas-Vektor-Zeichnen).
//
// Voll data-driven & AI-erweiterbar: Aussehen aus meta.art → Funktion → category,
// Material aus Epoche, id-Hash für Variation. Ein von Gemma erfundenes Gebäude
// bekommt automatisch eine passende Silhouette.
//
// PERFORMANCE: Der statische Gebäudekörper wird EINMAL in ein Offscreen-Canvas
// gerendert (getBuildingSprite, gecacht) und danach nur noch geblittet. Nur die
// wenigen animierten Teile (Rauch, Sägeblatt, Ofenglut, Fensterlicht) werden pro
// Frame als leichtes Overlay gezeichnet (drawBuildingFX).

import { gridToScreen, TILE_W, TILE_H } from './iso.js';

// ── Farb-Helfer ────────────────────────────────────────────────────────────
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
function rgbToHex(r, g, b) { const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'); return `#${c(r)}${c(g)}${c(b)}`; }
function shade(hex, f) { const { r, g, b } = hexToRgb(hex); return rgbToHex(r * f, g * f, b * f); }
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const MATERIALS = [
  { wall: '#b98a56', roof: '#8a9a44' },
  { wall: '#caa76f', roof: '#b0623a' },
  { wall: '#b7b0a2', roof: '#9a4a3c' },
  { wall: '#c9c4bb', roof: '#7d5230' },
  { wall: '#a9b3bd', roof: '#5f6b74' },
  { wall: '#c8cdd4', roof: '#4a6b8a' },
];

// ── Archetyp-Klassifikation (data-driven) ────────────────────────────────────
const ARCH_RULES = [
  { a: 'smelter', re: /(smelt|schmelz|furnace|foundry|\bforge|schmiede|kiln|smeltery|bloomery|hochofen|brennofen|glaswerk|glashütte|glassworks)/ },
  { a: 'mine', re: /(\bmine|mining|bergwerk|erz|\bore\b|coal|kohle|copper|kupfer|\biron|eisen|\btin\b|zinn|gold|silver|silber|\bgem|kristall|crystal|schacht|stollen|mineral)/ },
  { a: 'quarry', re: /(quarry|steinbruch|marble|marmor|granit|granite|\bpit\b|grube)/ },
  { a: 'sawmill', re: /(sawmill|säge|plank|brett|\bboard|lumber ?mill|carpenter|zimmer|schreiner)/ },
  { a: 'woodcutter', re: /(lumberjack|holzfäll|woodcut|forester|förster|logging|feller|\baxe\b|\bfäll)/ },
  { a: 'farm', re: /(\bfarm|feld|\bfield|grain|getreide|wheat|weizen|garden|garten|orchard|obst|acker|plantation|plantage|vineyard|weinberg|\bherb|kräuter|\bcrop|ernte|bauernhof|windmühle|windmill|bakery|bäcker|\bmill\b|mühle)/ },
  { a: 'harbor', re: /(harbor|harbour|hafen|\bdock|\bpier|\bsteg|jetty|anleger|\bquay|\bkai\b|wharf|marina|\bboot|\bboat)/ },
  { a: 'fishery', re: /(\bfish|fisch|\bnet\b|netz|whal|\bwal\b|pearl|perle|\bsalt|\bsalz)/ },
  { a: 'gatherer', re: /(gather|sammler|forager|\bhunt|jäg|berry|beere|\broot|wurzel|foraging)/ },
  { a: 'market', re: /(market|markt|\btrade|handel|bazaar|basar|\bshop|kontor|guild|gilde|merchant|händler)/ },
  { a: 'temple', re: /(temple|tempel|church|kirche|shrine|schrein|monument|denkmal|altar|chapel|kapelle|cathedral|\bdom\b|pyramid)/ },
  { a: 'tower', re: /(tower|\bturm|watch|wacht|\bkeep\b|castle|burg|\bfort|festung|lighthouse|leuchtturm|hall|halle|rathaus)/ },
  { a: 'workshop', re: /(workshop|werkstatt|\btool|werkzeug|craft|handwerk|potter|töpfer|weaver|weber|tailor|schneider|smith|tannery|gerber|brewery|brauerei|loom|webstuhl|manufact|manufaktur|mint|münz)/ },
  { a: 'warehouse', re: /(storage|lager|warehouse|depot|\bsilo|granary|speicher|vorrat|\bstock|\bbarn|scheune)/ },
  { a: 'house', re: /(house|\bhaus|\bhut\b|hütte|\bhome|wohn|cottage|residence|siedler|dwelling|\btent|zelt|lodge|apartment|villa|manor)/ },
];
const KNOWN_ARCH = new Set([...ARCH_RULES.map((r) => r.a), 'storage', 'civic', 'production', 'housing']);

export function classifyArchetype(def) {
  const explicit = def.meta?.art?.shape;
  if (explicit && KNOWN_ARCH.has(explicit)) {
    if (explicit === 'housing') return 'house';
    if (explicit === 'storage') return 'warehouse';
    if (explicit === 'civic') return 'market';
    if (explicit === 'production') return classifyByFunction(def) || 'workshop';
    return explicit;
  }
  return classifyByFunction(def) || fallbackByCategory(def.category);
}
function classifyByFunction(def) {
  const parts = [def.id, def.name?.de, def.name?.en, def.description?.de,
    ...Object.keys(def.production?.outputs || {}), ...Object.keys(def.production?.inputs || {})];
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  for (const { a, re } of ARCH_RULES) if (re.test(hay)) return a;
  return null;
}
function fallbackByCategory(cat) {
  return cat === 'housing' ? 'house' : cat === 'storage' ? 'warehouse' : cat === 'civic' ? 'market' : 'workshop';
}

export function paletteFor(def, epochOrder = 0) {
  const h = hashStr(def.id || 'x');
  const base = MATERIALS[Math.max(0, Math.min(MATERIALS.length - 1, epochOrder))];
  const art = def.meta?.art || {};
  return {
    wall: art.wall || shade(base.wall, 0.9 + ((h >> 3) & 15) / 60),
    roof: art.roof || shade(base.roof, 0.85 + ((h >> 7) & 15) / 50),
    accent: art.accent || hslHex((h % 360), 55, 55),
    seed: art.seed ?? h, // eingefroren bei Online-Content (ID-Umbenennung ändert sonst die Optik)
  };
}

// ── Geometrie (rein, ohne Zeichnen) ───────────────────────────────────────────
function footprintCorners(gx, gy, w, h) {
  const N = gridToScreen(gx, gy), E = gridToScreen(gx + w - 1, gy);
  const S = gridToScreen(gx + w - 1, gy + h - 1), W = gridToScreen(gx, gy + h - 1);
  return {
    n: { x: N.x, y: N.y - TILE_H / 2 }, e: { x: E.x + TILE_W / 2, y: E.y },
    s: { x: S.x, y: S.y + TILE_H / 2 }, w: { x: W.x - TILE_W / 2, y: W.y },
  };
}
const lift = (p, dy) => ({ x: p.x, y: p.y - dy });
const mid = (a, b, t = 0.5) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const center4 = (c) => ({ x: (c.n.x + c.e.x + c.s.x + c.w.x) / 4, y: (c.n.y + c.e.y + c.s.y + c.w.y) / 4 });

function boxCorners(c, base, height) {
  return {
    gN: lift(c.n, base), gE: lift(c.e, base), gS: lift(c.s, base), gW: lift(c.w, base),
    tN: lift(c.n, base + height), tE: lift(c.e, base + height), tS: lift(c.s, base + height), tW: lift(c.w, base + height),
  };
}

const WALL_H = { house: 20, farm: 16, woodcutter: 17, sawmill: 18, gatherer: 16, mine: 16, quarry: 12, smelter: 22, workshop: 20, fishery: 16, harbor: 13, market: 20, temple: 26, tower: 40, warehouse: 15 };
function wallHeight(arch, foot) { return (WALL_H[arch] ?? 20) + foot * 3; }

// ── Zeichen-Primitive ─────────────────────────────────────────────────────────
function poly(g, pts, fill, stroke, lw) {
  g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
}
function paintBox(g, bc, wall, noTop) {
  poly(g, [bc.gE, bc.gS, bc.tS, bc.tE], shade(wall, 0.78), 'rgba(0,0,0,0.22)');
  poly(g, [bc.gS, bc.gW, bc.tW, bc.tS], shade(wall, 0.56), 'rgba(0,0,0,0.22)');
  if (!noTop) poly(g, [bc.tN, bc.tE, bc.tS, bc.tW], wall, 'rgba(0,0,0,0.18)');
}
function wallPatch(g, gA, gB, tA, tB, u0, u1, v0, v1, fill) {
  const p = (u, v) => ({
    x: gA.x + (gB.x - gA.x) * u + ((tA.x - gA.x) + ((tB.x - gB.x) - (tA.x - gA.x)) * u) * v,
    y: gA.y + (gB.y - gA.y) * u + ((tA.y - gA.y) + ((tB.y - gB.y) - (tA.y - gA.y)) * u) * v,
  });
  poly(g, [p(u0, v0), p(u1, v0), p(u1, v1), p(u0, v1)], fill);
}
function hipRoof(g, top, roofH, roof) {
  const apex = { x: (top.tN.x + top.tE.x + top.tS.x + top.tW.x) / 4, y: (top.tN.y + top.tE.y + top.tS.y + top.tW.y) / 4 - roofH };
  poly(g, [top.tS, top.tW, apex], shade(roof, 0.7), 'rgba(0,0,0,0.15)');
  poly(g, [top.tE, top.tS, apex], shade(roof, 0.95), 'rgba(0,0,0,0.15)');
  poly(g, [top.tN, top.tE, apex], shade(roof, 1.12), 'rgba(0,0,0,0.1)');
  poly(g, [top.tW, top.tN, apex], shade(roof, 0.84), 'rgba(0,0,0,0.1)');
  return apex;
}
function flatRoof(g, top, roof) { poly(g, [top.tN, top.tE, top.tS, top.tW], shade(roof, 0.82), 'rgba(0,0,0,0.2)'); }
function domeRoof(g, top, roofH, roof) {
  const cx = (top.tN.x + top.tS.x) / 2, cy = (top.tN.y + top.tS.y) / 2;
  poly(g, [top.tN, top.tE, top.tS, top.tW], shade(roof, 0.75));
  const grd = g.createRadialGradient(cx - 3, cy - roofH * 0.6, 2, cx, cy - roofH * 0.4, roofH);
  grd.addColorStop(0, shade(roof, 1.3)); grd.addColorStop(1, shade(roof, 0.7));
  g.fillStyle = grd; g.beginPath(); g.ellipse(cx, cy - roofH * 0.35, TILE_W * 0.28, roofH * 0.9, 0, Math.PI, 0); g.fill();
}

// Statische Requisiten
function chimneyStack(g, x, y, hgt, wall) { g.fillStyle = shade(wall, 0.5); g.fillRect(x - 2.5, y - hgt, 5, hgt); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.strokeRect(x - 2.5, y - hgt, 5, hgt); }
function logPile(g, x, y) {
  for (let i = 0; i < 3; i++) { g.fillStyle = '#7a4f28'; g.beginPath(); g.ellipse(x + i * 5 - 5, y, 3, 4, Math.PI / 2, 0, Math.PI * 2); g.fill(); g.fillStyle = '#c8944e'; g.beginPath(); g.arc(x + i * 5 - 5, y, 2, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#8a5a2b'; g.beginPath(); g.ellipse(x, y - 3, 5, 3, Math.PI / 2, 0, Math.PI * 2); g.fill();
}
function tunnel(g, top) {
  const base = mid(top.gS, top.gW, 0.5), topP = mid(top.tS, top.tW, 0.5), wid = 6, hh = (base.y - topP.y);
  g.fillStyle = '#181510'; g.beginPath();
  g.moveTo(base.x - wid, base.y); g.lineTo(base.x - wid, base.y - hh * 0.4);
  g.quadraticCurveTo(base.x, base.y - hh * 0.7, base.x + wid, base.y - hh * 0.4);
  g.lineTo(base.x + wid, base.y); g.closePath(); g.fill();
  g.strokeStyle = '#5a4327'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(base.x - wid, base.y); g.lineTo(base.x - wid, base.y - hh * 0.42); g.moveTo(base.x + wid, base.y); g.lineTo(base.x + wid, base.y - hh * 0.42); g.stroke();
}
function field(g, c) {
  const a = mid(c.w, c.s, 0.15), b = mid(c.s, c.e, 0.85);
  for (let i = 1; i <= 4; i++) { const t = i / 5, p1 = mid(a, c.s, t), p2 = mid(c.s, b, t); g.strokeStyle = i % 2 ? '#8fae4a' : '#c6a94e'; g.lineWidth = 2; g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke(); }
}
function silo(g, x, y, wall) {
  g.fillStyle = shade(wall, 0.9); g.fillRect(x - 4, y - 20, 8, 20);
  g.fillStyle = shade(wall, 1.1); g.beginPath(); g.ellipse(x, y - 20, 4, 2, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#8a4a3c'; g.beginPath(); g.moveTo(x - 4, y - 20); g.lineTo(x, y - 27); g.lineTo(x + 4, y - 20); g.closePath(); g.fill();
}
function stalls(g, cx, cy, accent) {
  const cols = [accent, shade(accent, 1.2), '#d9d2c4'];
  for (let i = 0; i < 3; i++) { const x = cx + (i - 1) * 12, y = cy + (i % 2) * 4; g.fillStyle = '#6b5334'; g.fillRect(x - 5, y - 6, 10, 6); g.fillStyle = cols[i % 3]; g.beginPath(); g.moveTo(x - 7, y - 6); g.lineTo(x, y - 12); g.lineTo(x + 7, y - 6); g.closePath(); g.fill(); }
}
function crates(g, top, accent) {
  const cx = (top.tN.x + top.tS.x) / 2, cy = (top.tN.y + top.tS.y) / 2;
  for (const [dx, dy] of [[-8, -3], [6, -6], [-2, 4], [10, 2]]) { g.fillStyle = shade(accent, 0.8); g.fillRect(cx + dx - 4, cy + dy - 10, 8, 6); g.strokeStyle = 'rgba(0,0,0,0.3)'; g.strokeRect(cx + dx - 4, cy + dy - 10, 8, 6); }
}
function net(g, x, y) { g.strokeStyle = 'rgba(230,230,220,0.7)'; g.lineWidth = 0.6; for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(x + i * 2, y - 8); g.lineTo(x + i * 2 + 4, y); g.stroke(); g.beginPath(); g.moveTo(x + i * 2, y - 8); g.lineTo(x + i * 2 - 4, y); g.stroke(); } }
// Hafen-Detail: Holzsteg mit Planken, Poller, vertäutem Boot und Fass
function bollard(g, x, y) {
  g.fillStyle = '#4a3620'; g.fillRect(x - 1.6, y - 7, 3.2, 7);
  g.fillStyle = '#2f2213'; g.beginPath(); g.ellipse(x, y - 7, 2.2, 1.4, 0, 0, Math.PI * 2); g.fill();
}
function barrel(g, x, y) {
  g.fillStyle = '#7a4f28'; g.beginPath(); g.ellipse(x, y, 3.4, 4.8, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#3a2712'; g.lineWidth = 0.8; g.stroke();
  g.beginPath(); g.moveTo(x - 3.2, y - 1.2); g.lineTo(x + 3.2, y - 1.2); g.moveTo(x - 3.2, y + 1.4); g.lineTo(x + 3.2, y + 1.4); g.stroke();
}
function mooredBoat(g, x, y, accent) {
  g.fillStyle = 'rgba(255,255,255,0.14)'; g.beginPath(); g.ellipse(x, y + 3, 12, 3.5, 0, 0, Math.PI * 2); g.fill(); // Kielwasser
  g.fillStyle = '#5b3d22'; g.beginPath();
  g.moveTo(x - 10, y); g.quadraticCurveTo(x, y + 6, x + 10, y); g.lineTo(x + 7, y - 3.5); g.lineTo(x - 7, y - 3.5); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.6; g.stroke();
  g.strokeStyle = '#3a2a18'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y - 3.5); g.lineTo(x, y - 18); g.stroke(); // Mast
  g.fillStyle = '#efe7d3'; g.beginPath(); g.moveTo(x + 1, y - 17); g.lineTo(x + 1, y - 5); g.lineTo(x + 9, y - 7); g.closePath(); g.fill(); // Segel
  g.fillStyle = accent; g.beginPath(); g.moveTo(x, y - 18); g.lineTo(x + 5, y - 16.5); g.lineTo(x, y - 15); g.closePath(); g.fill(); // Wimpel
}
function dock(g, c, cc, pal) {
  const a = mid(cc, c.s, 0.45), b = mid(cc, c.s, 1.35); // Steg vom Gebäude ins Wasser
  g.lineCap = 'round';
  g.strokeStyle = '#5f4526'; g.lineWidth = 8; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  g.strokeStyle = '#8a6a40'; g.lineWidth = 5; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  g.strokeStyle = 'rgba(50,34,16,0.55)'; g.lineWidth = 0.9; // Planken-Fugen
  for (let i = 1; i <= 6; i++) { const p = mid(a, b, i / 7); g.beginPath(); g.moveTo(p.x - 4.5, p.y - 1.6); g.lineTo(p.x + 4.5, p.y + 1.6); g.stroke(); }
  g.lineCap = 'butt';
  bollard(g, mid(a, b, 0.55).x + 6, mid(a, b, 0.55).y + 1);
  bollard(g, b.x + 5, b.y + 1);
  mooredBoat(g, b.x + 15, b.y + 2, pal.accent);
  barrel(g, a.x - 8, a.y + 2);
  barrel(g, a.x - 13, a.y + 4);
}
function bannerStatic(g, apex, accent) {
  g.strokeStyle = '#5b4a35'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(apex.x, apex.y); g.lineTo(apex.x, apex.y - 16); g.stroke();
  poly(g, [{ x: apex.x, y: apex.y - 16 }, { x: apex.x + 10, y: apex.y - 13 }, { x: apex.x, y: apex.y - 10 }], accent);
}
// Tür/Fenster je nach Ausrichtung: rot 0 = Tür links (S-W), rot 1 = Tür rechts
// (E-S), rot 2/3 = Front zeigt weg → keine Tür, Fenster auf beiden Sichtseiten.
function doorAndWindows(g, top, wall, rot = 0) {
  const win = 'rgba(70,58,44,0.9)'; // dunkles Glas (tags); Nachtlicht kommt als FX
  const winLeft = () => { wallPatch(g, top.gS, top.gW, top.tS, top.tW, 0.2, 0.34, 0.45, 0.72, win); wallPatch(g, top.gS, top.gW, top.tS, top.tW, 0.6, 0.74, 0.45, 0.72, win); };
  const winRight = () => { wallPatch(g, top.gE, top.gS, top.tE, top.tS, 0.2, 0.34, 0.45, 0.72, win); wallPatch(g, top.gE, top.gS, top.tE, top.tS, 0.6, 0.74, 0.45, 0.72, win); };
  const doorLeft = () => wallPatch(g, top.gS, top.gW, top.tS, top.tW, 0.34, 0.62, 0.0, 0.5, shade(wall, 0.38));
  const doorRight = () => wallPatch(g, top.gE, top.gS, top.tE, top.tS, 0.34, 0.62, 0.0, 0.5, shade(wall, 0.38));
  if (rot === 0) { doorLeft(); winRight(); }
  else if (rot === 1) { doorRight(); winLeft(); }
  else { winLeft(); winRight(); }
}

// ── Statischer Gebäudekörper (einmal gerendert & gecacht) ─────────────────────
function drawStaticInternal(g, def, gx, gy, w, h, epochOrder, rot = 0) {
  const pal = paletteFor(def, epochOrder);
  const arch = classifyArchetype(def);
  const c = footprintCorners(gx, gy, w, h);
  const foot = Math.max(w, h);
  const cc = center4(c);

  // Bodenschatten
  g.fillStyle = 'rgba(0,0,0,0.2)';
  g.beginPath(); g.ellipse(cc.x, cc.y + 2, TILE_W * 0.44 * w, TILE_H * 0.44 * h, 0, 0, Math.PI * 2); g.fill();

  const wH = wallHeight(arch, foot);
  const flat = arch === 'warehouse' || arch === 'quarry' || arch === 'harbor';
  const top = boxCorners(c, 0, wH);
  paintBox(g, top, pal.wall, flat);

  if (arch === 'mine') tunnel(g, top);
  else if (arch !== 'quarry') doorAndWindows(g, top, pal.wall, rot);

  let apex = null;
  if (arch === 'warehouse' || arch === 'quarry' || arch === 'harbor') flatRoof(g, top, pal.roof);
  else if (arch === 'temple') domeRoof(g, top, 18 + foot * 2, pal.roof);
  else if (arch === 'tower') {
    poly(g, [top.tN, top.tE, top.tS, top.tW], shade(pal.wall, 1.05), 'rgba(0,0,0,0.18)');
    const cxu = (top.tN.x + top.tS.x) / 2, cyu = (top.tN.y + top.tS.y) / 2;
    g.fillStyle = shade(pal.wall, 0.9);
    for (let i = -2; i <= 2; i += 2) g.fillRect(cxu + i * 4 - 1.5, cyu - 5, 3, 4);
  } else apex = hipRoof(g, top, (arch === 'market' ? 12 : 14) + foot * 2, pal.roof);

  switch (arch) {
    case 'house': chimneyStack(g, mid(top.tE, top.tN, 0.5).x, mid(top.tE, top.tN, 0.5).y - (14 + foot * 2) * 0.5, 8, pal.wall); break;
    case 'workshop': chimneyStack(g, mid(top.tN, top.tE, 0.6).x, mid(top.tN, top.tE, 0.6).y - (14 + foot * 2) * 0.6, 10, pal.wall); break;
    case 'smelter': {
      const ch = mid(top.tN, top.tE, 0.6);
      chimneyStack(g, ch.x, ch.y - 4, 18 + foot * 3, pal.wall);
      wallPatch(g, top.gS, top.gW, top.tS, top.tW, 0.38, 0.58, 0.05, 0.4, 'rgba(120,50,20,0.9)'); // Ofenöffnung (dunkel, FX pulst)
      break;
    }
    case 'sawmill': logPile(g, mid(cc, c.s, 0.7).x - 8, mid(cc, c.s, 0.7).y); break;
    case 'woodcutter': case 'gatherer': logPile(g, mid(cc, c.s, 0.75).x, mid(cc, c.s, 0.75).y); break;
    case 'farm': field(g, c); silo(g, mid(top.tE, top.tN, 0.3).x + 4, mid(c.e, c.n, 0.3).y, pal.wall); break;
    case 'mine': logPile(g, mid(cc, c.s, 0.8).x, mid(cc, c.s, 0.8).y); break;
    case 'quarry': for (const [dx, dy] of [[-6, 0], [4, -2], [0, 5]]) { g.fillStyle = 'rgba(150,145,132,0.9)'; g.fillRect(cc.x + dx - 3, cc.y + dy - 8, 6, 5); } break;
    case 'fishery': net(g, mid(c.s, c.e, 0.4).x, mid(c.s, c.e, 0.4).y); break;
    case 'harbor': dock(g, c, cc, pal); break;
    case 'market': stalls(g, cc.x, mid(cc, c.s, 0.5).y, pal.accent); break;
    case 'temple': bannerStatic(g, { x: cc.x, y: cc.y - wH - 20 }, pal.accent); break;
    case 'tower': bannerStatic(g, { x: (top.tN.x + top.tS.x) / 2, y: (top.tN.y + top.tS.y) / 2 - 6 }, pal.accent); break;
    case 'warehouse': crates(g, top, pal.accent); break;
  }

  // Typ-Emblem (in den Cache gebacken → kein Emoji-fillText pro Frame)
  if (def.icon) {
    g.font = `${11 + foot}px serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const ey = cc.y - wH - (arch === 'tower' ? 30 : 26) - foot * 3;
    g.fillStyle = 'rgba(0,0,0,0.16)'; g.beginPath(); g.arc(cc.x, ey, 7.5 + foot, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000'; g.fillText(def.icon, cc.x, ey + 1);
    g.textBaseline = 'alphabetic';
  }
}

// ── Bau-Zustand (nicht gecacht, da progress variiert) ─────────────────────────
function drawUnderConstruction(g, c, pal, progress, foot) {
  poly(g, [c.n, c.e, c.s, c.w], shade(pal.wall, 0.45), 'rgba(0,0,0,0.25)');
  const fullH = 20 + foot * 3, wH = Math.max(3, fullH * Math.min(1, progress));
  paintBox(g, boxCorners(c, 0, wH), shade(pal.wall, 0.85), false);
  g.strokeStyle = '#9a7b4f'; g.lineWidth = 1.5;
  for (const gg of [c.n, c.e, c.s, c.w]) { g.beginPath(); g.moveTo(gg.x, gg.y); g.lineTo(gg.x, gg.y - fullH - 4); g.stroke(); }
  const l = lift(c.w, fullH), r = lift(c.e, fullH);
  g.beginPath(); g.moveTo(l.x, l.y - 4); g.lineTo(r.x, r.y - 4); g.stroke();
  const cc = center4(c); g.font = '13px serif'; g.textAlign = 'center'; g.fillText('🏗️', cc.x, cc.y - fullH - 6);
}

// ── Sprite-Cache (Offscreen-Bitmap je Gebäudetyp) ─────────────────────────────
const spriteCache = new Map();
const SIDE_PAD = TILE_W * 0.7, TOP_PAD = 150, BOT_PAD = 16;

/** Liefert ein gecachtes Bitmap eines fertigen Gebäudes + Ankerversatz (ax, ay).
 *  w,h = bereits gedrehte Grundfläche; rot steuert die Türseite. */
export function getBuildingSprite(def, epochOrder, w, h, rot = 0) {
  const key = `${def.id}|${epochOrder}|${w}x${h}|${rot}`;
  let s = spriteCache.get(key);
  if (s) return s;
  const canvas = document.createElement('canvas');
  const ax = h * (TILE_W / 2) + SIDE_PAD, ay = TOP_PAD;
  canvas.width = Math.ceil((w + h) * (TILE_W / 2) + 2 * SIDE_PAD);
  canvas.height = Math.ceil(TOP_PAD + (w + h - 1) * (TILE_H / 2) + BOT_PAD);
  const g = canvas.getContext('2d');
  g.translate(ax, ay); // lokaler Ursprung gridToScreen(0,0) → (ax, ay)
  drawStaticInternal(g, def, 0, 0, w, h, epochOrder, rot);
  // In ein ImageBitmap konvertieren: als drawImage-Quelle GPU-resident & ohne
  // Neuübertragung pro Frame (Canvas2D-Quellen sind dafür deutlich langsamer).
  s = { canvas, bitmap: null, ax, ay };
  spriteCache.set(key, s);
  if (typeof createImageBitmap === 'function') createImageBitmap(canvas).then((bm) => { s.bitmap = bm; }).catch(() => {});
  return s;
}

// ── Animiertes Overlay (leichtgewichtig, pro Frame) ───────────────────────────
function smokePuffs(g, x, y, seed, time, spread = 1, tint = '210,210,214') {
  for (let i = 0; i < 3; i++) {
    const phase = ((time / 1400) + i / 3 + (seed % 100) / 100) % 1, a = (1 - phase) * 0.32;
    if (a <= 0.02) continue;
    g.fillStyle = `rgba(${tint},${a})`;
    g.beginPath(); g.arc(x + Math.sin(phase * 6 + seed) * 3 * spread, y - phase * 22, (2 + phase * 6) * spread, 0, Math.PI * 2); g.fill();
  }
}
/** Zeichnet nur die animierten Teile eines Gebäudes über das gecachte Bitmap. */
export function drawBuildingFX(g, def, gx, gy, w, h, epochOrder, time, id, night) {
  const arch = classifyArchetype(def);
  const foot = Math.max(w, h);
  const c = footprintCorners(gx, gy, w, h);
  const wH = wallHeight(arch, foot);
  const top = boxCorners(c, 0, wH);
  const pal = paletteFor(def, epochOrder);
  const roofH = (arch === 'market' ? 12 : 14) + foot * 2;

  // Fensterlicht bei Nacht (nur wenn Gebäude Fenster hat)
  if (night > 0.25 && arch !== 'mine' && arch !== 'quarry') {
    const win = `rgba(255,214,130,${(night - 0.25) * 0.9})`;
    wallPatch(g, top.gE, top.gS, top.tE, top.tS, 0.2, 0.34, 0.45, 0.72, win);
    wallPatch(g, top.gE, top.gS, top.tE, top.tS, 0.6, 0.74, 0.45, 0.72, win);
  }

  if (arch === 'house') { const ch = mid(top.tE, top.tN, 0.5); smokePuffs(g, ch.x, ch.y - roofH * 0.5 - 8, pal.seed + id, time / 1.6); }
  else if (arch === 'workshop') { const ch = mid(top.tN, top.tE, 0.6); smokePuffs(g, ch.x, ch.y - roofH * 0.6 - 10, pal.seed + id, time); }
  else if (arch === 'smelter') {
    const ch = mid(top.tN, top.tE, 0.6), chTop = ch.y - 4 - (18 + foot * 3);
    g.fillStyle = '#ff8a3a'; g.beginPath(); g.arc(ch.x, chTop, 3, 0, Math.PI * 2); g.fill();
    smokePuffs(g, ch.x, chTop - 2, pal.seed + id, time, 1.2, '90,80,80');
    // Ofenglut pulsiert
    g.globalAlpha = 0.35 + Math.sin(time / 260 + id) * 0.25;
    wallPatch(g, top.gS, top.gW, top.tS, top.tW, 0.38, 0.58, 0.05, 0.4, '#ff7a2a');
    g.globalAlpha = 1;
  } else if (arch === 'sawmill') {
    const p = mid(top.gE, top.gS, 0.5), rot = time / 300;
    g.save(); g.translate(p.x, p.y - 8); g.rotate(rot);
    g.fillStyle = '#c9ccd2'; g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#7d828b'; g.lineWidth = 1;
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.beginPath(); g.moveTo(Math.cos(a) * 6, Math.sin(a) * 6); g.lineTo(Math.cos(a) * 8, Math.sin(a) * 8); g.stroke(); }
    g.fillStyle = '#555'; g.beginPath(); g.arc(0, 0, 1.5, 0, Math.PI * 2); g.fill(); g.restore();
  }
}

// ── Live-Vollrenderer (Vorschau + Bau-Zustand; nicht gecacht) ─────────────────
export function drawBuilding(ctx, o) {
  const { def = {}, gx, gy, w = 1, h = 1, done = true, epochOrder = 0 } = o;
  ctx.save();
  ctx.globalAlpha = o.alpha ?? 1;
  if (!done) {
    const pal = paletteFor(def, epochOrder), c = footprintCorners(gx, gy, w, h), foot = Math.max(w, h), cc = center4(c);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(cc.x, cc.y + 2, TILE_W * 0.42 * w, TILE_H * 0.42 * h, 0, 0, Math.PI * 2); ctx.fill();
    drawUnderConstruction(ctx, c, pal, o.progress ?? 1, foot);
  } else {
    drawStaticInternal(ctx, def, gx, gy, w, h, epochOrder, o.rot || 0);
    drawBuildingFX(ctx, def, gx, gy, w, h, epochOrder, o.time || 0, o.id || 0, o.night || 0);
  }
  ctx.restore();
}
