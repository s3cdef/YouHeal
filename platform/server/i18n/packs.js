// Language packs (CONTRACT §9): Spanish baseline + mirrored translations keyed
// "<catalogFile>/<recordId>/<jsonPath>", each mirror entry carrying the SHA-256/16 of the Spanish text.
// Key generation mirrors importer/i18n/lib.mjs exactly (reference implementation).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BASELINE = 'es';
export const MIRROR_STATUSES = ['curated', 'machine', 'reviewed', 'missing', 'stale'];
export const LIVE_STATUSES = new Set(['curated', 'machine', 'reviewed']);
export const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const HASH_RE = /^[0-9a-f]{16}$/;

const hashMemo = new Map();
/** SHA-256/16 of the Spanish source text (memoized: the same texts are hashed by load, compose and serve). */
export const srcHash = (s) => {
  const k = String(s);
  let h = hashMemo.get(k);
  if (h === undefined) {
    h = crypto.createHash('sha256').update(k, 'utf8').digest('hex').slice(0, 16);
    if (hashMemo.size > 200_000) hashMemo.clear();
    hashMemo.set(k, h);
  }
  return h;
};
export const recordId = (file, r, i) => r.id ?? (file === 'glossary' ? `abbr:${r.abbr}` : `#${i}`);

/** Yield { key, node } for every localized object ({es: string, ...}) under `rec`, keyed with `prefix`. */
export function* walkLocalized(node, prefix, p = '') {
  if (Array.isArray(node)) { for (const [i, v] of node.entries()) yield* walkLocalized(v, prefix, `${p}[${i}]`); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.es === 'string') { yield { key: `${prefix}/${p.replace(/^\./, '') || '.'}`, node }; return; }
  for (const [k, v] of Object.entries(node)) yield* walkLocalized(v, prefix, `${p}.${k}`);
}

/** Iterate { file, id, rec } over catalog records in file order (records as stored/served). */
export function* catalogRecords(files) {
  for (const [file, list] of Object.entries(files)) {
    if (!list) continue;
    let i = 0;
    for (const rec of list) { yield { file, id: recordId(file, rec, i), rec }; i++; }
  }
}

/** Baseline map key -> { text, hash } computed from the catalog itself (source of truth). */
export function baselineFrom(files) {
  const map = new Map();
  for (const { file, id, rec } of catalogRecords(files)) {
    for (const { key, node } of walkLocalized(rec, `${file}/${id}`)) map.set(key, { text: node.es, hash: srcHash(node.es) });
  }
  return map;
}

const sha256File = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Read data/i18n/packs/<locale>/{manifest,catalog,ui}.json. Missing dir -> no packs. */
export function readPacks(dir) {
  const out = { packs: [], hashes: {}, errors: [] };
  if (!dir || !fs.existsSync(dir)) return out;
  for (const loc of fs.readdirSync(dir).sort()) {
    const pdir = path.join(dir, loc);
    if (!fs.statSync(pdir).isDirectory()) continue;
    if (!LOCALE_RE.test(loc)) { out.errors.push(`i18n/${loc}: invalid locale directory name`); continue; }
    const pack = { locale: loc };
    for (const f of ['manifest', 'catalog', 'ui']) {
      const p = path.join(pdir, `${f}.json`);
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      out.hashes[`i18n/${loc}/${f}.json`] = sha256File(buf);
      try { pack[f] = JSON.parse(buf.toString('utf8')); } catch (e) { out.errors.push(`i18n/${loc}/${f}.json: invalid JSON (${e.message})`); }
      if (f === 'ui') pack.uiRaw = buf;
    }
    if (!pack.manifest) { out.errors.push(`i18n/${loc}: manifest.json is required`); continue; }
    pack.sha256 = sha256File(Buffer.from(Object.keys(out.hashes).filter((k) => k.startsWith(`i18n/${loc}/`)).sort().map((k) => out.hashes[k]).join('|')));
    out.packs.push(pack);
  }
  return out;
}

/**
 * Validate packs against the baseline. Returns { errors, warnings, packs } where each pack's catalog is
 * reduced to known keys. Rules: manifest locale = dir name, role/dir enums, mirror entries need a 16-hex
 * srcHash and a valid status; keys absent from the baseline are reported (warning) and ignored.
 */
