// Language-pack primitives shared by extract / apply / validate.
// A pack is a MIRROR of the Spanish baseline: one entry per localized catalog field, keyed
// "<file>/<recordId>/<path>", each carrying the SHA-256 (16 hex) of the Spanish source it translates.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CATALOG_FILES = ['points', 'regions', 'pairs', 'entities', 'protocols', 'symptoms',
  'contraindications', 'recommendations', 'glossary', 'sources'];
export const BASELINE = 'es';
export const srcHash = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const recordId = (file, r, i) => r.id ?? (file === 'glossary' ? `abbr:${r.abbr}` : `#${i}`);

/** Yield { key, node } for every localized object ({es: string, ...}) in the catalog. */
export function* localizedFields(catalogDir) {
  for (const file of CATALOG_FILES) {
    const p = join(catalogDir, `${file}.json`);
    if (!existsSync(p)) continue;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    for (const [i, rec] of data.entries()) {
      const id = recordId(file, rec, i);
      yield* walk(rec, `${file}/${id}`, '');
    }
  }
}
function* walk(node, prefix, path) {
  if (Array.isArray(node)) { for (const [i, v] of node.entries()) yield* walk(v, prefix, `${path}[${i}]`); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.es === 'string') { yield { key: `${prefix}/${path.replace(/^\./, '') || '.'}`, node }; return; }
  for (const [k, v] of Object.entries(node)) yield* walk(v, prefix, `${path}.${k}`);
}

export const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
