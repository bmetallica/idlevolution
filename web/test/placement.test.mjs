// Regression: Der Client-Spiegel der Platzierungsregeln muss dieselbe Antwort
// geben wie der Server. Bis 2026-07-29 rechnete er mit dem ROHEN Terrain —
// ein selbst gesetzter Fels zählte für die Nachbarschaft nicht, die Mine daneben
// blieb rot, und der Client schickte den Bauauftrag gar nicht erst ab
// (App.svelte onPlace: `if (!ok) return`), obwohl der Server ihn erlaubt hätte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canPlaceClient, effectiveTerrainClient } from '../src/lib/placement.js';
import { canPlace, effectiveTerrain } from '../../server/src/engine/map.js';

// 5×3-Karte, alles Gras
const W = 5, H = 3;
const legend = { G: 'grass', R: 'rock', F: 'forest', W: 'water', S: 'sand' };
const clientMap = { width: W, height: H, tiles: 'G'.repeat(W * H), legend };
const serverMap = { width: W, height: H, tiles: 'G'.repeat(W * H) };

const mine = { id: 'mine', placement: { terrain: ['grass'], adjacent: { rock: 1 }, size: { w: 1, h: 1 } } };
const registry = { buildings: new Map([['mine', mine]]) };

function bothAgree(placed, cleared, x, y) {
  const clientDeco = { placed, clearedSet: new Set(cleared) };
  const serverState = { instances: [], placed, cleared: new Set(cleared) };
  const c = canPlaceClient(clientMap, [], { mine }, mine, x, y, 0, clientDeco);
  const s = canPlace(serverMap, serverState, registry, mine, x, y, 0);
  assert.equal(c.ok, s.ok, `Client (${c.ok}: ${c.reason}) ≠ Server (${s.ok}: ${s.reason})`);
  return c.ok;
}

test('effectiveTerrainClient spiegelt effectiveTerrain des Servers', () => {
  const placed = { '1,1': 'rock', '2,1': 'tree' };
  const cleared = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assert.equal(
        effectiveTerrainClient(clientMap, { placed, clearedSet: new Set(cleared) }, x, y),
        effectiveTerrain(serverMap, { placed, cleared: new Set(cleared) }, x, y),
        `Feld ${x},${y}`
      );
    }
  }
});

test('gesetzter Fels erfüllt die rock-Nachbarschaft einer Mine', () => {
  // ohne Deko: kein Fels weit und breit → nicht baubar
  assert.equal(bothAgree({}, [], 2, 1), false);
  // Spieler setzt einen Fels direkt daneben → jetzt baubar
  assert.equal(bothAgree({ '1,1': 'rock' }, [], 2, 1), true);
});

test('gesetzter Fels wirkt nur im 8er-Ring, nicht darüber hinaus', () => {
  assert.equal(bothAgree({ '0,0': 'rock' }, [], 2, 1), false, 'zwei Felder entfernt zählt nicht');
  assert.equal(bothAgree({ '1,0': 'rock' }, [], 2, 1), true, 'diagonal zählt');
});

test('gerodeter Fels zählt nicht mehr als Fels', () => {
  const rockMap = { width: W, height: H, tiles: 'R' + 'G'.repeat(W * H - 1), legend };
  const rockServerMap = { width: W, height: H, tiles: 'R' + 'G'.repeat(W * H - 1) };
  const at = (placed, cleared) => {
    const c = canPlaceClient(rockMap, [], { mine }, mine, 1, 0, 0, { placed, clearedSet: new Set(cleared) });
    const s = canPlace(rockServerMap, { instances: [], placed, cleared: new Set(cleared) }, registry, mine, 1, 0, 0);
    assert.equal(c.ok, s.ok, `Client ${c.ok} ≠ Server ${s.ok}`);
    return c.ok;
  };
  assert.equal(at({}, []), true, 'natürlicher Fels nebenan → baubar');
  assert.equal(at({}, ['0,0']), false, 'gerodet → kein Fels mehr');
});

test('gesetzter Baum erfüllt die forest-Nachbarschaft', () => {
  const hut = { id: 'hut', placement: { terrain: ['grass'], adjacent: { forest: 2 }, size: { w: 1, h: 1 } } };
  const reg = { buildings: new Map([['hut', hut]]) };
  const placed = { '1,1': 'tree', '1,0': 'tree' };
  const c = canPlaceClient(clientMap, [], { hut }, hut, 2, 1, 0, { placed, clearedSet: new Set() });
  const s = canPlace(serverMap, { instances: [], placed, cleared: new Set() }, reg, hut, 2, 1, 0);
  assert.equal(c.ok, true);
  assert.equal(s.ok, true);
});
