// Stufe 4 der KI-Spieler-Roadmap: Schiffe & Transport zwischen Inseln.
// Schiffe transportieren Ladung (Ressourcen) von einem Hafen zu einer anderen
// Insel über den geteilten Ozean. Reine Funktionen — leben im world-Objekt
// (world.ships), damit sie auf der gemeinsamen Karte sichtbar sind.

export const SHIP_SPEED = 0.5; // Felder pro Tick

/** Erstes fertiges Hafen-Gebäude eines Spielers (oder null). */
export function findHarbor(player) {
  return (player.instances || []).find((i) => i.counted && i.buildingId === 'harbor') || null;
}

/**
 * Startet eine Lieferung: zieht die Ladung beim Absender ab und legt ein Schiff
 * an, das zur Zielinsel fährt. Mutiert world + fromPlayer. Wirft bei Fehler.
 */
/**
 * Legt ein Schiff von fromPlayer zu toPlayer an, OHNE Ware abzuziehen (die Ware
 * gilt als bereits reserviert/Treuhand — z.B. bei Handelsverträgen). Beide
 * brauchen einen Hafen.
 */
export function dispatchShip(world, fromPlayer, toPlayer, resourceId, amount, tick) {
  const fromHarbor = findHarbor(fromPlayer);
  const toHarbor = findHarbor(toPlayer);
  if (!fromHarbor || !toHarbor) throw new Error('Beide Inseln brauchen einen Hafen');
  const from = { islandId: fromPlayer.islandId, x: fromHarbor.x, y: fromHarbor.y };
  const to = { islandId: toPlayer.islandId, x: toHarbor.x, y: toHarbor.y };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const travel = Math.max(20, Math.ceil(dist / SHIP_SPEED));
  world.ships ??= [];
  world.nextShipId ??= 1;
  const ship = {
    id: world.nextShipId++,
    owner: fromPlayer.id, toOwner: toPlayer.id,
    from, to, cargo: { resourceId, amount: Math.floor(amount) },
    departTick: tick, arriveTick: tick + travel,
  };
  world.ships.push(ship);
  return ship;
}

export function createShipment(world, players, fromPlayer, toIslandId, resourceId, amount, tick) {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) throw new Error('Menge muss größer 0 sein');
  if (!findHarbor(fromPlayer)) throw new Error('Du brauchst einen Hafen');
  const toPlayer = players.find((p) => p.islandId === Number(toIslandId) && p.active !== false);
  if (!toPlayer) throw new Error('Zielinsel hat keinen aktiven Bewohner');
  if (toPlayer.id === fromPlayer.id) throw new Error('Das ist deine eigene Insel');
  if (!findHarbor(toPlayer)) throw new Error('Zielinsel hat keinen Hafen');
  if ((fromPlayer.resources[resourceId] || 0) < amount) throw new Error(`Nicht genug ${resourceId}`);
  fromPlayer.resources[resourceId] -= amount;
  return dispatchShip(world, fromPlayer, toPlayer, resourceId, amount, tick);
}

/** Interpolierte Weltposition eines Schiffs (für das Rendering). */
export function shipPosition(ship, tick) {
  const span = Math.max(1, ship.arriveTick - ship.departTick);
  const t = Math.max(0, Math.min(1, (tick - ship.departTick) / span));
  return { x: ship.from.x + (ship.to.x - ship.from.x) * t, y: ship.from.y + (ship.to.y - ship.from.y) * t };
}

/**
 * Rückt alle Schiffe vor; liefert angekommene Ladung an den Zielspieler aus und
 * entfernt die Schiffe. Gibt die zugestellten Schiffe zurück (für Ereignisse).
 */
export function tickShips(world, players, tick) {
  const delivered = [];
  if (!world.ships?.length) return delivered;
  world.ships = world.ships.filter((ship) => {
    if (tick >= ship.arriveTick) {
      // Kriegsschiffe (Stufe 6) liefern keine Fracht aus — die Schlacht wird
      // vom Aufrufer über resolveBattle() geschlagen.
      if (ship.type !== 'war') {
        const dest = players.find((p) => p.id === ship.toOwner);
        if (dest) dest.resources[ship.cargo.resourceId] = (dest.resources[ship.cargo.resourceId] || 0) + ship.cargo.amount;
      }
      delivered.push(ship);
      return false;
    }
    return true;
  });
  return delivered;
}
