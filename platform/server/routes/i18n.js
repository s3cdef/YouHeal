// Language packs API (CONTRACT §9.3). Public: pack list + UI strings (needed before login; no PHI).
// Admin: coverage, string review/search, overrides (audited by key only — never the text), export.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { v, check, paging } from '../lib/validate.js';
import { notFound, badRequest, sendJson } from '../lib/http.js';
import { normalizeText } from '../lib/crypto.js';
import { PERM } from '../lib/rbac.js';
import { BASELINE, LOCALE_RE, effective, deepFallback } from '../i18n/packs.js';

const KNOWN_NAMES = { es: ['Spanish', 'Español'], en: ['English', 'English'] };

/** Locales usable for UI/report: loaded packs, else the locales the shipped catalog carries (es, en). */
export function availableLocales(db) {
  const rows = db.all('SELECT locale FROM i18n_packs ORDER BY CASE role WHEN \'baseline\' THEN 0 ELSE 1 END, locale').map((r) => r.locale);
  return rows.length ? rows : ['es', 'en'];
}

const bumpRev = (db) => db.run("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('i18n_rev', ?)", `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);

export function register(router, { db, cfg, RAW }) {
  // ------------------------------------------------------------ effective-state computation (cached per revision)
  let cache = null;
  const rev = () => db.all("SELECT key, value FROM catalog_meta WHERE key IN ('fingerprint','i18n_rev')").map((r) => r.value).join('|');
  function state() {
    const r = rev();
    if (cache?.rev === r) return cache;
    const baseline = new Map(db.all('SELECT key, text, src_hash FROM i18n_strings WHERE locale = ?', BASELINE).map((x) => [x.key, x]));
    cache = { rev: r, baseline, perLocale: new Map() };
    return cache;
  }
  function localeState(locale) {
    const st = state();
    if (st.perLocale.has(locale)) return st.perLocale.get(locale);
    const entries = new Map(db.all('SELECT key, text, src_hash, status FROM i18n_strings WHERE locale = ?', locale)
      .map((x) => [x.key, { text: x.text, srcHash: x.src_hash, status: x.status }]));
    const overrides = new Map(db.all('SELECT key, text, src_hash FROM i18n_overrides WHERE locale = ?', locale).map((x) => [x.key, x]));
    const rows = [];
    const byStatus = { curated: 0, machine: 0, reviewed: 0, missing: 0, stale: 0 };
    for (const [key, b] of st.baseline) {
      const entry = entries.get(key), ov = overrides.get(key);
      const eff = effective(b.src_hash, entry, ov);
      byStatus[eff.status]++;
      rows.push({ key, baseline: b.text, baselineHash: b.src_hash, text: eff.text, status: eff.status, override: Boolean(eff.override),
        staleOverride: Boolean(ov && ov.src_hash !== b.src_hash), packText: entry?.text ?? null, packStatus: entry?.status ?? null, staleText: eff.staleText ?? null });
    }
    const fields = st.baseline.size;
    const translated = byStatus.curated + byStatus.machine + byStatus.reviewed;
    const out = { rows, byStatus, fields, translated, percent: fields ? Math.round((translated / fields) * 1000) / 10 : 0 };
    st.perLocale.set(locale, out);
    return out;
  }
  const packRow = (locale) => db.get('SELECT * FROM i18n_packs WHERE locale = ?', locale);
  const localeParam = (ctx) => {
    const l = ctx.params.locale;
    if (!LOCALE_RE.test(l)) throw badRequest('Invalid locale', { locale: 'has an invalid format' });
    return l;
  };
  const requirePack = (locale) => {
    const p = packRow(locale);
    if (!p) throw notFound('Language pack not found');
    return p;
  };

  // ------------------------------------------------------------ public
  router.get('/i18n/packs', () => {
    const packs = db.all("SELECT * FROM i18n_packs ORDER BY CASE role WHEN 'baseline' THEN 0 ELSE 1 END, locale");
    if (!packs.length) {
      // no packs embedded yet: advertise the locales whose UI strings ship with the app
      const items = availableLocales(db).filter((l) => uiSource(l)).map((l) => ({
        locale: l, name: KNOWN_NAMES[l]?.[0] ?? l, nativeName: KNOWN_NAMES[l]?.[1] ?? l, dir: 'ltr', role: l === BASELINE ? 'baseline' : 'mirror', coverage: null,
      }));
      return { items, total: items.length };
    }
    const items = packs.map((p) => {
      const cov = p.role === 'baseline' ? { percent: 100, missing: 0, stale: 0 } : (() => { const s = localeState(p.locale); return { percent: s.percent, missing: s.byStatus.missing, stale: s.byStatus.stale }; })();
      return { locale: p.locale, name: p.name, nativeName: p.native_name, dir: p.dir, role: p.role, coverage: cov };
    });
    return { items, total: items.length };
  }, { public: true });

  function uiSource(locale) {
    const row = db.get('SELECT json FROM i18n_ui WHERE locale = ?', locale);
    if (row) return JSON.parse(row.json);
    for (const f of [path.join(cfg.i18nDir, locale, 'ui.json'), path.join(cfg.webDir, 'locales', `${locale}.json`)]) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* try next */ }
    }
    return null;
  }

  router.get('/i18n/packs/:locale/ui', (ctx) => {
    const locale = localeParam(ctx);
    const ui = uiSource(locale);
    if (!ui) throw notFound('No UI strings for this locale');
    const en = locale === 'en' ? null : uiSource('en');
    const body = Buffer.from(JSON.stringify(en ? deepFallback(ui, en) : ui));
    const etag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    const res = ctx.res;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if ((ctx.req.headers['if-none-match'] || '').split(',').map((x) => x.trim()).includes(etag)) { res.statusCode = 304; res.end(); return RAW; }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', body.length);
    res.end(ctx.req.method === 'HEAD' ? undefined : body);
    return RAW;
  }, { public: true });

  // ------------------------------------------------------------ admin
  router.get('/i18n/packs/:locale/coverage', (ctx) => {
    const locale = localeParam(ctx);
    const p = requirePack(locale);
    const { limit, offset } = paging(ctx.query, { defLimit: 50, maxLimit: 500 });
    if (p.role === 'baseline') {
      const fields = state().baseline.size;
      return { locale, role: 'baseline', fields, translated: fields, percent: 100, byStatus: {}, stale: [], staleTotal: 0, missing: [], missingTotal: 0 };
    }
    const s = localeState(locale);
    const stale = s.rows.filter((r) => r.status === 'stale');
    const missing = s.rows.filter((r) => r.status === 'missing');
    return {
      locale, role: 'mirror', fields: s.fields, translated: s.translated, percent: s.percent, byStatus: s.byStatus,
      stale: stale.slice(offset, offset + limit).map((r) => ({ key: r.key, baseline: r.baseline, text: r.staleText ?? r.packText })),
      staleTotal: stale.length,
      missing: missing.slice(offset, offset + limit).map((r) => ({ key: r.key, baseline: r.baseline })),
      missingTotal: missing.length,
      overrides: s.rows.filter((r) => r.override).length,
      staleOverrides: s.rows.filter((r) => r.staleOverride).length,
    };
  }, { roles: PERM.admin });

  router.get('/i18n/strings', (ctx) => {
    const locale = ctx.query.get('locale') || '';
    if (!LOCALE_RE.test(locale)) throw badRequest('locale is required', { locale: 'is required' });
    const p = requirePack(locale);
    if (p.role !== 'mirror') throw badRequest('Choose a mirror (translated) locale', { locale: 'must be a mirror pack' });
    const status = ctx.query.get('status');
    if (status && !['curated', 'machine', 'reviewed', 'missing', 'stale'].includes(status)) throw badRequest('Invalid status', { status: 'must be curated|machine|reviewed|missing|stale' });
    const q = normalizeText(ctx.query.get('q') || '').slice(0, 200);
    const { limit, offset } = paging(ctx.query, { defLimit: 50, maxLimit: 500 });
    let rows = localeState(locale).rows;
    if (status) rows = rows.filter((r) => r.status === status);
    if (q) rows = rows.filter((r) => r.key.toLowerCase().includes(q) || normalizeText(r.baseline).includes(q) || (r.text && normalizeText(r.text).includes(q)));
    const items = rows.slice(offset, offset + limit).map(({ staleText, ...r }) => r);
    return { items, total: rows.length };
  }, { roles: PERM.admin });

  const keySchema = v.string({ min: 3, max: 400, pattern: /^[a-z-]+\/[^\s]+\/[^\s]+$/ });
  const mirrorTarget = (locale, key) => {
    const p = requirePack(locale);
    if (p.role !== 'mirror') throw badRequest('The Spanish baseline cannot be overridden; edit the catalog instead', { locale: 'must be a mirror pack' });
    const b = state().baseline.get(key);
    if (!b) throw notFound('Unknown catalog text key');
    return b;
  };

  router.put('/i18n/strings', (ctx) => {
    const body = check(v.object({ locale: v.string({ pattern: LOCALE_RE }), key: keySchema, text: v.string({ min: 1, max: 20000, multiline: true }) }), ctx.body);
    const b = mirrorTarget(body.locale, body.key);
    db.tx(() => {
      db.run(`INSERT INTO i18n_overrides (locale, key, text, src_hash, edited_by, edited_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(locale, key) DO UPDATE SET text = excluded.text, src_hash = excluded.src_hash, edited_by = excluded.edited_by, edited_at = excluded.edited_at`,
      body.locale, body.key, body.text, b.src_hash, ctx.user.id, new Date().toISOString());
      bumpRev(db);
      ctx.audit('i18n.string.update', { targetType: 'i18n_string', targetId: `${body.locale}:${body.key}`, detail: { locale: body.locale, key: body.key, srcHash: b.src_hash } });
    });
    const row = localeState(body.locale).rows.find((r) => r.key === body.key);
    return { ok: true, item: (({ staleText, ...r }) => r)(row) };
  }, { roles: PERM.admin });

  router.delete('/i18n/strings', (ctx) => {
    const body = check(v.object({ locale: v.string({ pattern: LOCALE_RE }), key: keySchema }), ctx.body);
    mirrorTarget(body.locale, body.key);
    const r = db.tx(() => {
      const res = db.run('DELETE FROM i18n_overrides WHERE locale = ? AND key = ?', body.locale, body.key);
      if (!res.changes) return res;
      bumpRev(db);
      ctx.audit('i18n.string.revert', { targetType: 'i18n_string', targetId: `${body.locale}:${body.key}`, detail: { locale: body.locale, key: body.key } });
      return res;
    });
    if (!r.changes) throw notFound('No override for this key');
    const row = localeState(body.locale).rows.find((x) => x.key === body.key);
    return { ok: true, item: (({ staleText, ...x }) => x)(row) };
  }, { roles: PERM.admin });

  router.get('/i18n/packs/:locale/export', (ctx) => {
    const locale = localeParam(ctx);
    const p = requirePack(locale);
    const out = {};
    if (p.role === 'baseline') {
      for (const [key, b] of [...state().baseline].sort(([a], [b2]) => (a < b2 ? -1 : 1))) out[key] = { text: b.text, hash: b.src_hash };
    } else {
      for (const r of [...localeState(locale).rows].sort((a, b) => (a.key < b.key ? -1 : 1))) {
        out[r.key] = { text: r.text ?? (r.status === 'stale' ? r.staleText : null), srcHash: r.status === 'stale' ? (db.get('SELECT src_hash FROM i18n_strings WHERE locale = ? AND key = ?', locale, r.key)?.src_hash ?? r.baselineHash) : r.baselineHash, status: r.status };
      }
    }
    ctx.audit('i18n.export', { targetType: 'i18n_pack', targetId: locale, detail: { locale, keys: Object.keys(out).length } });
    ctx.res.setHeader('Content-Disposition', `attachment; filename="${locale}-catalog.json"`);
    sendJson(ctx.res, 200, out);
    return RAW;
  }, { roles: PERM.admin });
}

