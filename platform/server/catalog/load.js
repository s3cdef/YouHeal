// Catalog loader: data/catalog/*.json (CONTRACT §4) -> catalog tables, in ONE transaction.
// Idempotent: skipped when the content fingerprint (sha256 of every catalog file) is unchanged.
// Usage (CLI): npm run catalog:load -- [--dir <path>] [--force] [--lenient]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeText } from '../lib/crypto.js';
import { slug } from './slug.js';

export const FILES = Object.freeze({
  sources: 'sources.json',
  points: 'points.json',
  anatomy: 'point-anatomy.json',
  regions: 'regions.json',
  entities: 'entities.json',
  pairs: 'pairs.json',
  protocols: 'protocols.json',
  symptoms: 'symptoms.json',
  contraindications: 'contraindications.json',
  recommendations: 'recommendations.json',
  glossary: 'glossary.json',
  manifest: 'manifest.json',
});
const REQUIRED = new Set(['points', 'pairs']);

export const CATEGORIES = ['virus', 'bacteria', 'fungus', 'parasite', 'dysfunctional', 'psychoemotional', 'reservoir',
  'complex', 'prion', 'special', 'temporary', 'glandular-dysfunction'];
export const SYSTEMS = ['general', 'respiratory', 'gastrointestinal', 'neurological', 'musculoskeletal', 'urological',
  'cardiological', 'gynecological', 'endocrine', 'hematological', 'dermatological', 'ophthalmological', 'auditory',
  'immunological', 'psychiatric', 'oncological', 'dental', 'tropical', 'toxicological'];
