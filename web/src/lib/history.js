// D2: Verlaufs-Ringpuffer für Sparklines (Pop, Zufriedenheit, Nahrungs-Netto).
// Persistiert in localStorage — Trends sollen sichtbar sein, BEVOR sie kippen
// (die Todesspirale war 8 h lang unsichtbar). 300 Punkte × 2 min = 10 h Fenster.

const KEY = 'histBuf.v1';
const SAMPLE_MS = 120000; // alle 2 Minuten ein Punkt
const MAX_POINTS = 300; // ≈ 10 h

let buf = null;
function load() {
  if (buf) return buf;
  try { buf = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { buf = []; }
  if (!Array.isArray(buf)) buf = [];
  return buf;
}

/** Nimmt (gedrosselt) einen Messpunkt auf. @returns {boolean} true wenn gesampelt */
export function recordSample(state) {
  if (!state?.epoch) return false;
  const b = load();
  const now = Date.now();
  if (b.length && now - b[b.length - 1].t < SAMPLE_MS) return false;
  b.push({
    t: now,
    pop: Math.floor(state.population),
    sat: Math.round((state.satisfaction ?? 1) * 100) / 100,
    food: Math.round((state.food?.rate ?? 0) * 1000) / 1000,
  });
  while (b.length > MAX_POINTS) b.shift();
  try { localStorage.setItem(KEY, JSON.stringify(b)); } catch {}
  return true;
}

export function getHistory() {
  return load();
}
