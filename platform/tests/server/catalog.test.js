import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, migrate } from '../../server/lib/db.js';
import { loadCatalog, CatalogError, catalogMeta } from '../../server/catalog/load.js';
import { createCatalogService } from '../../server/routes/catalog.js';
import { slug } from '../../server/catalog/slug.js';
import { selectGeneralRecommendations, firstSentence } from '../../server/routes/sessions.js';
import { tmpDir, copyFixtures, FIXTURES } from './helpers.js';

const freshDb = () => { const db = openDb(path.join(tmpDir(), 'c.sqlite')); migrate(db); return db; };
const rewrite = (dir, file, fn) => {
  const p = path.join(dir, file);
  fs.writeFileSync(p, JSON.stringify(fn(JSON.parse(fs.readFileSync(p, 'utf8')))));
  fs.rmSync(path.join(dir, 'manifest.json'), { force: true }); // edited files no longer match the manifest
};

test('slug reference implementation (CONTRACT §4)', () => {
  assert.equal(slug('Trocánter Menor (D)'), 'trocanter-menor');
  assert.equal(slug('  Riñón — Vejiga '), 'rinon-vejiga');
});

test('loads fixtures in one transaction, merges anatomy, and is idempotent', () => {
  const db = freshDb();
  const r = loadCatalog(db, { dir: FIXTURES });
  assert.equal(r.skipped, false);
  assert.equal(r.version, 'fixture-2');
  assert.deepEqual({ p: r.counts.points, pr: r.counts.pairs, e: r.counts.entities, pc: r.counts.protocols, s: r.counts.symptoms, c: r.counts.contraindications },
    { p: 12, pr: 6, e: 4, pc: 3, s: 6, c: 2 });
  const timo = db.get("SELECT * FROM points WHERE id = 'timo'");
  assert.equal(timo.region, 'thorax');
  assert.equal(timo.pos_y, 1.33);
  assert.equal(db.get("SELECT region FROM points WHERE id = 'trocanter-menor'").region, null, 'point without anatomy tolerated');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM pair_relations').n, 5);
  assert.equal(catalogMeta(db).version, 'fixture-2');
  const again = loadCatalog(db, { dir: FIXTURES });
  assert.equal(again.skipped, true, 'unchanged fingerprint skips');
  assert.equal(loadCatalog(db, { dir: FIXTURES, force: true }).skipped, false);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM pairs').n, 6, 'reload replaces, not duplicates');
  db.close();
});

test('nested protocol expands to an ordered, de-duplicated pair list', () => {
  const db = freshDb();
  loadCatalog(db, { dir: FIXTURES });
  const svc = createCatalogService(db);
  const p = svc.protocolExpanded('top10-gastrointestinal');
  assert.deepEqual(p.pairs.map((x) => x.pairId), ['pb-010', 'pb-030', 'pb-001', 'cx-rinon--vejiga']);
  assert.deepEqual(p.pairs[2].via, ['basic-detox']);
  assert.deepEqual(p.pairs[0].via, []);
  assert.deepEqual(svc.pairFull('pb-001').protocols.map((x) => x.id).sort(), ['basic-detox', 'top10-gastrointestinal']);
  db.close();
});

test('suggest ranks by symptom specificity x F rating plus free text', () => {
  const db = freshDb();
  loadCatalog(db, { dir: FIXTURES });
  const svc = createCatalogService(db);
  const r = svc.suggest({ symptoms: ['acidez'], text: '' });
  assert.deepEqual(r.map((x) => x.pairId), ['pb-030', 'pb-010'], 'F=3 outranks F=2 for the same symptom');
  const t = svc.suggest({ symptoms: [], text: 'tos seca' });
  assert.equal(t[0].pairId, 'pb-212');
  assert.equal(t[0].matched[0].type, 'text');
  const both = svc.suggest({ symptoms: ['cefalea', 'fiebre'], text: 'headache' });
  assert.equal(both[0].pairId, 'pb-045');
  assert.ok(both[0].matched.some((m) => m.type === 'symptom' && m.id === 'cefalea'));
  db.close();
});

