// App-wide state: signed-in user, clinic profile, catalog cache. In-memory only (no PHI in storage).
import { api, items } from './api.js';
import { locText, setVocabularies } from './i18n.js';

export const state = {
  user: null,
  org: null,
  csrf: null,
  restriction: null, // 'mfa' | 'password' | null (from /auth/me)
};

export const DEFAULT_POLARITY = { negative: '#2563EB', positive: '#DC2626' };

export function polarity() {
  const p = (state.org && state.org.polarity) || {};
  return { negative: p.negative || DEFAULT_POLARITY.negative, positive: p.positive || DEFAULT_POLARITY.positive };
}

export function hasRole(...roles) { return !!state.user && roles.includes(state.user.role); }
// Mirrors server/lib/rbac.js PERM. Assistant: patients + intake + session summaries (no clinical detail).
// Auditor: audit log + reports only (no patient directory).
export const can = {
  findings: () => hasRole('practitioner', 'admin'),
  clinical: () => hasRole('practitioner', 'admin'),
  patients: () => hasRole('practitioner', 'admin', 'assistant'),
  intake: () => hasRole('practitioner', 'admin', 'assistant'),
  scan: () => hasRole('practitioner', 'admin'),
  admin: () => hasRole('admin'),
  audit: () => hasRole('admin', 'auditor'),
  reports: () => hasRole('practitioner', 'admin', 'auditor'),
};

/** Normalize a session (summary or full) across API revisions: sessionDate/startedAt, findingCount/findingsCount. */
export function normSession(s) {
  if (!s) return s;
  const startedAt = s.sessionDate || s.startedAt || s.createdAt;
  const findingsCount = s.findingCount ?? s.findingsCount ?? (s.findings ? s.findings.length : 0);
  return { ...s, startedAt, sessionDate: startedAt, findingsCount, reportHash: s.reportSha256 || s.reportHash || null };
}
/** Qualifiers may be an array (legacy) or { tracking, impact }. */
export function normQualifiers(q) {
  if (Array.isArray(q)) return { tracking: q, impact: q };
  return { tracking: (q && q.tracking) || [], impact: (q && q.impact) || [] };
}

// ---------------- Patient search ----------------
// PHI search terms go in a POST body (CONTRACT §5 security remediation) — never in a URL, hash or history.
// The last search lives only in memory for the lifetime of the page.
export const patientSearchMemory = { q: '', dob: '' };
// Search terms are PHI: they only ever travel in a POST body, never in a URL (no GET fallback).
export async function searchPatients({ q = '', dob = '', limit = 50 } = {}) {
  if (!q && !dob) return api.get('/patients', { limit });
  return api.post('/patients/search', { q: q || undefined, dob: dob || undefined, limit });
}

// ---------------- Catalog cache ----------------
const cache = {
  core: null,
  pairDetail: new Map(),
  pointPairs: new Map(),
  protocolDetail: new Map(),
  lists: new Map(),
};

/** points (Map id→point), regions, pairs (Map id→summary), protocols (array), systems */
export function loadCore() {
  if (cache.core) return cache.core;
  cache.core = (async () => {
    const [points, regions, pairs, protocols, symptoms, manifest] = await Promise.all([
      api.get('/catalog/points', { limit: 5000 }), api.get('/catalog/regions', { limit: 5000 }), api.get('/catalog/pairs', { limit: 5000 }),
      api.get('/catalog/protocols', { limit: 5000 }), api.get('/catalog/symptoms', { limit: 5000 }), api.get('/catalog/manifest').catch(() => null),
    ]);
    if (manifest && manifest.vocabularies) setVocabularies(manifest.vocabularies);
    const pts = new Map(items(points).map((p) => [p.id, p]));
    const prs = new Map(items(pairs).map((p) => [p.id, p]));
    for (const p of items(protocols)) if (p.count === undefined && p.pairCount !== undefined) p.count = p.pairCount;
    const syms = new Map(items(symptoms).map((x) => [x.id, x]));
    const positioned = items(points).filter((p) => p.pos && Number.isFinite(p.pos.y)).length;
    return { points: pts, pointList: items(points), regions: items(regions), pairs: prs, protocols: items(protocols), symptoms: syms, manifest, positioned };
  })().catch((e) => { cache.core = null; throw e; });
  return cache.core;
}

export async function getPair(id) {
  if (!cache.pairDetail.has(id)) cache.pairDetail.set(id, api.get(`/catalog/pairs/${encodeURIComponent(id)}`).catch((e) => { cache.pairDetail.delete(id); throw e; }));
  return cache.pairDetail.get(id);
}
export async function getPointPairs(id) {
  // server: { point, items:[{ role, pair }] } → flatten to pair summaries carrying `role`
  const flat = (res) => items(res).map((x) => (x && x.pair ? { ...x.pair, role: x.role } : x));
  if (!cache.pointPairs.has(id)) cache.pointPairs.set(id, api.get(`/catalog/points/${encodeURIComponent(id)}/pairs`).then(flat).catch((e) => { cache.pointPairs.delete(id); throw e; }));
  return cache.pointPairs.get(id);
}
export async function getProtocol(id) {
  if (!cache.protocolDetail.has(id)) cache.protocolDetail.set(id, api.get(`/catalog/protocols/${encodeURIComponent(id)}`).catch((e) => { cache.protocolDetail.delete(id); throw e; }));
  return cache.protocolDetail.get(id);
}
export async function getList(path) {
  if (!cache.lists.has(path)) cache.lists.set(path, api.get(path).then(items).catch((e) => { cache.lists.delete(path); throw e; }));
  return cache.lists.get(path);
}

/** Expanded protocol → ordered pair ids (accepts several plausible server shapes). */
export function protocolPairIds(proto) {
  const src = proto.pairs || proto.expanded || proto.items || [];
  const out = [];
  for (const it of src) {
    if (typeof it === 'string') out.push(it);
    else if (it.pairId) out.push(it.pairId);
    else if (it.pair && it.pair.id && !it.pairId) out.push(it.pair.id);
    else if (it.pair && typeof it.pair === 'string') out.push(it.pair);
    else if (it.pair && it.pair.id) out.push(it.pair.id);
    else if (it.id && it.number !== undefined) out.push(it.id);
  }
  return [...new Set(out)];
}

export function pointName(points, id) { const p = points.get(id); return p ? locText(p.name) : id; }

export function clearCatalogCache() { cache.core = null; cache.pairDetail.clear(); cache.pointPairs.clear(); cache.protocolDetail.clear(); cache.lists.clear(); }
