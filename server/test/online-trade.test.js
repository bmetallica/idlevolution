// Tests für den asynchronen Online-Handel (M3): Treuhand, Handshake,
// Doppel-Annahme, Storno und Timeout — die Abwicklung muss deterministisch
// sein, ehrliche Clients dürfen nie doppelt buchen oder verlieren.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrade, createOnlineOffer, cancelOnlineOffer, acceptOnlineOffer, settleTrades } from '../src/online/trade.js';

const player = (res = {}) => ({ resources: { ...res } });

test('Angebot einstellen zieht Treuhand ab, Zurückziehen erstattet + Tombstone', () => {
  const t = emptyTrade();
  const p = player({ wood: 100 });
  const o = createOnlineOffer(t, p, 'alice', { resourceId: 'wood', amount: 60 }, { resourceId: 'stone', amount: 40 });
  assert.equal(p.resources.wood, 40);
  assert.equal(t.offers.length, 1);
  cancelOnlineOffer(t, p, o.id);
  assert.equal(p.resources.wood, 100);
  assert.equal(t.offers.length, 0);
  assert.deepEqual(t.closed[0], { id: o.id, winner: null, at: t.closed[0].at });
});

test('Annehmen zahlt Treuhand; doppeltes Annehmen desselben Angebots blockiert', () => {
  const t = emptyTrade();
  const p = player({ stone: 50 });
  const offer = { id: 'alice-x', give: { resourceId: 'wood', amount: 60 }, want: { resourceId: 'stone', amount: 40 } };
  acceptOnlineOffer(t, p, 'bob', 'alice', offer);
  assert.equal(p.resources.stone, 10);
  assert.throws(() => acceptOnlineOffer(t, p, 'bob', 'alice', offer), /Bereits angenommen/);
});

test('Anbieter-Seite: frühester Accept gewinnt, Bezahlung wird gutgeschrieben', () => {
  const t = emptyTrade();
  const p = player({ wood: 100 });
  const o = createOnlineOffer(t, p, 'alice', { resourceId: 'wood', amount: 60 }, { resourceId: 'stone', amount: 40 });
  const events = settleTrades(t, p, 'alice', {
    bob: { accepts: { accepts: [{ offerId: o.id, offerOwner: 'alice', give: o.give, want: o.want, acceptedAt: '2026-07-12T10:00:00Z' }] } },
    carol: { accepts: { accepts: [{ offerId: o.id, offerOwner: 'alice', give: o.give, want: o.want, acceptedAt: '2026-07-12T09:00:00Z' }] } },
  });
  assert.equal(p.resources.stone, 40); // Bezahlung
  assert.equal(t.offers.length, 0);
  assert.equal(t.closed[0].winner, 'carol'); // 09:00 < 10:00
  assert.equal(events.length, 1);
});

test('Annehmer-Seite: winner=ich → Ware; winner=anderer → Erstattung; storniert → Erstattung', () => {
  const offer = { id: 'alice-1', give: { resourceId: 'wood', amount: 60 }, want: { resourceId: 'stone', amount: 40 } };
  // Gewinner
  let t = emptyTrade(); let p = player({ stone: 40 });
  acceptOnlineOffer(t, p, 'bob', 'alice', offer);
  settleTrades(t, p, 'bob', { alice: { offers: { offers: [], closed: [{ id: 'alice-1', winner: 'bob', at: new Date().toISOString() }] } } });
  assert.equal(p.resources.wood, 60);
  assert.equal(p.resources.stone, 0);
  assert.equal(t.accepts.length, 0);
  // Verlierer
  t = emptyTrade(); p = player({ stone: 40 });
  acceptOnlineOffer(t, p, 'bob', 'alice', offer);
  settleTrades(t, p, 'bob', { alice: { offers: { offers: [], closed: [{ id: 'alice-1', winner: 'carol', at: new Date().toISOString() }] } } });
  assert.equal(p.resources.wood ?? 0, 0);
  assert.equal(p.resources.stone, 40); // erstattet
  // Storno
  t = emptyTrade(); p = player({ stone: 40 });
  acceptOnlineOffer(t, p, 'bob', 'alice', offer);
  settleTrades(t, p, 'bob', { alice: { offers: { offers: [], closed: [{ id: 'alice-1', winner: null, at: new Date().toISOString() }] } } });
  assert.equal(p.resources.stone, 40);
});

test('Offenes Angebot → Accept wartet; verschwundener Anbieter → Timeout-Erstattung', () => {
  const offer = { id: 'alice-2', give: { resourceId: 'wood', amount: 10 }, want: { resourceId: 'stone', amount: 5 } };
  const t = emptyTrade(); const p = player({ stone: 5 });
  acceptOnlineOffer(t, p, 'bob', 'alice', offer);
  // noch offen → bleibt pending
  settleTrades(t, p, 'bob', { alice: { offers: { offers: [offer], closed: [] } } });
  assert.equal(t.accepts.length, 1);
  assert.equal(p.resources.stone, 0);
  // Anbieter weg + Accept veraltet → Erstattung
  t.accepts[0].acceptedAt = new Date(Date.now() - 15 * 86400000).toISOString();
  const events = settleTrades(t, p, 'bob', {});
  assert.equal(t.accepts.length, 0);
  assert.equal(p.resources.stone, 5);
  assert.match(events[0], /zurückerstattet/);
});

test('Doppel-Buchung ausgeschlossen: zweiter Settle-Lauf ändert nichts mehr', () => {
  const t = emptyTrade();
  const p = player({ wood: 100 });
  const o = createOnlineOffer(t, p, 'alice', { resourceId: 'wood', amount: 60 }, { resourceId: 'stone', amount: 40 });
  const data = { bob: { accepts: { accepts: [{ offerId: o.id, offerOwner: 'alice', give: o.give, want: o.want, acceptedAt: '2026-07-12T10:00:00Z' }] } } };
  settleTrades(t, p, 'alice', data);
  settleTrades(t, p, 'alice', data); // Accept ist noch da — Angebot aber schon geschlossen
  assert.equal(p.resources.stone, 40); // nicht 80
});
