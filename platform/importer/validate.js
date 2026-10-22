#!/usr/bin/env node
// Referential-integrity validator for data/catalog/*.json (CONTRACT §4).
//   node importer/validate.js        # validates the committed catalog, prints counts, exit 1 on error
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATEGORIES = ['virus', 'bacteria', 'fungus', 'parasite', 'dysfunctional', 'psychoemotional', 'reservoir', 'complex', 'special', 'prion', 'temporary', 'glandular-dysfunction'];
const SYSTEMS = ['general', 'respiratory', 'gastrointestinal', 'neurological', 'musculoskeletal', 'urological', 'cardiological', 'gynecological', 'endocrine', 'hematological', 'dermatological', 'ophthalmological', 'auditory', 'immunological', 'psychiatric', 'oncological', 'dental', 'tropical', 'toxicological'];
const SIDES = ['R', 'L', 'C', 'RL'];
const QUALS = ['S', 'INF', 'A', 'P', 'LAT'];
const KINDS = ['pathogen', 'condition', 'named-pair'];
const PKINDS = ['basic', 'top10', 'top5', 'disease', 'application'];
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PAIR_ID = /^(pb-\d{3}|cx-[a-z0-9]+(-[a-z0-9]+)*--[a-z0-9]+(-[a-z0-9]+)*)$/;
const FILES = ['sources', 'points', 'pairs', 'entities', 'protocols', 'symptoms', 'contraindications', 'recommendations', 'glossary', 'manifest'];

