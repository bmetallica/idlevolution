// Stufe 6 der KI-Spieler-Roadmap: Kriegssystem. Soldaten (Ressource, von der
// Kaserne ausgebildet) fahren per Kriegsschiff zu einer Nachbarinsel; bei der
// Ankunft entscheidet Angriffs- vs. Verteidigungsstärke. Sieg = Eroberung:
// die Insel wird Territorium des Siegers (Gebäude, Straßen, halbe Bevölkerung
// gehen über), der Verlierer ist besiegt. Reine Funktionen; rng injizierbar.

import { findHarbor, SHIP_SPEED } from './ships.js';

export const MILITIA_PER_POP = 0.05; // jede Insel wehrt sich: 5 % der Bevölkerung als Miliz

/** Angriffskraft = verfügbare Soldaten. */
export const armyOf = (player) => Math.floor(player.resources?.soldiers || 0);

/** Verteidigung = Soldaten + Wehranlagen (meta.military.defense) + Miliz. */
export function defenseOf(player, registry) {
  let towers = 0;
  for (const i of player.instances || []) {
    if (!i.counted) continue;
    const d = registry.buildings.get(i.buildingId);
    towers += d?.meta?.military?.defense || 0;
  }
  return armyOf(player) + towers + Math.floor((player.population || 0) * MILITIA_PER_POP);
}

/**
 * Startet einen Angriff: zieht Soldaten ab und schickt ein Kriegsschiff zur
 * Zielinsel (Ziel braucht KEINEN Hafen — angelandet wird am Inselzentrum).
 */
export function startAttack(world, attacker, defender, soldiers, tick) {
  soldiers = Math.floor(Number(soldiers) || 0);
  if (soldiers < 1) throw new Error('Mindestens 1 Soldat');
  if (attacker.id === defender.id) throw new Error('Das ist deine eigene Insel');
  if (defender.active === false) throw new Error('Diese Insel ist unbewohnt');
  if (armyOf(attacker) < soldiers) throw new Error(`Nur ${armyOf(attacker)} Soldaten verfügbar`);
  const harbor = findHarbor(attacker);
  if (!harbor) throw new Error('Du brauchst einen ⚓ Hafen für Kriegsschiffe');
  const isl = (world.islands || []).find((i) => i.id === defender.islandId);
  if (!isl) throw new Error('Zielinsel nicht gefunden');

  attacker.resources.soldiers -= soldiers;
  const from = { islandId: attacker.islandId, x: harbor.x, y: harbor.y };
  const to = { islandId: isl.id, x: isl.x + Math.floor(isl.w / 2), y: isl.y + Math.floor(isl.h / 2) };
  const travel = Math.max(20, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / SHIP_SPEED));
  world.ships ??= [];
  world.nextShipId ??= 1;
  const ship = {
    id: world.nextShipId++, type: 'war',
    owner: attacker.id, toOwner: defender.id,
    from, to, cargo: { resourceId: 'soldiers', amount: soldiers },
    departTick: tick, arriveTick: tick + travel,
  };
  world.ships.push(ship);
  return ship;
}

/**
 * Löst die Schlacht bei Ankunft eines Kriegsschiffs auf. Mutiert Angreifer/
 * Verteidiger (+ Welt bei Eroberung). rng injizierbar (Tests).
 * @returns {{victory:boolean, report:string, conquered?:number}}
 */
export function resolveBattle(world, players, ship, registry, rng = Math.random) {
  const attacker = players.find((p) => p.id === ship.owner);
  const defender = players.find((p) => p.id === ship.toOwner);
  const soldiers = ship.cargo.amount;
  if (!attacker) return { victory: false, report: 'Angreifer existiert nicht mehr' };
  if (!defender || defender.active === false) {
    // Insel inzwischen unbewohnt → Truppen kehren heim
    attacker.resources.soldiers = (attacker.resources.soldiers || 0) + soldiers;
    return { victory: false, report: `${attacker.name}: Zielinsel war verlassen — Truppen kehren zurück.` };
  }

  const swing = () => 0.85 + rng() * 0.3; // ±15 % Kriegsglück
  const atk = soldiers * swing();
  const def = Math.max(1, defenseOf(defender, registry)) * swing();

  if (atk > def) {
    // Sieg: Überlebende garnisonieren; Insel wird erobert
    const survivors = Math.max(1, Math.floor(soldiers * (1 - (def / atk) * 0.7)));
    attacker.resources.soldiers = (attacker.resources.soldiers || 0) + survivors;
    conquerIsland(world, attacker, defender);
    const report = `⚔️ ${attacker.name} erobert die Insel von ${defender.name}! (${soldiers} Angreifer, ${survivors} überlebt)`;
    return { victory: true, report, conquered: defender.islandId };
  }

  // Niederlage: Angreifer verliert die Truppe, Verteidiger verliert anteilig Soldaten
  const ratio = Math.min(1, atk / def);
  defender.resources.soldiers = Math.max(0, Math.floor((defender.resources.soldiers || 0) * (1 - ratio * 0.6)));
  const report = `🛡️ ${defender.name} schlägt den Angriff von ${attacker.name} zurück (${soldiers} Angreifer gefallen).`;
  return { victory: false, report };
}

/**
 * Eroberung: Territorium, Gebäude, Straßen/Deko und die halbe Bevölkerung
 * gehen an den Sieger; der Verlierer ist besiegt (inaktiv).
 */
export function conquerIsland(world, winner, loser) {
  // Territorium erweitern (Mehr-Regionen: canPlace prüft state.regions)
  winner.regions = [...(winner.regions || (winner.region ? [winner.region] : []))];
  if (loser.region) winner.regions.push({ ...loser.region });

  // Gebäude übernehmen (unbemannt — der Sieger muss neu Arbeiter zuweisen)
  for (const inst of loser.instances || []) {
    winner.instances.push({ ...inst, id: winner.nextInstanceId++ });
    if (inst.counted) {
      const b = (winner.buildings[inst.buildingId] ??= { count: 0, workers: 0 });
      b.count += 1;
    }
  }
  // Straßen & Deko & Rodungen zusammenführen
  for (const k of loser.roads || []) winner.roads.add(k);
  for (const k of loser.cleared || []) winner.cleared.add(k);
  for (const [k, v] of Object.entries(loser.placed || {})) winner.placed[k] = v;
  // Halbe Bevölkerung schließt sich dem Sieger an (Wohnraum kommt mit den Häusern)
  winner.population = (winner.population || 0) + Math.floor((loser.population || 0) * 0.5);

  // Verlierer ist besiegt
  loser.active = false;
  loser.defeated = { by: winner.id, at: new Date().toISOString() };
  loser.instances = [];
  loser.buildings = {};
  loser.roads = new Set();
  loser.cleared = new Set();
  loser.placed = {};
  loser.population = 0;
  loser.resources = {};
}

/** Kriegs-Protokoll (geteilte Sicht, lebt in der Welt). */
export function logWar(world, report, tick) {
  world.warLog ??= [];
  world.warLog.push({ tick, report, at: new Date().toISOString() });
  if (world.warLog.length > 20) world.warLog = world.warLog.slice(-20);
}
