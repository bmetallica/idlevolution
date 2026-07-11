// Stufe 5 der KI-Spieler-Roadmap: Handelssystem. Spieler stellen Angebote ein
// ("gebe X gegen Y"); die angebotene Ware wird sofort treuhänderisch abgezogen.
// Nimmt jemand an, zahlt er den geforderten Preis und beide Waren werden per
// Schiff (Stufe 4) ausgeliefert. Reine Funktionen; Angebote leben in world.offers.

import { findHarbor, dispatchShip } from './ships.js';

/**
 * Einfache KI-Handelslogik: nimmt EIN passendes fremdes Angebot an — wenn die KI
 * das geforderte Gut im Überschuss hat (kein Nahrungs-/Bedarfsgut) und das
 * angebotene Gut gebrauchen kann. Minimal gehalten (verfeinert der LLM-Stratege).
 */
export function aiConsiderTrade(world, players, ai, registry, tick) {
  if (ai.kind !== 'ai' || ai.active === false || !findHarbor(ai)) return null;
  const isFood = (rid) => registry.resources.get(rid)?.category === 'food';
  for (const o of world.offers || []) {
    if (o.owner === ai.id) continue;
    const surplus = (ai.resources[o.want.resourceId] || 0) > o.want.amount * 4 && !isFood(o.want.resourceId);
    const canUse = (ai.resources[o.give.resourceId] || 0) < o.give.amount * 2;
    if (surplus && canUse) {
      try { acceptOffer(world, players, ai, o.id, tick); return o; } catch { /* nächstes Angebot */ }
    }
  }
  return null;
}

/**
 * Einfache KI-Angebotslogik: stellt (höchstens ein) Angebot ein — bietet einen
 * Nicht-Nahrungs-Überschuss gegen ein knappes, von Gebäuden verbrauchtes Gut,
 * fair nach baseValue mit kleinem Rabatt. Minimal gehalten.
 */
export function aiPostOffer(world, ai, registry, tick) {
  if (ai.kind !== 'ai' || ai.active === false || !findHarbor(ai)) return null;
  if ((world.offers || []).some((o) => o.owner === ai.id)) return null; // schon ein Angebot offen

  let give = null, giveStock = 0;
  for (const [rid, amt] of Object.entries(ai.resources || {})) {
    if (amt > 120 && amt > giveStock && registry.resources.get(rid)?.category !== 'food') { give = rid; giveStock = amt; }
  }
  if (!give) return null;

  const consumed = new Set();
  for (const b of registry.buildings.values()) for (const r of Object.keys(b.production?.inputs || {})) consumed.add(r);
  let want = null, wantStock = Infinity;
  for (const rid of consumed) {
    if (rid === give || registry.resources.get(rid)?.category === 'food') continue;
    const amt = ai.resources[rid] || 0;
    if (amt < 25 && amt < wantStock) { want = rid; wantStock = amt; }
  }
  if (!want) return null;

  const gv = registry.resources.get(give)?.baseValue || 1;
  const wv = registry.resources.get(want)?.baseValue || 1;
  const giveAmt = Math.max(1, Math.min(60, Math.floor(giveStock * 0.4)));
  const wantAmt = Math.max(1, Math.round((giveAmt * gv) / wv * 0.9)); // 10% Rabatt → attraktiv
  try { return createOffer(world, ai, { resourceId: give, amount: giveAmt }, { resourceId: want, amount: wantAmt }, tick); }
  catch { return null; }
}

/** Stellt ein Angebot ein und zieht die angebotene Ware treuhänderisch ab. */
export function createOffer(world, player, give, want, tick) {
  const gAmt = Math.floor(Number(give?.amount) || 0);
  const wAmt = Math.floor(Number(want?.amount) || 0);
  if (gAmt <= 0 || wAmt <= 0) throw new Error('Mengen müssen größer 0 sein');
  if (!give.resourceId || !want.resourceId) throw new Error('Ware fehlt');
  if (give.resourceId === want.resourceId) throw new Error('Gebe und Nehme müssen verschieden sein');
  if (!findHarbor(player)) throw new Error('Du brauchst einen Hafen zum Handeln');
  if ((player.resources[give.resourceId] || 0) < gAmt) throw new Error(`Nicht genug ${give.resourceId}`);
  player.resources[give.resourceId] -= gAmt; // Treuhand
  world.offers ??= [];
  world.nextOfferId ??= 1;
  const offer = {
    id: world.nextOfferId++, owner: player.id, islandId: player.islandId,
    give: { resourceId: give.resourceId, amount: gAmt },
    want: { resourceId: want.resourceId, amount: wAmt },
    createdTick: tick,
  };
  world.offers.push(offer);
  return offer;
}

/** Nimmt ein eigenes Angebot zurück und erstattet die Treuhand-Ware. */
export function cancelOffer(world, player, offerId) {
  const i = (world.offers || []).findIndex((o) => o.id === Number(offerId) && o.owner === player.id);
  if (i < 0) throw new Error('Angebot nicht gefunden');
  const o = world.offers[i];
  player.resources[o.give.resourceId] = (player.resources[o.give.resourceId] || 0) + o.give.amount;
  world.offers.splice(i, 1);
  return o;
}

/**
 * Nimmt ein fremdes Angebot an: zahlt den Preis (Treuhand) und liefert beide
 * Waren per Schiff aus (angebotene Ware → Annehmer, Bezahlung → Anbieter).
 */
export function acceptOffer(world, players, accepter, offerId, tick) {
  const i = (world.offers || []).findIndex((o) => o.id === Number(offerId));
  if (i < 0) throw new Error('Angebot nicht gefunden');
  const offer = world.offers[i];
  if (offer.owner === accepter.id) throw new Error('Das ist dein eigenes Angebot');
  const offerer = players.find((p) => p.id === offer.owner && p.active !== false);
  if (!offerer) { // Anbieter weg → Angebot verfällt
    world.offers.splice(i, 1);
    throw new Error('Anbieter nicht mehr verfügbar');
  }
  if (!findHarbor(accepter)) throw new Error('Du brauchst einen Hafen zum Handeln');
  if (!findHarbor(offerer)) throw new Error('Anbieter hat keinen Hafen mehr');
  if ((accepter.resources[offer.want.resourceId] || 0) < offer.want.amount) throw new Error(`Nicht genug ${offer.want.resourceId}`);

  accepter.resources[offer.want.resourceId] -= offer.want.amount; // Bezahlung (Treuhand)
  // Angebotene Ware (bereits treuhänderisch beim Anbieter abgezogen) → Annehmer
  dispatchShip(world, offerer, accepter, offer.give.resourceId, offer.give.amount, tick);
  // Bezahlung → Anbieter
  dispatchShip(world, accepter, offerer, offer.want.resourceId, offer.want.amount, tick);
  world.offers.splice(i, 1);
  return { offer, offerer: offerer.id };
}
