// Trockenlauf der Mehr-Insel-Migration: liest den echten Spielstand, baut die
// Welt und bettet den Alt-Stand ein — SCHREIBT NICHTS. Nur zur Verifikation vor
// dem echten Deploy. Ausführen: docker compose run --rm app node src/migrate-dryrun.mjs
import { config } from './config.js';
import { pool } from './db/index.js';
import { createRegistryHolder } from './content/loader.js';
import { loadGameConfig, loadState } from './engine/state.js';
import { buildWorldFromLegacy, embedLegacyState, islandAt } from './engine/world.js';

const { game } = await loadGameConfig(config.dataDir);
const holder = createRegistryHolder(config.dataDir, { warn() {}, info() {} });
await holder.reload();

const legacy = await loadState(pool, game, holder.registry);
console.log(`LEGACY: Karte ${legacy.map.width}x${legacy.map.height} | Instanzen ${legacy.instances.length} | Bevölkerung ${Math.round(legacy.population)} | Epoche ${legacy.epochId} | Straßen ${legacy.roads.size}`);

const world = buildWorldFromLegacy(legacy.map, { islandCount: 5, islandSize: 44, gap: 18 });
console.log(`WORLD:  ${world.width}x${world.height} | Inseln ${world.islands.map((i) => `#${i.id}@(${i.x},${i.y}) ${i.w}x${i.h}`).join('  ')}`);

const emb = embedLegacyState(legacy, world);
const isl0 = world.islands[0];
const isWater = (x, y) => world.tiles[y * world.width + x] === 'W';
let outside = 0, onWater = 0, terrainMismatch = 0;
for (const i of emb.instances) {
  if (islandAt(world, i.x, i.y) !== 0) outside++;
  if (isWater(i.x, i.y)) onWater++;
  // Terrain unter dem Gebäude muss dem Alt-Terrain entsprechen (kein Offset-Fehler)
  const lx = i.x - isl0.x, ly = i.y - isl0.y;
  if (legacy.map.tiles[ly * legacy.map.width + lx] !== world.tiles[i.y * world.width + i.x]) terrainMismatch++;
}
console.log(`EMBED:  Spieler0 Instanzen ${emb.instances.length} | Region ${JSON.stringify(emb.region)} | Bevölkerung ${Math.round(emb.population)} | außerhalb ${outside} | auf Wasser ${onWater} | Terrain-Mismatch ${terrainMismatch}`);
console.log(outside === 0 && onWater === 0 && terrainMismatch === 0 ? '✅ TROCKENLAUF OK — Migration ist sicher' : '❌ TROCKENLAUF-PROBLEM');

await pool.end();
