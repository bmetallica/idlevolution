// updates.md 5.3 — data/exports und data/rejected wuchsen unbegrenzt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneOldFiles, pruneArchives } from '../src/ai/retention.js';

async function fileAged(dir, name, days) {
  const p = path.join(dir, name);
  await writeFile(p, '{}');
  const t = new Date(Date.now() - days * 86400000);
  await utimes(p, t, t);
  return p;
}

test('pruneOldFiles löscht nur, was älter als die Aufbewahrung ist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ret-'));
  await fileAged(dir, 'alt.json', 45);
  await fileAged(dir, 'grenzwertig.json', 31);
  await fileAged(dir, 'frisch.json', 2);

  const removed = await pruneOldFiles(dir, 30);
  assert.equal(removed, 2);
  assert.deepEqual(await readdir(dir), ['frisch.json']);
});

test('pruneOldFiles: 0 Tage bedeutet "nie löschen"', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ret-'));
  await fileAged(dir, 'uralt.json', 999);
  assert.equal(await pruneOldFiles(dir, 0), 0);
  assert.equal((await readdir(dir)).length, 1);
});

test('pruneOldFiles verträgt fehlende Verzeichnisse', async () => {
  assert.equal(await pruneOldFiles('/gibt/es/nicht', 30), 0);
});

test('pruneArchives räumt exports und rejected, lässt generierte Packs unberührt', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'data-'));
  for (const sub of ['exports', 'rejected', 'content/generated/2026-01-01']) {
    await mkdir(path.join(dataDir, sub), { recursive: true });
  }
  await fileAged(path.join(dataDir, 'exports'), 'a.json', 60);
  await fileAged(path.join(dataDir, 'rejected'), 'b.json', 60);
  const packDir = path.join(dataDir, 'content/generated/2026-01-01');
  await fileAged(packDir, 'pack.json', 60);

  const removed = await pruneArchives(dataDir, 30);
  assert.equal(removed, 2);
  assert.deepEqual(await readdir(packDir), ['pack.json'], 'Content-Packs sind die Spielinhalte — nie löschen');
});