export function validate(d) {
  const errors = [], warnings = [];
  const err = m => errors.push(m), wrn = m => warnings.push(m);
  for (const f of FILES) if (d[f] == null) err(`missing ${f}.json`);
  if (errors.length) return { ok: false, errors, warnings };
  const ids = (arr, name, re = SLUG) => {
    const m = new Map();
    for (const x of arr) {
      if (!x.id) { err(`${name}: record without id`); continue; }
      if (re && !re.test(x.id)) err(`${name}: id "${x.id}" is not a valid slug`);
      if (m.has(x.id)) err(`${name}: duplicate id ${x.id}`);
      m.set(x.id, x);
    }
    return m;
  };
  const sources = ids(d.sources, 'sources');
  const points = ids(d.points, 'points');
  const pairs = ids(d.pairs, 'pairs', PAIR_ID);
  const entities = ids(d.entities, 'entities');
  const protocols = ids(d.protocols, 'protocols');
  const symptoms = ids(d.symptoms, 'symptoms');
  const recs = ids(d.recommendations, 'recommendations');
  ids(d.contraindications, 'contraindications');
  const loc = (o, where, needEn) => {
    if (!o || typeof o !== 'object' || typeof o.es !== 'string' || !o.es) err(`${where}: localized text without es`);
    else if (needEn && !o.en) err(`${where}: missing en`);
  };
  const srcOk = (s, where) => { if (!s || !sources.has(s.doc) || !(Number.isInteger(s.page) && s.page > 0)) err(`${where}: bad source ${JSON.stringify(s)}`); };

  for (const s of d.sources) if (!['internal-use', 'licensed', 'public-domain', 'original'].includes(s.license_status)) err(`sources.${s.id}: bad license_status`);
  for (const p of d.points) {
    loc(p.name, `points.${p.id}.name`, true);
    if (!['central', 'bilateral'].includes(p.laterality)) err(`points.${p.id}: bad laterality`);
  }
  // ------------------------------------------------------------- pairs
  const end = (e, where) => {
    if (!e || !points.has(e.point)) err(`${where}.point "${e?.point}" not in points.json`);
    if (e?.altPoint && !points.has(e.altPoint)) err(`${where}.altPoint "${e.altPoint}" not in points.json`);
    if (!SIDES.includes(e?.side)) err(`${where}.side "${e?.side}" invalid`);
    for (const q of e?.qualifiers || []) if (!QUALS.includes(q)) err(`${where}.qualifiers "${q}" invalid`);
  };
  const byLevel = { 1: [], 2: [] };
  for (const p of d.pairs) {
    const w = `pairs.${p.id}`;
    loc(p.name, `${w}.name`, true);
    end(p.tracking, `${w}.tracking`); end(p.impact, `${w}.impact`);
    for (const m of p.magnets || []) { if (!points.has(m.point)) err(`${w}.magnets point ${m.point} missing`); if (!['negative', 'positive'].includes(m.polarity)) err(`${w}.magnets polarity`); }
    if (!CATEGORIES.includes(p.category)) err(`${w}: bad category ${p.category}`);
    for (const r of p.relations) { if (!entities.has(r.entity)) err(`${w}: relation entity ${r.entity} missing`); if (r.ordinal != null && !(Number.isInteger(r.ordinal) && r.ordinal > 0)) err(`${w}: bad ordinal`); }
    for (const [k, v] of Object.entries(p.ratings || {})) if (!['F', 'P', 'R'].includes(k) || !(v >= 1 && v <= 3)) err(`${w}: bad rating ${k}=${v}`);
    for (const s of p.symptoms) { if (!SYSTEMS.includes(s.system)) err(`${w}: bad symptom system ${s.system}`); loc(s.text, `${w}.symptoms`); if (s.symptom && !symptoms.has(s.symptom)) err(`${w}: symptom ${s.symptom} missing`); }
    for (const r of p.recommendations) loc(r, `${w}.recommendations`);
    for (const r of p.recommendationSets || []) if (!recs.has(r)) err(`${w}: recommendation set ${r} missing`);
    for (const r of p.relatedProtocols || []) if (!protocols.has(r)) err(`${w}: related protocol ${r} missing`);
    for (const n of p.notes) loc(n, `${w}.notes`);
    srcOk(p.source, w);
    if (p.level === 1 || p.level === 2) { byLevel[p.level].push(p.number); if (p.id !== `pb-${String(p.number).padStart(3, '0')}`) err(`${w}: id/number mismatch`); }
    else if (p.level === 0) { if (!p.id.startsWith('cx-') || p.number != null) err(`${w}: level-0 pair must be cx- without number`); if (p.id !== `cx-${p.tracking.point}--${p.impact.point}`) err(`${w}: cx id does not match points`); }
    else err(`${w}: bad level ${p.level}`);
    if (p.level > 0 && ['F', 'P', 'R'].some(k => p.ratings[k] == null)) wrn(`${w}: ratings incomplete ${JSON.stringify(p.ratings)}`);
  }
  const contiguous = (nums, a, b, lvl) => {
    const s = [...nums].sort((x, y) => x - y);
    if (s.length !== b - a + 1 || s[0] !== a || s[s.length - 1] !== b || s.some((n, i) => n !== a + i)) err(`level ${lvl}: expected pairs ${a}..${b} (${b - a + 1}), got ${s.length}`);
  };
  contiguous(byLevel[1], 1, 210, 1); contiguous(byLevel[2], 211, 325, 2);
  // ------------------------------------------------------------- entities
  for (const e of d.entities) {
    const w = `entities.${e.id}`;
    loc(e.name, `${w}.name`);
    if (!e.name?.en) wrn(`${w}: no English name`);
    if (!KINDS.includes(e.kind)) err(`${w}: bad kind ${e.kind}`);
    if (!CATEGORIES.includes(e.classification)) err(`${w}: bad classification ${e.classification}`);
    for (const pp of e.polePairs) {
      if (!points.has(pp.neg) || !points.has(pp.pos)) err(`${w}: pole pair points ${pp.neg}/${pp.pos} missing`);
      if (pp.pairId && !pairs.has(pp.pairId)) err(`${w}: pairId ${pp.pairId} missing`);
      const p = pairs.get(pp.pairId);
      if (p && !((p.tracking.point === pp.neg || p.tracking.altPoint === pp.neg) && (p.impact.point === pp.pos || p.impact.altPoint === pp.pos))) err(`${w}: pole pair ${pp.neg}/${pp.pos} does not match ${pp.pairId}`);
    }
    for (const pr of e.protocols) if (!protocols.has(pr)) err(`${w}: protocol ${pr} missing`);
    srcOk(e.source, w);
  }
  // ------------------------------------------------------------- protocols
  for (const p of d.protocols) {
    const w = `protocols.${p.id}`;
    if (!PKINDS.includes(p.kind)) err(`${w}: bad kind`);
    loc(p.name, `${w}.name`, true);
    if (!p.items.length) wrn(`${w}: no items`);
    for (const it of p.items) {
      if (it.pair && !pairs.has(it.pair)) err(`${w}: item pair ${it.pair} missing`);
      if (it.protocol && !protocols.has(it.protocol)) err(`${w}: item protocol ${it.protocol} missing`);
      if (!it.pair === !it.protocol) err(`${w}: item must have exactly one of pair/protocol`);
    }
    srcOk(p.source, w);
  }
  // cycles
  const visiting = new Set(), done = new Set();
  const dfs = id => { if (done.has(id)) return; if (visiting.has(id)) { err(`protocols: cycle through ${id}`); return; } visiting.add(id); for (const it of protocols.get(id)?.items || []) if (it.protocol) dfs(it.protocol); visiting.delete(id); done.add(id); };
  for (const id of protocols.keys()) dfs(id);
  // ------------------------------------------------------------- symptoms
  for (const s of d.symptoms) {
    if (!SYSTEMS.includes(s.system)) err(`symptoms.${s.id}: bad system ${s.system}`);
    loc(s.name, `symptoms.${s.id}.name`);
    if (!s.name?.en) wrn(`symptoms.${s.id}: no English name`);
    for (const p of s.pairs) if (!pairs.has(p)) err(`symptoms.${s.id}: pair ${p} missing`);
  }
  for (const c of d.contraindications) { if (!['relative', 'absolute'].includes(c.kind)) err(`contraindications.${c.id}: bad kind`); loc(c.text, `contraindications.${c.id}`); srcOk(c.source, `contraindications.${c.id}`); }
  for (const r of d.recommendations) { loc(r.title, `recommendations.${r.id}.title`, true); srcOk(r.source, `recommendations.${r.id}`); }
  const ab = new Set();
  for (const g of d.glossary) { if (ab.has(`${g.group || ''}:${g.abbr}`)) err(`glossary: duplicate ${g.abbr}`); ab.add(`${g.group || ''}:${g.abbr}`); loc(g.meaning, `glossary.${g.abbr}`, true); }
  // ------------------------------------------------------------- manifest
  const m = d.manifest;
  for (const f of FILES.filter(f => f !== 'manifest')) if (m.counts?.[f] !== d[f].length) err(`manifest.counts.${f} = ${m.counts?.[f]} but file has ${d[f].length}`);
  const counts = Object.fromEntries(FILES.filter(f => f !== 'manifest').map(f => [f, d[f].length]));
  counts.missingEnEntities = d.entities.filter(e => !e.name.en).length;
  counts.missingEnSymptoms = d.symptoms.filter(s => !s.name.en).length;
  return { ok: errors.length === 0, errors, warnings, counts };
}

// ------------------------------------------------------------------- CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog');
  const d = {}, raw = {};
  for (const f of FILES) { const p = join(dir, `${f}.json`); if (existsSync(p)) { raw[f] = readFileSync(p, 'utf8'); d[f] = JSON.parse(raw[f]); } }
  const r = validate(d);
  if (d.manifest) for (const f of FILES.filter(f => f !== 'manifest')) {
    const h = createHash('sha256').update(raw[f] || '').digest('hex');
    if (d.manifest.sha256?.[`${f}.json`] !== h) r.errors.push(`manifest.sha256 mismatch for ${f}.json`), r.ok = false;
  }
  console.log('counts:', JSON.stringify(r.counts));
  if (d.pairs) console.log('pairs by level:', JSON.stringify(d.pairs.reduce((a, p) => ((a[p.level] = (a[p.level] || 0) + 1), a), {})));
  console.log(`warnings: ${r.warnings.length}`); for (const w of r.warnings.slice(0, 15)) console.log('  ' + w);
  if (r.ok) console.log('OK — referential integrity verified'); else { console.log(`${r.errors.length} error(s):`); for (const e of r.errors.slice(0, 100)) console.log('  ' + e); }
  process.exit(r.ok ? 0 : 1);
}
