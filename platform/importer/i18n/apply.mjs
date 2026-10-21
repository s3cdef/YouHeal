#!/usr/bin/env node
// Merges translated chunks (data/i18n/_work/<loc>/done/*.json) into the mirrored pack and writes the
// pack manifest:   node importer/i18n/apply.mjs [locale]
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sortKeys } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const loc = process.argv[2] || 'en';
const PACK = join(root, 'data', 'i18n', 'packs', loc);
const mirror = JSON.parse(readFileSync(join(PACK, 'catalog.json'), 'utf8'));
const doneDir = join(root, 'data', 'i18n', '_work', loc, 'done');
const byHash = new Map();
if (existsSync(doneDir)) {
  for (const f of readdirSync(doneDir).filter((f) => /^chunk-\d+\.json$/.test(f))) {
    for (const { h, en, text } of JSON.parse(readFileSync(join(doneDir, f), 'utf8'))) byHash.set(h, en ?? text);
  }
}
// US-English normalization for machine/curated text (Latin taxa such as Haemophilus, E. faecalis and the
// proper name Oedipus are deliberately not matched).
const US = [[/\b([Tt])umour/g, '$1umor'], [/\bOesophag/g, 'Esophag'], [/\boesophag/g, 'esophag'], [/\bOedema/g, 'Edema'],
  [/\boedema/g, 'edema'], [/\b([Hh])aemorrhag/g, (m, c) => (c === 'H' ? 'Hemorrhag' : 'hemorrhag')], [/\b([Hh])aemoly/g, '$1emoly'],
  [/\b([Hh])aemodynam/g, '$1emodynam'], [/\b([Hh])aematolog/g, '$1ematolog'], [/\b([Aa])naemi/g, '$1nemi'], [/\b([Ll])eukaemi/g, '$1eukemi'],
  [/\b([Dd])iarrhoea/g, '$1iarrhea'], [/\b([Pp])aediatr/g, '$1ediatr'], [/\b([Ii])schaem/g, '$1schem'], [/\b([Gg])ynaecolog/g, '$1ynecolog'],
  [/\b([Oo])estrogen/g, (m, c) => (c === 'O' ? 'Estrogen' : 'estrogen')], [/\b([Ff])oet(us|al)/g, (m, c, t) => (c === 'F' ? 'Fet' : 'fet') + t]];
const toUS = (t) => US.reduce((acc, [re, rep]) => acc.replace(re, rep), t);
let applied = 0;
for (const v of Object.values(mirror)) {
  if (!v.text && byHash.has(v.srcHash)) { v.text = byHash.get(v.srcHash); v.status = 'machine'; delete v.previous; applied++; }
  if (v.text && v.status !== 'reviewed' && loc === 'en') v.text = toUS(v.text);
}
writeFileSync(join(PACK, 'catalog.json'), JSON.stringify(sortKeys(mirror), null, 1) + '\n');
const vals = Object.values(mirror);
const count = (s) => vals.filter((v) => v.status === s).length;
const META = { en: { name: 'English', nativeName: 'English', dir: 'ltr' }, es: { name: 'Spanish', nativeName: 'Español', dir: 'ltr' } };
const manifestPath = join(PACK, 'manifest.json');
const prev = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const manifest = {
  ...prev, locale: loc, ...(META[loc] || {}), role: 'mirror', baseline: 'es',
  catalog: { fields: vals.length, translated: vals.filter((v) => v.text).length, curated: count('curated'),
    machine: count('machine'), reviewed: count('reviewed'), missing: count('missing'), stale: count('stale'),
    sha256: createHash('sha256').update(readFileSync(join(PACK, 'catalog.json'))).digest('hex') },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${loc}: applied ${applied}; ${manifest.catalog.translated}/${manifest.catalog.fields} translated (curated ${manifest.catalog.curated}, machine ${manifest.catalog.machine}, missing ${manifest.catalog.missing}, stale ${manifest.catalog.stale})`);
