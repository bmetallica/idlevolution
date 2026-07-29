// updates.md 2.3 — Dubletten-Sperre gegen inhaltliche Monotonie
// ("Archivtresor" vs. "Quanten-Speicherzentrum" sind faktisch dasselbe Gebäude).
//
// MESSUNG (2026-07-29, nomic-embed-text, 66 echte Gebäude): Reine Text-Ähnlichkeit
// TRENNT NICHT. Bei allen getesteten Varianten (ohne Präfix, "clustering: ",
// "classification: ") überlappen echte Dubletten und legitim verschiedene Gebäude:
//   Dubletten   0.795–0.888
//   legitim     0.744–0.798   ← "Sägewerk"/"Werkzeugmacher" liegt so hoch wie eine Dublette
// Eine reine Schwelle würde also guten Inhalt wegwerfen. Deshalb zweistufig:
//
//   1. FUNKTIONALES GATE (hart): Nur Gebäude mit identischer Rolle werden
//      überhaupt verglichen — gleiche Kategorie UND gleiche Output-Güter.
//      Damit ist "Sägewerk vs. Werkzeugmacher" strukturell ausgeschlossen,
//      egal wie ähnlich die Beschreibungen klingen.
//   2. TEXT-ÄHNLICHKEIT (weich): Innerhalb dieser Gruppe entscheidet die
//      Einbettung, ob es wirklich dasselbe Gebäude ist.
//
// Fällt der Embedding-Server aus, wird die Prüfung übersprungen — eine
// Nacht darf nie an einer Zusatzprüfung scheitern.

/** Rolle eines Gebäudes: Nur bei Gleichheit lohnt der Textvergleich überhaupt. */
export function functionalKey(b) {
  const outputs = Object.keys(b.production?.outputs || {}).sort().join(',');
  const inputs = Object.keys(b.production?.inputs || {}).sort().join(',');
  const role = b.housing?.capacity > 0 ? 'housing' : b.storage ? 'storage' : 'plain';
  return `${b.category}|${role}|out:${outputs}|in:${inputs}`;
}

/**
 * Trägt die Funktions-Signatur überhaupt Information?
 * Zivilbauten ohne Produktion, Lager und Wohnraum landen alle im selben
 * Sammeltopf `civic|plain|out:|in:` — dort stehen Forschungsstation, Marktplatz,
 * Wachturm und Denkmal nebeneinander, obwohl sie nichts gemeinsam haben.
 * Gemessen erreichen solche Paare 0.833 Text-Ähnlichkeit, ohne Dubletten zu sein.
 * Für sie wird deshalb NICHT geprüft — lieber eine Dublette durchlassen als
 * ein legitimes Gebäude wegwerfen.
 */
export function isComparable(b) {
  return (
    Object.keys(b.production?.outputs || {}).length > 0 ||
    b.housing?.capacity > 0 ||
    !!b.storage
  );
}

/** Text, aus dem die Bedeutung eines Gebäudes gezogen wird. */
export function describeBuilding(b) {
  return `${b.name?.de || b.id}. ${b.description?.de || ''}`.trim();
}

/** Holt Einbettungen vom lokalen Server. Wirft bei Nichterreichbarkeit. */
export async function embedTexts(llm, texts) {
  if (!texts.length) return [];
  const res = await fetch(`${llm.baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: llm.embedModel, input: texts }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Embedding HTTP ${res.status}`);
  const data = await res.json();
  const vecs = (data.data || []).map((d) => d.embedding);
  if (vecs.length !== texts.length) throw new Error('unerwartete Anzahl Einbettungen');
  // normalisieren → Kosinus wird zum Skalarprodukt
  return vecs.map((v) => {
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/**
 * Findet neue Gebäude, die ein bestehendes faktisch wiederholen.
 * @param {object[]} candidates neue Gebäude aus dem Pack
 * @param {object[]} existing bereits vorhandene Gebäude
 * @returns {Promise<Array<{id: string, similarTo: string, score: number}>>}
 */
export async function findDuplicateBuildings(candidates, existing, llm, threshold) {
  if (!candidates.length) return [];
  // Nur Bestandsgebäude mit gleicher, AUSSAGEKRÄFTIGER Rolle sind Vergleichspartner
  const byKey = new Map();
  for (const b of existing) {
    if (!isComparable(b)) continue;
    const k = functionalKey(b);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  }
  const jobs = [];
  for (const c of candidates) {
    if (!isComparable(c)) continue;
    const peers = byKey.get(functionalKey(c));
    if (peers?.length) jobs.push({ candidate: c, peers });
  }
  if (!jobs.length) return []; // keine funktionsgleichen Partner → nichts zu prüfen

  // Alle Texte in EINEM Aufruf einbetten
  const texts = [];
  const index = [];
  for (const j of jobs) {
    index.push({ candidate: j.candidate, from: texts.length, peers: j.peers });
    texts.push(describeBuilding(j.candidate));
    for (const p of j.peers) texts.push(describeBuilding(p));
  }
  const V = await embedTexts(llm, texts);

  const hits = [];
  for (const { candidate, from, peers } of index) {
    let best = null;
    for (let i = 0; i < peers.length; i++) {
      const score = dot(V[from], V[from + 1 + i]);
      if (!best || score > best.score) best = { score, peer: peers[i] };
    }
    if (best && best.score >= threshold) {
      hits.push({ id: candidate.id, similarTo: best.peer.id, score: Math.round(best.score * 1000) / 1000 });
    }
  }
  return hits;
}