export function validatePacks(read, baseline) {
  const errors = [...read.errors], warnings = [];
  const packs = [];
  for (const p of read.packs) {
    const m = p.manifest;
    const where = `i18n/${p.locale}`;
    if (m.locale !== p.locale) errors.push(`${where}/manifest.json: locale "${m.locale}" does not match directory`);
    if (!['baseline', 'mirror'].includes(m.role)) errors.push(`${where}/manifest.json: role must be baseline|mirror`);
    if (m.dir !== undefined && !['ltr', 'rtl'].includes(m.dir)) errors.push(`${where}/manifest.json: dir must be ltr|rtl`);
    if (m.role === 'baseline' && p.locale !== BASELINE) errors.push(`${where}: only "${BASELINE}" may be the baseline`);
    if (m.role === 'mirror' && (m.baseline ?? BASELINE) !== BASELINE) errors.push(`${where}/manifest.json: baseline must be "${BASELINE}"`);
    if (p.ui !== undefined && (typeof p.ui !== 'object' || Array.isArray(p.ui))) errors.push(`${where}/ui.json: expected an object`);
    const cat = p.catalog && typeof p.catalog === 'object' && !Array.isArray(p.catalog) ? p.catalog : {};
    if (p.catalog !== undefined && cat !== p.catalog) errors.push(`${where}/catalog.json: expected an object`);
    const entries = new Map();
    let unknown = 0, outdatedBaseline = 0;
    for (const [key, e] of Object.entries(cat)) {
      if (!baseline.has(key)) { unknown++; if (unknown <= 10) warnings.push(`${where}/catalog.json: unknown key "${key}" (ignored)`); continue; }
      if (!e || typeof e !== 'object') { errors.push(`${where}/catalog.json[${key}]: entry must be an object`); continue; }
      if (m.role === 'baseline') {
        if (e.hash !== baseline.get(key).hash) outdatedBaseline++;
        continue;
      }
      if (typeof e.srcHash !== 'string' || !HASH_RE.test(e.srcHash)) { errors.push(`${where}/catalog.json[${key}]: srcHash must be 16 lower-case hex`); continue; }
      if (!MIRROR_STATUSES.includes(e.status)) { errors.push(`${where}/catalog.json[${key}]: status must be one of ${MIRROR_STATUSES.join('|')}`); continue; }
      if (e.text !== null && e.text !== undefined && typeof e.text !== 'string') { errors.push(`${where}/catalog.json[${key}]: text must be a string or null`); continue; }
      entries.set(key, { text: e.text ?? null, srcHash: e.srcHash, status: e.status });
    }
    if (unknown > 10) warnings.push(`${where}/catalog.json: ${unknown} unknown keys in total (ignored)`);
    if (outdatedBaseline) warnings.push(`${where}/catalog.json: ${outdatedBaseline} baseline entries differ from the catalog (catalog wins; re-run importer/i18n/extract.mjs)`);
    packs.push({ ...p, entries });
  }
  if (packs.length && !packs.some((p) => p.manifest.role === 'baseline')) warnings.push(`i18n: no "${BASELINE}" baseline pack found (the catalog Spanish text is used as baseline)`);
  return { errors, warnings, packs };
}

/** Effective mirror entry status for one key given the current baseline hash. */
export function effective(baseHash, entry, override) {
  if (override && override.src_hash === baseHash) return { text: override.text, status: 'reviewed', override: true };
  if (!entry) return { text: null, status: 'missing' };
  if (entry.srcHash !== baseHash || entry.status === 'stale') return { text: null, status: 'stale', staleText: entry.text };
  if (!entry.text || !LIVE_STATUSES.has(entry.status)) return { text: null, status: 'missing' };
  return { text: entry.text, status: entry.status };
}

/**
 * Compose localized nodes in-place for the given mirror locales.
 * lookup(locale, key) -> pack entry | undefined ; overrides(locale, key) -> override row | undefined.
 * A key the pack does not mention keeps whatever text the catalog file carried (pre-pack data).
 */
export function composeRecord(rec, prefix, locales, lookup, overrides = () => undefined) {
  for (const { key, node } of walkLocalized(rec, prefix)) {
    const h = srcHash(node.es);
    for (const loc of locales) {
      const entry = lookup(loc, key);
      const ov = overrides(loc, key);
      if (!entry && !(ov && ov.src_hash === h)) continue;
      const eff = effective(h, entry, ov);
      if (eff.text) node[loc] = eff.text; else delete node[loc];
    }
  }
  return rec;
}

/** Recursively merge `base` under `top` (UI string fallback). */
export function deepFallback(top, base) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return top ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(top || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepFallback(v, base[k]) : v;
  }
  return out;
}
