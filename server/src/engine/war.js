// Stufe 6 der KI-Spieler-Roadmap: Kriegssystem (v2 — Raubzüge im Tagesrhythmus).
//
// Design-Entscheidungen (User):
//  - KEINE Eroberung: jede Insel bleibt für immer bei ihrem Besitzer.
//    Kämpfe sind Raubzüge — der Sieger plündert Beute, mehr nicht.
//  - Kampfhandlungen laufen im TAGES-/KI-RHYTHMUS: tagsüber werden Angriffe
//    nur ERKLÄRT (öffentlich sichtbar, stornierbar), die Schlacht schlägt
//    sich beim nächtlichen KI-Lauf. So bleibt es fair — der Echtzeit-Mensch
//    kann die Tageszug-KI nicht in Sekunden überrennen, und die KI kann im
//    selben Rhythmus Vergeltung üben.

export const MILITIA_PER_POP = 0.05; // jede Insel wehrt sich: 5 % der Bevölkerung als Miliz
export const LOOT_PER_SOLDIER = 10; // Tragkraft: Beute je überlebendem Angreifer
export const LOOT_MAX_SHARE = 0.25; // höchstens 25 % je Vorrat sind plünderbar

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
 * Kriegserklärung: stellt Soldaten verbindlich ab (Treuhand) und kündigt den
 * Raubzug öffentlich an — die Schlacht schlägt sich beim nächtlichen KI-Lauf.
 */
export const MIN_RAID_TROOPS = 5; // verhindert 1-Mann-Spam-Erklärungen

export function declareWar(world, attacker, defender, soldiers) {
  soldiers = Math.floor(Number(soldiers) || 0);
  if (soldiers < MIN_RAID_TROOPS) throw new Error(`Ein Raubzug braucht mindestens ${MIN_RAID_TROOPS} Soldaten`);
  if (attacker.id === defender.id) throw new Error('Das ist deine eigene Insel');
  if (defender.active === false) throw new Error('Diese Insel ist unbewohnt');
  if (armyOf(attacker) < soldiers) throw new Error(`Nur ${armyOf(attacker)} Soldaten verfügbar`);
  world.warDeclarations ??= [];
  if (world.warDeclarations.some((d) => d.attackerId === attacker.id && d.defenderId === defender.id)) {
    throw new Error('Du hast diesem Nachbarn bereits den Krieg erklärt');
  }
  attacker.resources.soldiers -= soldiers;
  const decl = { attackerId: attacker.id, defenderId: defender.id, soldiers, declaredAt: new Date().toISOString() };
  world.warDeclarations.push(decl);
  return decl;
}

/** Kriegserklärung zurückziehen (vor der Nacht) — Soldaten kehren zurück. */
export function cancelDeclaration(world, attacker, defenderId) {
  const i = (world.warDeclarations || []).findIndex((d) => d.attackerId === attacker.id && d.defenderId === Number(defenderId));
  if (i < 0) throw new Error('Keine Kriegserklärung gefunden');
  const [decl] = world.warDeclarations.splice(i, 1);
  attacker.resources.soldiers = (attacker.resources.soldiers || 0) + decl.soldiers;
  return decl;
}

/** Plünderbare Vorräte (Soldaten & Co. nicht — nur echte Waren). */
function lootable(registry, rid) {
  const cat = registry.resources.get(rid)?.category;
  return cat && cat !== 'special';
}

/**
 * Nächtliche Auflösung ALLER Kriegserklärungen (vom KI-Lauf aufgerufen).
 * Sieger plündern Beute, beide Seiten verlieren Soldaten, Inseln bleiben
 * IMMER beim Besitzer. Angegriffene KI-Spieler erklären ggf. Vergeltung
 * für die nächste Nacht. rng injizierbar (Tests).
 * @returns {string[]} Berichte fürs Kriegs-Protokoll
 */
export function resolveWars(world, players, registry, rng = Math.random) {
  const decls = world.warDeclarations || [];
  const retaliations = [];
  const reports = [];
  const swing = () => 0.85 + rng() * 0.3; // ±15 % Kriegsglück

  for (const decl of decls) {
    const attacker = players.find((p) => p.id === decl.attackerId);
    const defender = players.find((p) => p.id === decl.defenderId);
    if (!attacker || attacker.active === false) continue; // Angreifer weg → Truppe verfällt
    if (!defender || defender.active === false) {
      attacker.resources.soldiers = (attacker.resources.soldiers || 0) + decl.soldiers;
      reports.push(`${attacker.name}: Zielinsel war verlassen — Truppen kehren zurück.`);
      continue;
    }

    const atk = Math.max(1, decl.soldiers * swing());
    const def = Math.max(1, defenseOf(defender, registry) * swing());

    // Verluste proportional zum Kräfteverhältnis (beide Seiten bluten)
    const attackerLosses = Math.min(decl.soldiers, Math.round(decl.soldiers * Math.min(1, def / atk) * 0.5));
    const survivors = decl.soldiers - attackerLosses;
    const defenderLosses = Math.min(armyOf(defender), Math.round(armyOf(defender) * Math.min(1, atk / def) * 0.5));
    defender.resources.soldiers = Math.max(0, (defender.resources.soldiers || 0) - defenderLosses);
    attacker.resources.soldiers = (attacker.resources.soldiers || 0) + survivors; // Heimkehrer

    if (atk > def && survivors > 0) {
      // Raubzug erfolgreich: Beute bis zur Tragkraft, max. 25 % je Vorrat
      let capacity = survivors * LOOT_PER_SOLDIER;
      const stocks = Object.entries(defender.resources || {})
        .filter(([rid, amt]) => amt >= 1 && lootable(registry, rid))
        .sort((a, b) => b[1] - a[1]);
      const looted = [];
      for (const [rid, amt] of stocks) {
        if (capacity <= 0) break;
        const take = Math.min(Math.floor(amt * LOOT_MAX_SHARE), capacity);
        if (take < 1) continue;
        defender.resources[rid] -= take;
        attacker.resources[rid] = (attacker.resources[rid] || 0) + take;
        capacity -= take;
        looted.push(`${take} ${rid}`);
      }
      reports.push(`⚔️ ${attacker.name} plündert ${defender.name}: ${looted.length ? looted.join(', ') : 'keine Beute'} (${attackerLosses} Angreifer, ${defenderLosses} Verteidiger gefallen)`);
    } else {
      reports.push(`🛡️ ${defender.name} wehrt den Raubzug von ${attacker.name} ab (${attackerLosses} Angreifer, ${defenderLosses} Verteidiger gefallen)`);
    }

    // Vergeltung im Tagesrhythmus: eine angegriffene KI schlägt in der
    // nächsten Nacht zurück, wenn sie noch kampffähig ist.
    if (defender.kind === 'ai' && armyOf(defender) >= 3 && attacker.active !== false) {
      const troops = Math.max(1, Math.floor(armyOf(defender) / 2));
      defender.resources.soldiers -= troops;
      retaliations.push({ attackerId: defender.id, defenderId: attacker.id, soldiers: troops, declaredAt: new Date().toISOString(), retaliation: true });
      reports.push(`🔥 ${defender.name} schwört Vergeltung — ${troops} Soldaten marschieren morgen Nacht gegen ${attacker.name}.`);
    }
  }

  world.warDeclarations = retaliations;
  return reports;
}

/** Kriegs-Protokoll (geteilte Sicht, lebt in der Welt). */
export function logWar(world, report, tick) {
  world.warLog ??= [];
  world.warLog.push({ tick, report, at: new Date().toISOString() });
  if (world.warLog.length > 20) world.warLog = world.warLog.slice(-20);
}
