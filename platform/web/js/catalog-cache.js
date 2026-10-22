// Persistent cache for CATALOG reference data only (never patient data): IndexedDB records keyed by request path,
// revalidated with If-None-Match on every use, so a warm load downloads 304s instead of ~1 MB of catalog JSON.
// Records carry the catalog version they were written under; other versions are pruned once the manifest is known.
// Anything outside the allow-list below (patients, sessions, search queries, auth, i18n admin) is never stored.
import { request } from './api.js';

const DB_NAME = 'yh-catalog';
const STORE = 'responses';
const SCHEMA = 1;
// Reference catalog reads only: full lists (no free-text query) and single records by id.
const ALLOW = [
  /^\/catalog\/(manifest|points|regions|pairs|protocols|symptoms|entities|contraindications|recommendations|glossary|sources)$/,
  /^\/catalog\/(pairs|protocols|points|entities)\/[\w.-]+$/,
  /^\/catalog\/points\/[\w.-]+\/pairs$/,
];
const SAFE_QUERY = new Set(['limit', 'offset', 'locale', 'fields', 'level', 'kind', 'category']);

let dbp = null;
let version = null;
function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, SCHEMA);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function tx(mode, fn) {
  const db = await openDb(); if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode); const st = t.objectStore(STORE);
      const r = fn(st);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : null);
      t.onerror = () => resolve(null); t.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

export function cacheable(path, query) {
  if (!ALLOW.some((re) => re.test(path))) return false;
  return Object.entries(query || {}).every(([k, v]) => v === undefined || v === null || v === '' || SAFE_QUERY.has(k));
}
const keyOf = (path, query) => {
  const q = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => (a < b ? -1 : 1));
  return q.length ? `${path}?${new URLSearchParams(q).toString()}` : path;
};

/** GET a catalog resource: stored copy + If-None-Match when allowed, plain GET otherwise. */
export async function catalogGet(path, query) {
  if (!cacheable(path, query)) return request('GET', path, { query });
  const key = keyOf(path, query);
  const rec = await tx('readonly', (st) => st.get(key)).catch(() => null);
  const res = await request('GET', path, { query, meta: true, headers: rec && rec.etag ? { 'If-None-Match': rec.etag } : null });
  if (res.status === 304 && rec) return rec.body;
  if (res.status === 304) return request('GET', path, { query }); // validator without a body (cleared storage)
  if (res.etag) tx('readwrite', (st) => st.put({ etag: res.etag, body: res.data, v: version, at: Date.now() }, key)).catch(() => {});
  return res.data;
}

/** The catalog version from the manifest; records written under another version are dropped. */
export function setCatalogVersion(v) {
  if (!v || v === version) return;
  version = v;
  tx('readwrite', (st) => {
    const cur = st.openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c) return; if (c.value && c.value.v && c.value.v !== v) c.delete(); c.continue(); };
    return null;
  }).catch(() => {});
}
