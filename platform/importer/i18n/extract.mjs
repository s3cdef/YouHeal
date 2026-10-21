#!/usr/bin/env node
// Builds the mirrored language packs from the Spanish baseline catalog:
//   data/i18n/packs/es/catalog.json   baseline  { key: { text, hash } }
//   data/i18n/packs/en/catalog.json   mirror    { key: { text|null, srcHash, status } }   (existing entries preserved)
//   data/i18n/_work/queue/chunk-NN.json   unique untranslated Spanish texts [{ h, es }] for translators
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localizedFields, srcHash, sortKeys } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAT = join(root, 'data', 'catalog');
const PACKS = join(root, 'data', 'i18n', 'packs');
const target = process.argv[2] || 'en';
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS || 60000);

const baseline = {}, mirrorPath = join(PACKS, target, 'catalog.json');
const prev = existsSync(mirrorPath) ? JSON.parse(readFileSync(mirrorPath, 'utf8')) : {};
const mirror = {};
for (const { key, node } of localizedFields(CAT)) {
  const h = srcHash(node.es);
  baseline[key] = { text: node.es, hash: h };
  const old = prev[key];
  if (old && old.srcHash === h && old.text && old.status !== 'curated') mirror[key] = old; // keep machine/reviewed translation
  else if (node[target]) mirror[key] = { text: node[target], srcHash: h, status: 'curated' };
  else mirror[key] = { text: null, srcHash: h, status: old?.text ? 'stale' : 'missing', ...(old?.text ? { previous: old.text } : {}) };
}
for (const [loc, data] of [['es', baseline], [target, mirror]]) {
  mkdirSync(join(PACKS, loc), { recursive: true });
  writeFileSync(join(PACKS, loc, 'catalog.json'), JSON.stringify(sortKeys(data), null, 1) + '\n');
}
// translation queue: unique source texts still lacking a translation
const need = new Map();
for (const [k, v] of Object.entries(mirror)) if (!v.text) need.set(v.srcHash, baseline[k].text);
const qdir = join(root, 'data', 'i18n', '_work', target, 'queue');
rmSync(qdir, { recursive: true, force: true }); mkdirSync(qdir, { recursive: true });
let chunk = [], size = 0, n = 0;
const flush = () => { if (!chunk.length) return; writeFileSync(join(qdir, `chunk-${String(++n).padStart(2, '0')}.json`), JSON.stringify(chunk, null, 1) + '\n'); chunk = []; size = 0; };
for (const [h, es] of [...need.entries()].sort((a, b) => a[1].length - b[1].length)) {
  if (size + es.length > CHUNK_CHARS) flush();
  chunk.push({ h, es }); size += es.length;
}
flush();
const total = Object.keys(mirror).length, done = Object.values(mirror).filter((v) => v.text).length;
console.log(`${target}: ${done}/${total} fields translated; ${need.size} unique texts queued in ${n} chunks (${qdir})`);
