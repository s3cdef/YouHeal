// Reports which point ids in data/catalog/points.json (Data team) lack an entry
// in data/catalog/point-anatomy.json (Anatomy team), plus anatomy-only ids.
// Usage: node tests/viewer3d/coverage.mjs [--json]   (exit code 1 when gaps exist)
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cat = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const anatomy = JSON.parse(await readFile(join(cat, 'point-anatomy.json'), 'utf8'));
let points;
try { points = JSON.parse(await readFile(join(cat, 'points.json'), 'utf8')); } catch {
  console.log('data/catalog/points.json not found — nothing to compare yet.');
  process.exit(0);
}
const ids = new Set(points.map((p) => p.id));
const missing = points.filter((p) => !anatomy[p.id]);
const slug = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const aliasOf = new Map();
for (const p of points) for (const a of p.aliases || []) aliasOf.set(slug(a), p.id);
const extraAll = Object.keys(anatomy).filter((k) => k !== 'subpoints' && !ids.has(k));
const aliasKeys = extraAll.filter((k) => aliasOf.has(k));
const extra = extraAll.filter((k) => !aliasOf.has(k));
const latMismatch = points.filter((p) => anatomy[p.id] && p.laterality === 'bilateral' && anatomy[p.id].pos.x > 0);
const pct = ((points.length - missing.length) / points.length * 100).toFixed(1);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: points.length, covered: points.length - missing.length, missing: missing.map((p) => p.id), aliasKeys, extra, bilateralWithPositiveX: latMismatch.map((p) => p.id) }, null, 1));
} else {
  console.log(`Anatomy coverage: ${points.length - missing.length}/${points.length} (${pct}%)`);
  if (missing.length) { console.log(`\nMissing anatomy (${missing.length}):`); for (const p of missing) console.log(`  ${p.id.padEnd(34)} ${p.name?.es || ''} / ${p.name?.en || ''} [${p.laterality}]`); }
  if (latMismatch.length) { console.log(`\nBilateral points whose pos is not patient-RIGHT (x<0):`); for (const p of latMismatch) console.log(`  ${p.id}`); }
  if (aliasKeys.length) console.log(`\nAlias keys resolving to points.json ids (${aliasKeys.length}): ${aliasKeys.join(', ')}`);
  if (extra.length) console.log(`\nAnatomy ids unknown to points.json (${extra.length}): ${extra.join(', ')}`);
}
process.exit(missing.length ? 1 : 0);
