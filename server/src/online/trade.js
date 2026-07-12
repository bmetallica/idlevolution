// M3: Asynchroner Online-Handel ohne Server — Abwicklung über zwei Dateien
// im Community-Repo (offers.json = eigene Angebote + Abschluss-Tombstones,
// accepts.json = angenommene fremde Angebote). Der Handshake ist deterministisch:
//
//   1) A stellt Angebot ein → Ware wird lokal treuhänderisch abgezogen.
//   2) B nimmt an → zahlt lokal (Treuhand) und schreibt den Accept in SEINE Datei.
//   3) A sieht den Accept beim Sync → bucht die Bezahlung ein und schreibt einen
//      Tombstone {id, winner} — bei Doppel-Annahme gewinnt der früheste Zeitstempel.
//   4) B sieht den Tombstone beim Sync: winner=B → Ware gutschreiben;
//      winner≠B oder storniert (winner=null) → Bezahlung zurückerstatten.
//
// Ohne Server ist echte Konsistenz unmöglich (jeder kann seinen lokalen Stand
// editieren) — der Handshake sorgt aber dafür, dass EHRLICHE Clients nie
// doppelt buchen und nichts verlieren. Koop-Idle, kein Anti-Cheat-Theater.

const now = () => new Date().toISOString();
const CLOSED_TTL_DAYS = 14; // Tombstones so lange vorhalten, bis alle Accepts aufgelöst sind
const ACCEPT_TIMEOUT_DAYS = 14; // Anbieter verschwunden → Bezahlung zurück

export const emptyTrade = () => ({ offers: [], closed: [], accepts: [], nextId: 1 });

const days = (iso) => (Date.now() - new Date(iso || 0).getTime()) / 86400000;

/** Eigenes Angebot einstellen (Treuhand: Ware wird sofort abgezogen). */
export function createOnlineOffer(trade, player, me, give, want) {
  const gAmt = Math.floor(Number(give?.amount) || 0);
  const wAmt = Math.floor(Number(want?.amount) || 0);
  if (gAmt <= 0 || wAmt <= 0) throw new Error('Mengen müssen größer 0 sein');
  if (!give.resourceId || !want.resourceId) throw new Error('Ware fehlt');
  if (give.resourceId === want.resourceId) throw new Error('Gebe und Nehme müssen verschieden sein');
  if ((trade.offers || []).length >= 5) throw new Error('Maximal 5 offene Online-Angebote');
  if ((player.resources[give.resourceId] || 0) < gAmt) throw new Error(`Nicht genug ${give.resourceId}`);
  player.resources[give.resourceId] -= gAmt;
  const offer = {
    id: `${me.toLowerCase()}-${(trade.nextId = (trade.nextId || 1) + 1).toString(36)}-${Date.now().toString(36)}`,
    give: { resourceId: give.resourceId, amount: gAmt },
    want: { resourceId: want.resourceId, amount: wAmt },
    createdAt: now(),
  };
  (trade.offers ??= []).push(offer);
  return offer;
}

/** Eigenes Angebot zurückziehen (Erstattung + Storno-Tombstone für Annehmer). */
export function cancelOnlineOffer(trade, player, offerId) {
  const i = (trade.offers || []).findIndex((o) => o.id === offerId);
  if (i < 0) throw new Error('Angebot nicht gefunden');
  const o = trade.offers[i];
  player.resources[o.give.resourceId] = (player.resources[o.give.resourceId] || 0) + o.give.amount;
  trade.offers.splice(i, 1);
  (trade.closed ??= []).push({ id: o.id, winner: null, at: now() });
  return o;
}