test('search finds accent-insensitive matches across kinds', () => {
  const db = freshDb();
  loadCatalog(db, { dir: FIXTURES });
  const svc = createCatalogService(db);
  const kinds = svc.search('rinon').items.map((x) => `${x.kind}:${x.id}`);
  assert.ok(kinds.includes('point:rinon'));
  assert.ok(kinds.includes('pair:cx-rinon--vejiga'));
  assert.equal(svc.search('pb 30').items[0].id, 'pb-030');
  assert.ok(svc.search('helicobacter').items.some((x) => x.kind === 'entity'));
  db.close();
});

test('missing optional files are tolerated', () => {
  const dir = copyFixtures();
  for (const f of ['point-anatomy.json', 'regions.json', 'glossary.json', 'manifest.json', 'recommendations.json']) fs.rmSync(path.join(dir, f));
  const db = freshDb();
  const r = loadCatalog(db, { dir });
  assert.equal(r.counts.points, 12);
  assert.match(r.version, /^dev-/);
  db.close();
});

test('referential errors are reported clearly and nothing is written', () => {
  const dir = copyFixtures();
  rewrite(dir, 'pairs.json', (pairs) => { pairs[0].tracking.point = 'no-such-point'; pairs[1].relations.push({ entity: 'ghost' }); return pairs; });
  rewrite(dir, 'protocols.json', (ps) => { ps[0].items.push({ protocol: 'top10-gastrointestinal' }); return ps; }); // cycle
  rewrite(dir, 'symptoms.json', (s) => { s[0].pairs.push('pb-999'); return s; });
  const db = freshDb();
  let err;
  try { loadCatalog(db, { dir }); } catch (e) { err = e; }
  assert.ok(err instanceof CatalogError);
  const all = err.errors.join('\n');
  assert.match(all, /pairs\.json\[pb-001\]\.tracking\.point: unknown point "no-such-point"/);
  assert.match(all, /unknown entity "ghost"/);
  assert.match(all, /cycle detected/);
  assert.match(all, /symptoms\.json\[cefalea\]\.pairs: unknown pair "pb-999"/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM pairs').n, 0, 'transaction never started');
  // lenient mode drops the dangling references instead
  rewrite(dir, 'protocols.json', (ps) => { ps[0].items.pop(); return ps; });
  const r = loadCatalog(db, { dir, strict: false });
  assert.equal(r.counts.pairs, 5);
  assert.ok(r.warnings.some((w) => /no-such-point/.test(w)));
  db.close();
});

test('manifest sha256 mismatch and duplicate ids are errors', () => {
  const dir = copyFixtures();
  const p = path.join(dir, 'points.json');
  const pts = JSON.parse(fs.readFileSync(p, 'utf8'));
  pts.push({ ...pts[0] });
  fs.writeFileSync(p, JSON.stringify(pts));
  const db = freshDb();
  assert.throws(() => loadCatalog(db, { dir }), (e) => e.errors.some((x) => /sha256 mismatch for points\.json/.test(x)) && e.errors.some((x) => /duplicate id "timo"/.test(x)));
  db.close();
});

test('general recommendations are filtered to the found pairs', () => {
  const db = freshDb();
  loadCatalog(db, { dir: FIXTURES });
  const c = createCatalogService(db).get();
  assert.deepEqual(selectGeneralRecommendations(c, []).map((r) => r.id), ['general-short']);
  assert.deepEqual(selectGeneralRecommendations(c, ['pb-045']).map((r) => r.id), ['general-short', 'tropical'], '"Enf. Tropicales" -> tropical');
  assert.deepEqual(selectGeneralRecommendations(c, ['pb-001', 'pb-030']).map((r) => r.id), ['general-short', 'sti', 'good-eating']);
  const trop = selectGeneralRecommendations(c, ['pb-045'])[1];
  assert.equal(trop.summary.en, 'Tropical diseases are vector-borne (mosquitoes).');
  assert.deepEqual(firstSentence({ es: 'Corta.\nSegunda' }), { es: 'Corta.' });
  db.close();
});
