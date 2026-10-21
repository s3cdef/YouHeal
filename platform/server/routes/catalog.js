// Catalog read API + in-memory catalog service (rebuilt whenever the catalog fingerprint changes).

import { v, check, paging, catalogId } from '../lib/validate.js';
import { normalizeText } from '../lib/crypto.js';
import { notFound, badRequest } from '../lib/http.js';
import { parseJson } from './_shared.js';
import { catalogMeta, SYSTEMS, CATEGORIES } from '../catalog/load.js';

const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'del', 'en', 'con', 'por', 'para', 'una', 'uno', 'que', 'and', 'the',
  'with', 'for', 'from', 'of', 'in', 'on', 'to', 'a', 'y', 'o', 'e', 'al', 'se', 'sin', 'muy', 'has', 'have', 'pain', 'dolor']);

export const tokenize = (text) => (normalizeText(text).match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 3 && !STOP.has(t));

export function createCatalogService(db, { allowedLicenses = null } = {}) {
  let cache = null;

  function build(fingerprint) {
    const rows = (sql) => db.all(sql);
    const sources = new Map(rows('SELECT * FROM catalog_sources').map((r) => [r.id, parseJson(r.data)]));
    const licenseOk = (src) => !allowedLicenses || !src?.doc || allowedLicenses.has(sources.get(src.doc)?.license_status);
    const points = new Map(rows('SELECT * FROM points ORDER BY sort').map((r) => [r.id, {
      id: r.id, name: parseJson(r.name), aliases: parseJson(r.aliases, []), laterality: r.laterality,
      region: r.region, view: r.view, pos: r.pos_x === null ? null : { x: r.pos_x, y: r.pos_y, z: r.pos_z },
    }]));
    const regions = rows('SELECT * FROM regions ORDER BY sort').map((r) => parseJson(r.data));
    const entities = new Map(rows('SELECT * FROM entities').map((r) => [r.id, parseJson(r.data)]));
    for (const [id, e] of entities) if (!licenseOk(e.source)) entities.delete(id);
    const pairs = new Map();
    for (const r of rows('SELECT * FROM pairs ORDER BY sort')) {
      const p = parseJson(r.data);
      if (!licenseOk(p.source)) continue;
      p.relations = (p.relations || []).filter((x) => entities.has(x.entity));
      pairs.set(r.id, p);
    }
    const protocols = new Map(rows('SELECT * FROM protocols ORDER BY sort').map((r) => [r.id, parseJson(r.data)]));
    for (const [id, pr] of protocols) if (!licenseOk(pr.source)) protocols.delete(id);
    const symptoms = new Map(rows('SELECT * FROM symptoms').map((r) => [r.id, parseJson(r.data)]));
    for (const s of symptoms.values()) s.pairs = (s.pairs || []).filter((id) => pairs.has(id));

    const byPoint = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    const pairSymptoms = new Map();
    const pairsByEntity = new Map();
    for (const p of pairs.values()) {
      push(byPoint, p.tracking.point, { pairId: p.id, role: 'tracking' });
      if (p.impact.point !== p.tracking.point) push(byPoint, p.impact.point, { pairId: p.id, role: 'impact' });
      else byPoint.get(p.tracking.point).at(-1).role = 'both';
      pairSymptoms.set(p.id, (p.symptoms || []).map((s) => ({ system: s.system, text: s.text, norm: ` ${normalizeText([s.text.es, s.text.en].filter(Boolean).join(' '))} ` })));
      for (const r of p.relations) push(pairsByEntity, r.entity, p.id);
    }
    for (const e of entities.values()) for (const pp of e.polePairs || []) {
      if (pp.pairId && pairs.has(pp.pairId) && !(pairsByEntity.get(e.id) || []).includes(pp.pairId)) push(pairsByEntity, e.id, pp.pairId);
    }

    const svc = { fingerprint, sources, points, regions, entities, pairs, protocols, symptoms, byPoint, pairSymptoms, pairsByEntity };
    // expanded protocol membership
    svc.expanded = new Map();
    for (const id of protocols.keys()) svc.expanded.set(id, expand(svc, id));
    svc.protocolsByPair = new Map();
    for (const [pid, list] of svc.expanded) for (const it of list) {
      const arr = svc.protocolsByPair.get(it.pairId) || [];
      if (!arr.includes(pid)) arr.push(pid);
      svc.protocolsByPair.set(it.pairId, arr);
    }
    svc.symptomsByPair = new Map();
    for (const s of symptoms.values()) for (const pid of s.pairs) push(svc.symptomsByPair, pid, s.id);
    svc.contraindications = rows('SELECT * FROM contraindications ORDER BY sort').map((r) => parseJson(r.data));
    svc.recommendations = rows('SELECT * FROM recommendations ORDER BY sort').map((r) => parseJson(r.data)).filter((r) => licenseOk(r.source));
    svc.glossary = rows('SELECT * FROM glossary ORDER BY id').map((r) => parseJson(r.data));
    return svc;
  }

  function expand(svc, id) {
    const out = [];
    const seen = new Set();
    const stack = new Set();
    const walk = (pid, via) => {
      if (stack.has(pid)) return; // cycle guard (the loader rejects cycles anyway)
      const pr = svc.protocols.get(pid);
      if (!pr) return;
      stack.add(pid);
      for (const it of pr.items || []) {
        if (it.pair) {
          if (!svc.pairs.has(it.pair) || seen.has(it.pair)) continue;
          seen.add(it.pair);
          out.push({ pairId: it.pair, via });
        } else if (it.protocol) walk(it.protocol, [...via, it.protocol]);
      }
      stack.delete(pid);
    };
    walk(id, []);
    return out.map((x, i) => ({ position: i + 1, ...x }));
  }

  function get() {
    const fp = db.get("SELECT value FROM catalog_meta WHERE key = 'fingerprint'")?.value || 'empty';
    if (!cache || cache.fingerprint !== fp) cache = build(fp);
    return cache;
  }

  const pointRef = (c, id, end) => ({ point: id, side: end?.side || 'C', qualifiers: end?.qualifiers || [], name: c.points.get(id)?.name ?? null });

  function pairSummary(p, c = get()) {
    if (!p) return null;
    return {
      id: p.id, number: p.number ?? null, level: p.level ?? 0, name: p.name,
      tracking: pointRef(c, p.tracking.point, p.tracking), impact: pointRef(c, p.impact.point, p.impact),
      category: p.category ?? null, ratings: p.ratings || {},
      relations: (p.relations || []).map((r) => ({ entity: r.entity, ordinal: r.ordinal ?? null, name: c.entities.get(r.entity)?.name ?? null, kind: c.entities.get(r.entity)?.kind ?? null })),
    };
  }

  function pairFull(id) {
    const c = get();
    const p = c.pairs.get(id);
    if (!p) return null;
    const src = p.source?.doc ? c.sources.get(p.source.doc) : null;
    return {
      ...p,
      ...pairSummary(p, c),
      relations: (p.relations || []).map((r) => {
        const e = c.entities.get(r.entity);
        return { entity: r.entity, ordinal: r.ordinal ?? null, name: e?.name ?? null, kind: e?.kind ?? null, classification: e?.classification ?? null };
      }),
      trackingPoint: c.points.get(p.tracking.point) || null,
      impactPoint: c.points.get(p.impact.point) || null,
      symptomIds: c.symptomsByPair.get(id) || [],
      protocols: (c.protocolsByPair.get(id) || []).map((pid) => ({ id: pid, kind: c.protocols.get(pid).kind, name: c.protocols.get(pid).name })),
      sourceInfo: src ? { id: src.id, title: src.title, license_status: src.license_status, notice: src.notice ?? null } : null,
    };
  }

  function protocolExpanded(id) {
    const c = get();
    const pr = c.protocols.get(id);
    if (!pr) return null;
    return {
      ...pr,
      pairs: c.expanded.get(id).map((x) => ({ ...x, pair: pairSummary(c.pairs.get(x.pairId), c) })),
      children: (pr.items || []).filter((i) => i.protocol).map((i) => ({ id: i.protocol, name: c.protocols.get(i.protocol)?.name ?? null, kind: c.protocols.get(i.protocol)?.kind ?? null })),
    };
  }

  function searchIds(q, kinds) {
    const tokens = (normalizeText(q).match(/[a-z0-9]+/g) || []).slice(0, 8);
    if (!tokens.length) return [];
    let rows;
    if (db.hasFts5) {
      const match = tokens.map((t) => `"${t}"*`).join(' AND ');
      rows = db.all('SELECT kind, ref_id, bm25(catalog_fts) AS score FROM catalog_fts WHERE catalog_fts MATCH ? ORDER BY score LIMIT 500', match);
    } else {
      const where = tokens.map(() => 'body LIKE ?').join(' AND ');
      rows = db.all(`SELECT kind, ref_id, 0 AS score FROM catalog_search WHERE ${where} LIMIT 500`, ...tokens.map((t) => `%${t}%`));
    }
    return rows.filter((r) => !kinds || kinds.includes(r.kind)).map((r) => ({ kind: r.kind, id: r.ref_id, score: r.score }));
  }

  function search(q, { kinds, limit = 50 } = {}) {
    const c = get();
    const hits = searchIds(q, kinds);
    const numMatch = /^\s*(?:pb[\s-]*)?(\d{1,4})\s*$/i.exec(q);
    if (numMatch && (!kinds || kinds.includes('pair'))) {
      const n = Number(numMatch[1]);
      for (const p of c.pairs.values()) if (p.number === n) { hits.unshift({ kind: 'pair', id: p.id, score: -1e9 }); }
    }
    const seen = new Set();
    const out = [];
    for (const h of hits) {
      const key = `${h.kind}:${h.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = describe(c, h.kind, h.id);
      if (item) out.push(item);
    }
    return { items: out.slice(0, limit), total: out.length };
  }

  function describe(c, kind, id) {
    switch (kind) {
      case 'pair': { const p = c.pairs.get(id); return p && { kind, id, name: p.name, number: p.number ?? null, category: p.category ?? null, summary: pairSummary(p, c) }; }
      case 'point': { const p = c.points.get(id); return p && { kind, id, name: p.name, laterality: p.laterality, region: p.region }; }
      case 'entity': { const e = c.entities.get(id); return e && { kind, id, name: e.name, entityKind: e.kind, classification: e.classification ?? null }; }
      case 'protocol': { const p = c.protocols.get(id); return p && { kind, id, name: p.name, protocolKind: p.kind }; }
      case 'symptom': { const s = c.symptoms.get(id); return s && { kind, id, name: s.name, system: s.system ?? null }; }
      default: return null;
    }
  }

  /**
   * Rank pairs for the reported symptoms:
   *   symptom match: specificity(s) = 1 / ln(1 + #pairs linked to s), weighted by F rating
   *   free text:     each query token found in a pair's symptom texts / name / relations adds 0.5 * F weight
   */
  function suggest({ symptoms = [], text = '' }, limit = 25) {
    const c = get();
    const fWeight = (p) => { const F = p.ratings?.F; return Number.isFinite(F) && F > 0 ? (1 + F) / 4 : 0.4; };
    const scores = new Map();
    const bump = (pairId, inc, reason) => {
      const s = scores.get(pairId) || { pairId, score: 0, matched: [] };
      s.score += inc; s.matched.push(reason);
      scores.set(pairId, s);
    };
    for (const sid of symptoms) {
      const s = c.symptoms.get(sid);
      if (!s || !s.pairs.length) continue;
      const spec = 1 / Math.log(1 + s.pairs.length);
      for (const pid of s.pairs) {
        const p = c.pairs.get(pid);
        bump(pid, spec * fWeight(p), { type: 'symptom', id: sid, name: s.name, weight: round(spec) });
      }
    }
    const tokens = [...new Set(tokenize(text))].slice(0, 20);
    if (tokens.length) {
      for (const p of c.pairs.values()) {
        const texts = c.pairSymptoms.get(p.id) || [];
        const nameNorm = ` ${normalizeText([p.name.es, p.name.en].filter(Boolean).join(' '))} `;
        const relNorm = ` ${normalizeText(p.relations.map((r) => { const n = c.entities.get(r.entity)?.name; return [n?.es, n?.en].filter(Boolean).join(' '); }).join(' '))} `;
        for (const t of tokens) {
          const re = new RegExp(`[^a-z0-9]${t}`);
          const hit = texts.find((x) => re.test(x.norm));
          if (hit) { bump(p.id, 0.5 * fWeight(p), { type: 'text', token: t, field: 'symptom', system: hit.system ?? null, text: hit.text }); continue; }
          if (re.test(nameNorm)) { bump(p.id, 0.35 * fWeight(p), { type: 'text', token: t, field: 'name' }); continue; }
          if (re.test(relNorm)) bump(p.id, 0.35 * fWeight(p), { type: 'text', token: t, field: 'relation' });
        }
      }
    }
    return [...scores.values()]
      .map((s) => ({ ...s, score: round(s.score), pair: pairSummary(c.pairs.get(s.pairId), c) }))
      .sort((a, b) => b.score - a.score || (a.pair.number ?? 1e9) - (b.pair.number ?? 1e9))
      .slice(0, limit);
  }

  return { get, pairSummary, pairFull, protocolExpanded, search, suggest, invalidate: () => { cache = null; } };
}

const round = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- routes

export function register(router, { db, catalog: svc }) {
  const one = (val, name) => { if (val === null || val === undefined) throw notFound(`${name} not found`); return val; };
  const idParam = (ctx) => check(catalogId(), ctx.params.id);
  const qParam = (ctx, name = 'q', max = 200) => {
    const q = ctx.query.get(name);
    if (q === null) return null;
    if (q.length > max) throw badRequest(`${name} is too long`, { [name]: `must be at most ${max} characters` });
    return q.trim() || null;
  };
  const enumParam = (ctx, name, values) => {
    const val = ctx.query.get(name);
    if (val === null || val === '') return null;
    if (!values.includes(val)) throw badRequest(`Invalid ${name}`, { [name]: `must be one of: ${values.join(', ')}` });
    return val;
  };
  const page = (list, ctx, def = 500) => {
    const { limit, offset } = paging(ctx.query, { defLimit: def, maxLimit: 5000 });
    return { items: list.slice(offset, offset + limit), total: list.length };
  };

  router.get('/catalog/manifest', () => {
    const meta = catalogMeta(db);
    const c = svc.get();
    return {
      ...(meta?.manifest || {}),
      version: meta?.version ?? null,
      fingerprint: meta?.fingerprint ?? null,
      loadedAt: meta?.loadedAt ?? null,
      counts: meta?.counts ?? {},
      sources: [...c.sources.values()].map((s) => ({ id: s.id, title: s.title, author: s.author ?? null, license_status: s.license_status, notice: s.notice ?? null })),
    };
  });
  router.get('/catalog/sources', () => { const l = [...svc.get().sources.values()]; return { items: l, total: l.length }; });

  router.get('/catalog/points', (ctx) => page([...svc.get().points.values()], ctx, 5000));
  router.get('/catalog/points/:id', (ctx) => one(svc.get().points.get(idParam(ctx)), 'Point'));
  router.get('/catalog/points/:id/pairs', (ctx) => {
    const c = svc.get();
    const id = idParam(ctx);
    const point = one(c.points.get(id), 'Point');
    const items = (c.byPoint.get(id) || []).map((x) => ({ role: x.role, pair: svc.pairSummary(c.pairs.get(x.pairId), c) }));
    return { point, items, total: items.length };
  });
  router.get('/catalog/regions', (ctx) => page(svc.get().regions, ctx, 5000));

  router.get('/catalog/pairs', (ctx) => {
    const c = svc.get();
    const q = qParam(ctx);
    const category = enumParam(ctx, 'category', CATEGORIES);
    const system = enumParam(ctx, 'system', SYSTEMS);
    const levelRaw = ctx.query.get('level');
    let level = null;
    if (levelRaw !== null && levelRaw !== '') {
      if (!/^[0-9]$/.test(levelRaw)) throw badRequest('Invalid level', { level: 'must be an integer 0-9' });
      level = Number(levelRaw);
    }
    const point = ctx.query.get('point') ? check(catalogId(), ctx.query.get('point')) : null;
    const protocol = ctx.query.get('protocol') ? check(catalogId(), ctx.query.get('protocol')) : null;
    let list = [...c.pairs.values()];
    if (q) {
      const ids = svc.search(q, { kinds: ['pair'], limit: 5000 }).items.map((x) => x.id);
      const rank = new Map(ids.map((id, i) => [id, i]));
      list = list.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    }
    if (category) list = list.filter((p) => p.category === category);
    if (level !== null) list = list.filter((p) => (p.level ?? 0) === level);
    if (point) list = list.filter((p) => p.tracking.point === point || p.impact.point === point);
    if (system) list = list.filter((p) => (p.symptoms || []).some((s) => s.system === system) || (c.symptomsByPair.get(p.id) || []).some((sid) => c.symptoms.get(sid)?.system === system));
    if (protocol) {
      const set = new Set((c.expanded.get(protocol) || []).map((x) => x.pairId));
      list = list.filter((p) => set.has(p.id));
    }
    return page(list.map((p) => svc.pairSummary(p, c)), ctx);
  });
  router.get('/catalog/pairs/:id', (ctx) => one(svc.pairFull(idParam(ctx)), 'Pair'));

  router.get('/catalog/entities', (ctx) => {
    const c = svc.get();
    const q = qParam(ctx);
    const kind = enumParam(ctx, 'kind', ['pathogen', 'condition', 'named-pair']);
    const classification = enumParam(ctx, 'classification', CATEGORIES);
    let list = [...c.entities.values()];
    if (q) {
      const ids = new Set(svc.search(q, { kinds: ['entity'], limit: 5000 }).items.map((x) => x.id));
      list = list.filter((e) => ids.has(e.id));
    }
    if (kind) list = list.filter((e) => e.kind === kind);
    if (classification) list = list.filter((e) => e.classification === classification);
    list.sort((a, b) => (a.name.en || a.name.es).localeCompare(b.name.en || b.name.es));
    return page(list.map((e) => ({ id: e.id, name: e.name, kind: e.kind, classification: e.classification ?? null, pairCount: (c.pairsByEntity.get(e.id) || []).length })), ctx);
  });
  router.get('/catalog/entities/:id', (ctx) => {
    const c = svc.get();
    const e = one(c.entities.get(idParam(ctx)), 'Entity');
    return {
      ...e,
      polePairs: (e.polePairs || []).map((pp) => ({ ...pp, negName: c.points.get(pp.neg)?.name ?? null, posName: c.points.get(pp.pos)?.name ?? null })),
      pairs: (c.pairsByEntity.get(e.id) || []).map((pid) => svc.pairSummary(c.pairs.get(pid), c)),
      protocols: (e.protocols || []).filter((pid) => c.protocols.has(pid)).map((pid) => ({ id: pid, name: c.protocols.get(pid).name, kind: c.protocols.get(pid).kind })),
    };
  });

  router.get('/catalog/protocols', (ctx) => {
    const c = svc.get();
    const kind = enumParam(ctx, 'kind', ['basic', 'top10', 'top5', 'disease', 'application']);
    const q = qParam(ctx);
    let list = [...c.protocols.values()];
    if (q) {
      const ids = new Set(svc.search(q, { kinds: ['protocol'], limit: 5000 }).items.map((x) => x.id));
      list = list.filter((p) => ids.has(p.id));
    }
    if (kind) list = list.filter((p) => p.kind === kind);
    return page(list.map((p) => ({ id: p.id, kind: p.kind, name: p.name, source: p.source ?? null, pairCount: c.expanded.get(p.id).length })), ctx);
  });
  router.get('/catalog/protocols/:id', (ctx) => one(svc.protocolExpanded(idParam(ctx)), 'Protocol'));

  router.get('/catalog/symptoms', (ctx) => {
    const c = svc.get();
    const q = qParam(ctx);
    const system = enumParam(ctx, 'system', SYSTEMS);
    let list = [...c.symptoms.values()];
    if (q) {
      const ids = new Set(svc.search(q, { kinds: ['symptom'], limit: 5000 }).items.map((x) => x.id));
      list = list.filter((s) => ids.has(s.id));
    }
    if (system) list = list.filter((s) => s.system === system);
    list.sort((a, b) => (a.name.en || a.name.es).localeCompare(b.name.en || b.name.es));
    return page(list.map((s) => ({ id: s.id, system: s.system ?? null, name: s.name, pairs: s.pairs, pairCount: s.pairs.length })), ctx);
  });

  const suggestSchema = v.object({
    symptoms: v.array(catalogId(), { max: 100, unique: true }).default([]),
    text: v.string({ max: 2000, multiline: true }).optional().nullable(),
    limit: v.int({ min: 1, max: 100 }).optional(),
  });
  router.post('/catalog/suggest', (ctx) => {
    const body = check(suggestSchema, ctx.body ?? {});
    const items = svc.suggest({ symptoms: body.symptoms, text: body.text || '' }, body.limit || 25);
    return { items, total: items.length };
  });

  router.get('/catalog/search', (ctx) => {
    const q = qParam(ctx);
    if (!q) return { items: [], total: 0 };
    const kindsRaw = ctx.query.get('kinds');
    const kinds = kindsRaw ? kindsRaw.split(',').filter((k) => ['pair', 'point', 'entity', 'protocol', 'symptom'].includes(k)) : undefined;
    const { limit } = paging(ctx.query, { defLimit: 50, maxLimit: 500 });
    return svc.search(q, { kinds, limit });
  });

  router.get('/catalog/contraindications', (ctx) => page(svc.get().contraindications, ctx));
  router.get('/catalog/recommendations', (ctx) => page(svc.get().recommendations, ctx));
  router.get('/catalog/glossary', (ctx) => page(svc.get().glossary, ctx, 5000));
}