/** Fremdes Angebot annehmen (zahlt Treuhand; Gutschrift kommt nach dem Handshake). */
export function acceptOnlineOffer(trade, player, me, offerOwner, offer) {
  if ((trade.accepts || []).some((a) => a.offerId === offer.id)) throw new Error('Bereits angenommen — wartet auf die Gegenseite');
  if ((player.resources[offer.want.resourceId] || 0) < offer.want.amount) throw new Error(`Nicht genug ${offer.want.resourceId}`);
  player.resources[offer.want.resourceId] -= offer.want.amount;
  const accept = {
    offerId: offer.id, offerOwner,
    give: { ...offer.give }, want: { ...offer.want }, // Konditionen einfrieren
    acceptedAt: now(),
  };
  (trade.accepts ??= []).push(accept);
  return accept;
}

/**
 * Abwicklung beim Sync (rein, testbar): eigene Angebote gegen fremde Accepts
 * matchen, eigene Accepts gegen fremde Tombstones auflösen.
 * @param trade   eigener Handelszustand (wird mutiert)
 * @param player  eigener Spieler (Ressourcen werden mutiert)
 * @param me      eigener GitHub-Name
 * @param data    {owner: {offers?:{offers,closed}, accepts?:{accepts}}} der Nachbarn
 * @returns {string[]} menschenlesbare Ereignisse
 */
export function settleTrades(trade, player, me, data) {
  const events = [];

  // 1) Eigene Angebote: Accepts aller Nachbarn einsammeln → frühester gewinnt
  for (const offer of [...(trade.offers || [])]) {
    const candidates = [];
    for (const [owner, d] of Object.entries(data)) {
      for (const a of d.accepts?.accepts || []) {
        if (a.offerOwner === me && a.offerId === offer.id) candidates.push({ owner, at: a.acceptedAt || '' });
      }
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => a.at.localeCompare(b.at));
    const winner = candidates[0].owner;
    player.resources[offer.want.resourceId] = (player.resources[offer.want.resourceId] || 0) + offer.want.amount;
    trade.offers = trade.offers.filter((o) => o.id !== offer.id);
    (trade.closed ??= []).push({ id: offer.id, winner, at: now() });
    events.push(`💰 ${winner} hat dein Angebot angenommen: +${offer.want.amount} ${offer.want.resourceId}`);
  }

  // 2) Eigene Accepts gegen die Tombstones/Angebote des Anbieters auflösen
  for (const a of [...(trade.accepts || [])]) {
    const d = data[a.offerOwner];
    const done = () => { trade.accepts = trade.accepts.filter((x) => x !== a); };
    if (d?.offers) {
      const tomb = (d.offers.closed || []).find((c) => c.id === a.offerId);
      if (tomb) {
        if (tomb.winner === me) {
          player.resources[a.give.resourceId] = (player.resources[a.give.resourceId] || 0) + a.give.amount;
          events.push(`📦 Handel abgeschlossen: +${a.give.amount} ${a.give.resourceId} von ${a.offerOwner}`);
        } else {
          player.resources[a.want.resourceId] = (player.resources[a.want.resourceId] || 0) + a.want.amount;
          events.push(tomb.winner
            ? `↩️ ${a.offerOwner}s Angebot ging an ${tomb.winner} — ${a.want.amount} ${a.want.resourceId} zurückerstattet`
            : `↩️ ${a.offerOwner} hat das Angebot zurückgezogen — ${a.want.amount} ${a.want.resourceId} zurückerstattet`);
        }
        done();
        continue;
      }
      if ((d.offers.offers || []).some((o) => o.id === a.offerId)) continue; // noch offen → warten
      // Weder offen noch Tombstone (Datei zurückgesetzt o.ä.) → Timeout abwarten
    }
    if (days(a.acceptedAt) > ACCEPT_TIMEOUT_DAYS) {
      player.resources[a.want.resourceId] = (player.resources[a.want.resourceId] || 0) + a.want.amount;
      events.push(`⌛ Keine Antwort von ${a.offerOwner} — ${a.want.amount} ${a.want.resourceId} zurückerstattet`);
      done();
    }
  }

  // 3) Alte Tombstones ausdünnen
  trade.closed = (trade.closed || []).filter((c) => days(c.at) <= CLOSED_TTL_DAYS);
  return events;
}