export const SIDES = ['R', 'L', 'C', 'RL'];
export const QUALIFIERS = ['S', 'INF', 'A', 'P', 'LAT'];
export const VIEWS = ['anterior', 'posterior', 'lateral', 'superior', 'inferior', 'internal'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export class CatalogError extends Error {
  constructor(errors, warnings = []) {
    const shown = errors.slice(0, 40).map((e) => `  - ${e}`).join('\n');
    super(`Catalog validation failed with ${errors.length} error(s):\n${shown}${errors.length > 40 ? `\n  ... and ${errors.length - 40} more` : ''}`);
    this.code = 'CATALOG_INVALID';
    this.errors = errors;
    this.warnings = warnings;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isLoc = (v) => v && typeof v === 'object' && !Array.isArray(v) && (typeof v.es === 'string' || typeof v.en === 'string');
const locText = (v) => (isLoc(v) ? [v.en, v.es].filter(Boolean).join(' ') : '');
const J = (v) => JSON.stringify(v ?? null);

function readFiles(dir) {
  const raw = {}, data = {}, hashes = {}, errors = [];
  if (!fs.existsSync(dir)) throw new CatalogError([`catalog directory not found: ${dir}`]);
  for (const [key, file] of Object.entries(FILES)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      if (REQUIRED.has(key)) errors.push(`${file}: required file is missing`);
      continue;
    }
    raw[key] = fs.readFileSync(p);
    hashes[file] = sha256(raw[key]);
    try { data[key] = JSON.parse(raw[key].toString('utf8')); } catch (e) { errors.push(`${file}: invalid JSON (${e.message})`); }
  }
  if (errors.length) throw new CatalogError(errors);
  return { data, hashes };
}

export function fingerprintOf(hashes) {
  return sha256(Object.keys(hashes).sort().map((f) => `${f}:${hashes[f]}`).join('\n'));
}

/**
 * Validate & normalize. Returns { model, errors, warnings }. In lenient mode dangling references are
 * dropped (recorded as warnings) instead of failing the load.
 */
export function buildModel(data, hashes, { strict = true } = {}) {
  const errors = [], warnings = [];
  const ref = (msg) => (strict ? errors : warnings).push(msg);
  const arr = (key) => {
    const v = data[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) { errors.push(`${FILES[key]}: expected a JSON array`); return []; }
    return v;
  };
  const uniq = (key, list, idOf = (x) => x?.id) => {
    const map = new Map();
    list.forEach((x, i) => {
      const id = idOf(x);
      if (typeof id !== 'string' || !ID_RE.test(id)) { errors.push(`${FILES[key]}[${i}]: invalid id ${JSON.stringify(id)}`); return; }
      if (map.has(id)) { errors.push(`${FILES[key]}: duplicate id "${id}"`); return; }
      map.set(id, x);
    });
    return map;
  };

  // manifest integrity
  const manifest = data.manifest && typeof data.manifest === 'object' ? data.manifest : null;
  if (manifest?.sha256 && typeof manifest.sha256 === 'object') {
    for (const [f, h] of Object.entries(manifest.sha256)) {
      if (!hashes[f]) warnings.push(`manifest.json lists ${f} but the file is missing`);
      else if (String(h).toLowerCase() !== hashes[f]) errors.push(`manifest.json: sha256 mismatch for ${f} (file changed after the manifest was generated)`);
    }
  }

  const sources = uniq('sources', arr('sources'));
  for (const [id, s] of sources) {
    if (!['internal-use', 'licensed', 'public-domain', 'original'].includes(s.license_status)) errors.push(`sources.json[${id}]: invalid license_status`);
    if (typeof s.title !== 'string') errors.push(`sources.json[${id}]: title is required`);
  }
  const checkSource = (file, id, src) => {
    if (!src) return;
    if (typeof src !== 'object' || typeof src.doc !== 'string') { warnings.push(`${file}[${id}]: malformed source`); return; }
    if (sources.size && !sources.has(src.doc)) ref(`${file}[${id}].source.doc: unknown source "${src.doc}"`);
  };

  const regions = uniq('regions', arr('regions'));
  for (const [id, r] of regions) {
    if (!isLoc(r.name)) errors.push(`regions.json[${id}]: name must be a localized object`);
    if (r.parent != null && !regions.has(r.parent)) warnings.push(`regions.json[${id}]: unknown parent "${r.parent}"`);
  }

  const points = uniq('points', arr('points'));
  for (const [id, p] of points) {
    if (!isLoc(p.name)) errors.push(`points.json[${id}]: name must be a localized object`);
    else if (!p.name.en) warnings.push(`points.json[${id}]: name.en missing`);
    if (!['central', 'bilateral'].includes(p.laterality)) errors.push(`points.json[${id}]: laterality must be central|bilateral`);
    checkSource('points.json', id, p.source);
  }
  const anatomy = data.anatomy && typeof data.anatomy === 'object' && !Array.isArray(data.anatomy) ? data.anatomy : {};
  if (data.anatomy !== undefined && anatomy !== data.anatomy) errors.push('point-anatomy.json: expected an object keyed by point id');
  // Source-spelling aliases (e.g. "bulbo-raquideno") and reserved keys ("subpoints", "_…") are expected
  // in point-anatomy.json for the viewer's benefit; they are skipped silently, only true unknowns warn.
  const aliasSlugs = new Set();
  for (const p of points.values()) for (const al of p.aliases || []) aliasSlugs.add(slug(al));
  for (const [pid, a] of Object.entries(anatomy)) {
    if (pid === 'subpoints' || pid.startsWith('_')) continue;
    if (!points.has(pid)) { if (!aliasSlugs.has(pid)) warnings.push(`point-anatomy.json[${pid}]: unknown point (ignored)`); continue; }
    if (a.region && regions.size && !regions.has(a.region)) warnings.push(`point-anatomy.json[${pid}]: unknown region "${a.region}"`);
    if (a.view && !VIEWS.includes(a.view)) warnings.push(`point-anatomy.json[${pid}]: unknown view "${a.view}"`);
    if (a.pos && !['x', 'y', 'z'].every((k) => Number.isFinite(a.pos[k]))) errors.push(`point-anatomy.json[${pid}]: pos must have numeric x,y,z`);
  }

  const entities = uniq('entities', arr('entities'));
  for (const [id, e] of entities) {
    if (!isLoc(e.name)) errors.push(`entities.json[${id}]: name must be a localized object`);
    if (!['pathogen', 'condition', 'named-pair'].includes(e.kind)) errors.push(`entities.json[${id}]: kind must be pathogen|condition|named-pair`);
    if (e.classification && !CATEGORIES.includes(e.classification)) warnings.push(`entities.json[${id}]: unknown classification "${e.classification}"`);
    checkSource('entities.json', id, e.source);
  }

  const pairs = uniq('pairs', arr('pairs'));
  const droppedPairs = new Set();
  for (const [id, p] of pairs) {
    let fatal = false;
    if (!isLoc(p.name)) errors.push(`pairs.json[${id}]: name must be a localized object`);
    for (const role of ['tracking', 'impact']) {
      const end = p[role];
      if (!end || typeof end.point !== 'string') { errors.push(`pairs.json[${id}].${role}: point is required`); fatal = true; continue; }
      if (!points.has(end.point)) { ref(`pairs.json[${id}].${role}.point: unknown point "${end.point}"`); fatal = true; }
      if (end.side !== undefined && !SIDES.includes(end.side)) errors.push(`pairs.json[${id}].${role}.side: must be one of ${SIDES.join('|')}`);
      for (const q of end.qualifiers || []) if (!QUALIFIERS.includes(q)) errors.push(`pairs.json[${id}].${role}.qualifiers: unknown qualifier "${q}"`);
    }
    if (p.category && !CATEGORIES.includes(p.category)) warnings.push(`pairs.json[${id}]: unknown category "${p.category}"`);
    if (p.number != null && !Number.isInteger(p.number)) errors.push(`pairs.json[${id}]: number must be an integer`);
    for (const k of ['F', 'P', 'R']) {
      const v = p.ratings?.[k];
      if (v != null && !(Number.isInteger(v) && v >= 0 && v <= 3)) errors.push(`pairs.json[${id}].ratings.${k}: must be 0..3`);
    }
    p.relations = (p.relations || []).filter((r) => {
      if (!r || !entities.has(r.entity)) { ref(`pairs.json[${id}].relations: unknown entity "${r?.entity}"`); return false; }
      return true;
    });
    for (const s of p.symptoms || []) {
      if (!isLoc(s?.text)) errors.push(`pairs.json[${id}].symptoms: text must be a localized object`);
      if (s?.system && !SYSTEMS.includes(s.system)) warnings.push(`pairs.json[${id}].symptoms: unknown system "${s.system}"`);
    }
    checkSource('pairs.json', id, p.source);
    if (fatal) droppedPairs.add(id);
  }
  if (!strict) for (const id of droppedPairs) pairs.delete(id);

  for (const [id, e] of entities) {
    e.polePairs = (e.polePairs || []).filter((pp, i) => {
      if (!pp || !points.has(pp.neg) || !points.has(pp.pos)) { ref(`entities.json[${id}].polePairs[${i}]: unknown point "${!points.has(pp?.neg) ? pp?.neg : pp?.pos}"`); return false; }
      if (pp.pairId && !pairs.has(pp.pairId)) { ref(`entities.json[${id}].polePairs[${i}]: unknown pair "${pp.pairId}"`); pp.pairId = null; }
      return true;
    });
  }

  const protocols = uniq('protocols', arr('protocols'));
  for (const [id, pr] of protocols) {
    if (!['basic', 'top10', 'top5', 'disease', 'application'].includes(pr.kind)) errors.push(`protocols.json[${id}]: kind must be basic|top10|top5|disease|application`);
    if (!isLoc(pr.name)) errors.push(`protocols.json[${id}]: name must be a localized object`);
    if (!Array.isArray(pr.items)) { errors.push(`protocols.json[${id}]: items must be an array`); pr.items = []; }
    pr.items = pr.items.filter((it, i) => {
      const isPair = typeof it?.pair === 'string', isProt = typeof it?.protocol === 'string';
      if (isPair === isProt) { errors.push(`protocols.json[${id}].items[${i}]: exactly one of pair|protocol is required`); return false; }
      if (isPair && !pairs.has(it.pair)) { ref(`protocols.json[${id}].items[${i}]: unknown pair "${it.pair}"`); return false; }
      if (isProt && !protocols.has(it.protocol)) { ref(`protocols.json[${id}].items[${i}]: unknown protocol "${it.protocol}"`); return false; }
      return true;
    });
    checkSource('protocols.json', id, pr.source);
  }
  // cycle detection
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { errors.push(`protocols.json: cycle detected ${[...trail, id].join(' -> ')}`); return; }
    state.set(id, 1);
    for (const it of protocols.get(id)?.items || []) if (it.protocol) visit(it.protocol, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of protocols.keys()) visit(id, []);
  for (const [id, e] of entities) {
    e.protocols = (e.protocols || []).filter((pid) => {
      if (!protocols.has(pid)) { ref(`entities.json[${id}].protocols: unknown protocol "${pid}"`); return false; }
      return true;
    });
  }

  const symptoms = uniq('symptoms', arr('symptoms'));
  for (const [id, s] of symptoms) {
    if (!isLoc(s.name)) errors.push(`symptoms.json[${id}]: name must be a localized object`);
    if (s.system && !SYSTEMS.includes(s.system)) warnings.push(`symptoms.json[${id}]: unknown system "${s.system}"`);
    s.pairs = (s.pairs || []).filter((pid) => {
      if (!pairs.has(pid)) { ref(`symptoms.json[${id}].pairs: unknown pair "${pid}"`); return false; }
      return true;
    });
  }

  const contraindications = uniq('contraindications', arr('contraindications'));
  for (const [id, c] of contraindications) {
    if (!['absolute', 'relative'].includes(c.kind)) errors.push(`contraindications.json[${id}]: kind must be absolute|relative`);
    if (!isLoc(c.text)) errors.push(`contraindications.json[${id}]: text must be a localized object`);
  }
  const recommendations = uniq('recommendations', arr('recommendations'));
  const glossary = arr('glossary').filter((g, i) => {
    if (!g || typeof g.abbr !== 'string') { errors.push(`glossary.json[${i}]: abbr is required`); return false; }
    return true;
  });

  const fingerprint = fingerprintOf(hashes);
  const version = (manifest && typeof manifest.version === 'string' && manifest.version) || `dev-${fingerprint.slice(0, 12)}`;
  return {
    errors, warnings,
    model: { manifest, version, fingerprint, hashes, sources, regions, points, anatomy, entities, pairs, protocols, symptoms, contraindications, recommendations, glossary },
  };
}

function writeModel(db, m) {
  const G = 'org_id IS NULL';
  // children first (FKs are deferred, but keep deletes ordered for adapters without deferral)
  for (const t of ['catalog_search', 'symptom_pairs', 'protocol_items', 'entity_pole_pairs', 'pair_symptoms', 'pair_relations']) db.run(`DELETE FROM ${t}`);
  if (db.hasFts5) db.run('DELETE FROM catalog_fts');
  for (const t of ['symptoms', 'protocols', 'pairs', 'entities', 'points', 'regions', 'contraindications', 'recommendations', 'glossary', 'catalog_sources']) db.run(`DELETE FROM ${t} WHERE ${G}`);

  const search = (kind, id, parts) => {
    const body = normalizeText(parts.filter(Boolean).join(' '));
    db.run('INSERT OR REPLACE INTO catalog_search (kind, ref_id, body) VALUES (?,?,?)', kind, id, body);
    if (db.hasFts5) db.run('INSERT INTO catalog_fts (kind, ref_id, body) VALUES (?,?,?)', kind, id, body);
  };

  for (const [id, s] of m.sources) db.run('INSERT INTO catalog_sources (id, title, author, license_status, notice, data) VALUES (?,?,?,?,?,?)', id, s.title, s.author ?? null, s.license_status, s.notice ?? null, J(s));
  let i = 0;
  for (const [id, r] of m.regions) db.run('INSERT INTO regions (id, name, parent, sort, data) VALUES (?,?,?,?,?)', id, J(r.name), r.parent ?? null, i++, J(r));
  i = 0;
  for (const [id, p] of m.points) {
    const a = m.anatomy[id] || {};
    db.run(`INSERT INTO points (id, name, name_norm, aliases, laterality, region, view, pos_x, pos_y, pos_z, source, sort, data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, J(p.name), normalizeText(locText(p.name)), J(p.aliases || []), p.laterality,
    a.region ?? null, a.view ?? null, a.pos?.x ?? null, a.pos?.y ?? null, a.pos?.z ?? null, J(p.source ?? null), i++, J(p));
    search('point', id, [locText(p.name), ...(p.aliases || [])]);
  }
  for (const [id, e] of m.entities) {
    db.run('INSERT INTO entities (id, name, name_norm, kind, classification, source_doc, data) VALUES (?,?,?,?,?,?,?)',
      id, J(e.name), normalizeText(locText(e.name)), e.kind, e.classification ?? null, e.source?.doc ?? null, J(e));
    search('entity', id, [locText(e.name), (e.aliases || []).join(' ')]);
  }
  i = 0;
  for (const [id, p] of m.pairs) {
    db.run(`INSERT INTO pairs (id, number, level, name, name_norm, tracking_point, tracking_side, tracking_qualifiers,
      impact_point, impact_side, impact_qualifiers, category, rating_f, rating_p, rating_r, source_doc, sort, data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, p.number ?? null, p.level ?? 0, J(p.name), normalizeText(locText(p.name)),
    p.tracking.point, p.tracking.side || 'C', J(p.tracking.qualifiers || []), p.impact.point, p.impact.side || 'C', J(p.impact.qualifiers || []),
    p.category ?? null, p.ratings?.F ?? null, p.ratings?.P ?? null, p.ratings?.R ?? null, p.source?.doc ?? null, i++, J(p));
    p.relations.forEach((r, k) => db.run('INSERT OR IGNORE INTO pair_relations (pair_id, entity_id, ordinal, sort) VALUES (?,?,?,?)', id, r.entity, r.ordinal ?? null, k));
    (p.symptoms || []).forEach((s, k) => db.run('INSERT INTO pair_symptoms (pair_id, system, text, text_norm, sort) VALUES (?,?,?,?,?)', id, s.system ?? null, J(s.text), normalizeText(locText(s.text)), k));
    const relNames = p.relations.map((r) => locText(m.entities.get(r.entity)?.name));
    search('pair', id, [p.number != null ? `pb ${p.number} ${p.number}` : '', locText(p.name), locText(m.points.get(p.tracking.point)?.name),
      locText(m.points.get(p.impact.point)?.name), p.category, ...relNames, ...(p.symptoms || []).map((s) => locText(s.text))]);
  }
  for (const [id, e] of m.entities) {
    e.polePairs.forEach((pp, k) => db.run('INSERT INTO entity_pole_pairs (entity_id, sort, neg_point, pos_point, pair_id) VALUES (?,?,?,?,?)', id, k, pp.neg, pp.pos, pp.pairId || null));
  }
  i = 0;
  for (const [id, pr] of m.protocols) {
    db.run('INSERT INTO protocols (id, kind, name, name_norm, source_doc, sort, data) VALUES (?,?,?,?,?,?,?)', id, pr.kind, J(pr.name), normalizeText(locText(pr.name)), pr.source?.doc ?? null, i++, J(pr));
    search('protocol', id, [locText(pr.name)]);
  }
  for (const [id, pr] of m.protocols) {
    pr.items.forEach((it, k) => db.run('INSERT INTO protocol_items (protocol_id, seq, pair_id, child_protocol_id, data) VALUES (?,?,?,?,?)', id, k, it.pair ?? null, it.protocol ?? null, J(it)));
  }
  for (const [id, s] of m.symptoms) {
    db.run('INSERT INTO symptoms (id, system, name, name_norm, data) VALUES (?,?,?,?,?)', id, s.system ?? null, J(s.name), normalizeText(locText(s.name)), J(s));
    for (const pid of new Set(s.pairs)) db.run('INSERT INTO symptom_pairs (symptom_id, pair_id) VALUES (?,?)', id, pid);
    search('symptom', id, [locText(s.name), ...(s.aliases || [])]);
  }
  i = 0;
  for (const [id, c] of m.contraindications) db.run('INSERT INTO contraindications (id, kind, sort, data) VALUES (?,?,?,?)', id, c.kind, i++, J(c));
  i = 0;
  for (const [id, r] of m.recommendations) db.run('INSERT INTO recommendations (id, sort, data) VALUES (?,?,?)', id, i++, J(r));
  for (const g of m.glossary) db.run('INSERT INTO glossary (abbr, data) VALUES (?,?)', g.abbr, J(g));

  const counts = {
    sources: m.sources.size, regions: m.regions.size, points: m.points.size, pairs: m.pairs.size, entities: m.entities.size,
    protocols: m.protocols.size, symptoms: m.symptoms.size, contraindications: m.contraindications.size,
    recommendations: m.recommendations.size, glossary: m.glossary.length,
  };
  const meta = {
    version: m.version, fingerprint: m.fingerprint, loadedAt: new Date().toISOString(),
    manifest: J(m.manifest), counts: J(counts), hashes: J(m.hashes),
  };
  for (const [k, v] of Object.entries(meta)) db.run('INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?,?)', k, String(v));
  return counts;
}

export function catalogMeta(db) {
  const rows = db.all('SELECT key, value FROM catalog_meta');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return m.version ? { version: m.version, fingerprint: m.fingerprint, loadedAt: m.loadedAt, manifest: JSON.parse(m.manifest || 'null'), counts: JSON.parse(m.counts || '{}') } : null;
}

/** Load the catalog. Throws CatalogError on validation failures (nothing is written). */
export function loadCatalog(db, { dir, log, force = false, strict = true } = {}) {
  const { data, hashes } = readFiles(dir);
  const fingerprint = fingerprintOf(hashes);
  const current = catalogMeta(db);
  if (!force && current?.fingerprint === fingerprint) {
    log?.info('catalog unchanged; load skipped', { catalogVersion: current.version });
    return { skipped: true, version: current.version, fingerprint, counts: current.counts, warnings: [] };
  }
  const { model, errors, warnings } = buildModel(data, hashes, { strict });
  if (errors.length) throw new CatalogError(errors, warnings);
  const counts = db.tx(() => writeModel(db, model));
  for (const w of warnings.slice(0, 50)) log?.warn('catalog warning', { warnings: w });
  log?.info('catalog loaded', { catalogVersion: model.version, count: counts.pairs });
  return { skipped: false, version: model.version, fingerprint, counts, warnings };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { loadConfig } = await import('../lib/config.js');
  const { createLogger } = await import('../lib/log.js');
  const { openDb, migrate } = await import('../lib/db.js');
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const cfg = loadConfig();
    const log = createLogger({ level: cfg.logLevel });
    const db = openDb(cfg.dbPath, { log });
    migrate(db, { log });
    const dir = opt('--dir') ? path.resolve(opt('--dir')) : cfg.catalogDir;
    const r = loadCatalog(db, { dir, log, force: args.includes('--force'), strict: !args.includes('--lenient') });
    db.close();
    console.log(JSON.stringify({ ok: true, ...r, warnings: r.warnings.length }, null, 2));
    if (r.warnings.length) console.log(`${r.warnings.length} warning(s):\n${r.warnings.map((w) => `  - ${w}`).join('\n')}`);
  } catch (e) {
    console.error(e.message);
    if (e.warnings?.length) console.error(`(${e.warnings.length} warning(s) also reported)`);
    process.exit(1);
  }
}
