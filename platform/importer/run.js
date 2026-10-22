#!/usr/bin/env node
// YOU HEAL Clinical — catalog importer (build-time only).
// Parses the licensed source PDFs in data/sources/ with poppler's pdftotext and writes the
// committed catalog JSON files in data/catalog/ (formats: docs/CONTRACT.md §4).
//
//   node importer/run.js            # writes all catalog files + IMPORT-REPORT.md
//   node importer/run.js --check    # parse and validate only, write nothing
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPdf } from './lib/pdf.js';
import { build } from './lib/build.js';
import { CATEGORIES, SYSTEMS, SIDES, QUALIFIERS } from './lib/i18n.js';
import { writeReport } from './lib/report.js';
import { applySupplements } from './lib/supplements.js';
import { validate } from './validate.js';

const CATALOG_VERSION = '2026.10.0';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'data', 'sources');
const OUT = join(root, 'data', 'catalog');
const check = process.argv.includes('--check');

const FILES = {
  'goiz-n1': 'goiz-nivel-1-guia.pdf',
  'goiz-n2': 'goiz-nivel-2-guia.pdf',
  'leal-2018': 'leal-padecimientos-patogenos-2018.pdf',
};
const sha = buf => createHash('sha256').update(buf).digest('hex');

const sourcesMeta = [
  { id: 'goiz-n1', title: 'Guía de Pares Biomagnéticos — 1er Nivel (2017)', author: 'David Goiz Martínez / BRI', license_status: 'internal-use',
    notice: 'GOIZ ™ Intellectual Property © All rights reserved', file: FILES['goiz-n1'], pages: 142, pageNumbering: 'printed page = PDF page ("Pg. N" footer)' },
  { id: 'goiz-n2', title: 'Guía de Pares Biomagnéticos — 2do Nivel (2017)', author: 'David Goiz Martínez / BRI', license_status: 'internal-use',
    notice: 'GOIZ ™ Intellectual Property © All rights reserved', file: FILES['goiz-n2'], pages: 120, pageNumbering: 'printed page = PDF page + 140 ("P. N" footer)' },
  { id: 'leal-2018', title: 'Biomagnetismo Médico — Padecimientos & Patógenos (2018)', author: 'Oscar Leal (recopilación), basado en las enseñanzas del Dr. Isaac Goiz Durán', license_status: 'internal-use',
    notice: 'Compilation published at biomagnetismolibre.wordpress.com; redistribution rights not established — internal use only', file: FILES['leal-2018'], pages: 474, pageNumbering: 'printed page = PDF page' },
  { id: 'youheal', title: 'YOU HEAL Clinical — original content', author: 'YOU HEAL Clinical', license_status: 'original', notice: 'Original content (translations, normalization, vocabularies)' },
];

for (const [id, f] of Object.entries(FILES)) {
  if (!existsSync(join(SRC, f))) { console.error(`missing source PDF: data/sources/${f} (${id})`); process.exit(2); }
}
const pdf = {};
for (const [id, f] of Object.entries(FILES)) {
  const buf = readFileSync(join(SRC, f));
  sourcesMeta.find(s => s.id === id).sha256 = sha(buf);
  pdf[id] = readPdf(join(SRC, f));
}
const overrides = JSON.parse(readFileSync(join(here, 'overrides.json'), 'utf8'));
const { data, report } = build({ pdf, overrides, sourcesMeta });
applySupplements(data, JSON.parse(readFileSync(join(here, 'supplements.json'), 'utf8')), report);

// --------------------------------------------------------------------- write
const stringify = v => JSON.stringify(v, null, 2) + '\n';
const order = ['sources', 'points', 'pairs', 'entities', 'protocols', 'symptoms', 'contraindications', 'recommendations', 'glossary'];
const texts = Object.fromEntries(order.map(k => [`${k}.json`, stringify(data[k])]));
const counts = Object.fromEntries(order.map(k => [k, data[k].length]));
counts.pairsLevel1 = data.pairs.filter(p => p.level === 1).length;
counts.pairsLevel2 = data.pairs.filter(p => p.level === 2).length;
counts.pairsCompendium = data.pairs.filter(p => p.level === 0).length;
counts.protocolsApplication = data.protocols.filter(p => p.kind === 'application').length;
const hashes = Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, sha(t)]));
let generatedAt = process.env.SOURCE_DATE_EPOCH ? new Date(+process.env.SOURCE_DATE_EPOCH * 1000).toISOString() : new Date().toISOString();
const manifestPath = join(OUT, 'manifest.json');
if (existsSync(manifestPath)) {
  try { const old = JSON.parse(readFileSync(manifestPath, 'utf8')); if (old.version === CATALOG_VERSION && JSON.stringify(old.sha256) === JSON.stringify(hashes)) generatedAt = old.generatedAt; } catch {}
}
const manifest = {
  version: CATALOG_VERSION,
  generatedAt,
  generator: 'importer/run.js (poppler pdftotext -bbox-layout)',
  counts,
  sha256: hashes,
  sources: Object.fromEntries(sourcesMeta.filter(s => s.sha256).map(s => [s.id, s.sha256])),
  vocabularies: { categories: CATEGORIES, systems: SYSTEMS, sides: SIDES, qualifiers: QUALIFIERS },
};
texts['manifest.json'] = stringify(manifest);

const v = validate(Object.fromEntries(Object.entries(texts).map(([k, t]) => [k.replace(/\.json$/, ''), JSON.parse(t)])));
report.validation = v;
if (!check) {
  mkdirSync(OUT, { recursive: true });
  for (const [k, t] of Object.entries(texts)) writeFileSync(join(OUT, k), t);
  writeFileSync(join(OUT, 'IMPORT-REPORT.md'), writeReport({ data, report, counts, manifest, overrides }));
}
console.log(`catalog ${CATALOG_VERSION}: ` + Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' '));
console.log(`unresolved=${report.unresolved.length} warnings=${report.warnings.length} overrides=${report.overridesApplied.length}`);
console.log(v.ok ? 'validation: OK' : `validation: ${v.errors.length} error(s)\n  ` + v.errors.slice(0, 40).join('\n  '));
process.exit(v.ok ? 0 : 1);
