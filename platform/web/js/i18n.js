// i18n (CONTRACT §9): UI strings come from the language packs served by the API
// (GET /api/v1/i18n/packs/:locale/ui); the language menu from GET /api/v1/i18n/packs.
// A minimal built-in English set lets the app explain itself when the API is unreachable.
import { el } from './ui/dom.js';

const BUILTIN_EN = {
  app: { title: 'YOU HEAL Clinical', clinical: 'Clinical', homeLabel: 'YOU HEAL Clinical — home' },
  common: { retry: 'Retry', untranslated: 'Spanish original — translation pending or out of date' },
  errors: {
    generic: 'Something went wrong. Please try again.',
    network: 'Cannot reach the server. Check your connection and try again.',
    timeout: 'The server took too long to respond. Please try again.',
    viewLoad: 'This page could not be loaded. Reload the app and try again.',
    serverUnreachable: 'The server is not reachable',
    serverUnreachableBody: 'YOU HEAL Clinical could not contact its server. Make sure it is running, then retry.',
    languagePackUnavailable: 'The language pack could not be loaded; showing English.',
  },
};
const FALLBACK_PACKS = [{ locale: 'en', name: 'English', nativeName: 'English', dir: 'ltr', role: 'mirror' }];
const INTL = { en: 'en-US', es: 'es-US' };

const catalogs = { };
let packs = null;
let current = 'en';
const listeners = new Set();

async function fetchJson(url) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-cache', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Language packs installed on the server ([{locale, name, nativeName, dir, role, coverage}]). */
export async function loadPacks(force = false) {
  if (packs && !force) return packs;
  try {
    const data = await fetchJson('/api/v1/i18n/packs');
    const list = Array.isArray(data) ? data : (data && (data.packs || data.items)) || [];
    packs = list.filter((p) => p && p.locale);
    if (!packs.length) packs = FALLBACK_PACKS.slice();
  } catch { packs = packs || FALLBACK_PACKS.slice(); }
  return packs;
}
export function getPacks() { return packs || FALLBACK_PACKS; }
export function packInfo(locale) { return getPacks().find((p) => p.locale === locale) || null; }
export function localeLabel(locale) { const p = packInfo(locale); return (p && (p.nativeName || p.name)) || String(locale || '').toUpperCase(); }
/** Name of a language in the active locale (e.g. "inglés" while rendering Spanish), else its native name. */
export function languageName(locale) {
  try { const n = new Intl.DisplayNames([intlLocale()], { type: 'language' }).of(locale); if (n && n !== locale) return n; } catch { /* older engines */ }
  return localeLabel(locale);
}
export function isLocale(locale) { return !!locale && getPacks().some((p) => p.locale === locale); }

async function load(locale) {
  if (catalogs[locale]) return catalogs[locale];
  try {
    const data = await fetchJson(`/api/v1/i18n/packs/${encodeURIComponent(locale)}/ui`);
    catalogs[locale] = data && typeof data === 'object' && data.strings && typeof data.strings === 'object' ? data.strings : data;
  } catch (err) {
    if (locale !== 'en') throw err;
    console.warn('[i18n] UI language pack unavailable; using built-in English');
    catalogs.en = BUILTIN_EN;
  }
  return catalogs[locale];
}

/** Make sure a pack's UI strings are loaded (e.g. to render the report in another language). */
export async function ensureLocale(locale) { try { await load(locale); return true; } catch { return false; } }

export async function initI18n(locale = null) {
  await loadPacks();
  await load('en');
  await setLocale(locale || detectLocale(), { silent: true });
}

/** The browser language if a pack exists for it, else English. */
export function detectLocale() {
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return isLocale(nav) ? nav : 'en';
}

export async function setLocale(locale, { silent = false } = {}) {
  let l = isLocale(locale) ? locale : 'en';
  try { await load(l); } catch { l = 'en'; await load('en'); }
  current = l;
  const p = packInfo(l);
  document.documentElement.lang = l;
  document.documentElement.dir = p && p.dir === 'rtl' ? 'rtl' : 'ltr';
  if (!silent) for (const fn of listeners) fn(l);
}

export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getLocale() { return current; }

/**
 * Render synchronously in another loaded locale (t, loc, locNode and the formatters all follow it).
 * Used by the report, whose language is chosen independently of the UI language.
 */
export function inLocale(locale, fn) {
  const prev = current;
  current = catalogs[locale] ? locale : prev;
  try { return fn(); } finally { current = prev; }
}

function lookup(cat, key) {
  let v = cat;
  for (const part of key.split('.')) {
    if (v && typeof v === 'object' && part in v) v = v[part];
    else return undefined;
  }
  return typeof v === 'string' ? v : undefined;
}

/** t('scan.title', { name: 'Ana' }) — {name} placeholders; {count} picks .one/.other plural keys. */
export function t(key, vars) {
  let k = key;
  if (vars && typeof vars.count === 'number') {
    const plural = vars.count === 1 ? `${key}.one` : `${key}.other`;
    if (lookup(catalogs[current], plural) !== undefined || lookup(catalogs.en, plural) !== undefined) k = plural;
  }
  let s = lookup(catalogs[current], k);
  if (s === undefined) s = lookup(catalogs.en, k);
  if (s === undefined) s = lookup(BUILTIN_EN, k);
  if (s === undefined) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined && vars[n] !== null ? String(vars[n]) : m));
  return s;
}

/**
 * Localized catalog text: name[locale] ?? name.es (the Spanish baseline). Returns { text, fallback }.
 * The server omits a locale whose mirror entry is missing or stale (§9.4), so fallback === "show the ES badge".
 */
export function loc(obj, locale = current) {
  if (obj === null || obj === undefined) return { text: '', fallback: false };
  if (typeof obj === 'string') return { text: obj, fallback: false };
  if (obj[locale]) return { text: obj[locale], fallback: false };
  if (obj.es) return { text: obj.es, fallback: locale !== 'es' };
  const any = Object.values(obj).find(Boolean);
  return { text: any || '', fallback: !!any };
}
export function locText(obj) { return loc(obj).text; }

/** Span with the localized text and a small "ES" badge when falling back to Spanish. */
export function locNode(obj, tag = 'span', cls = '') {
  const { text, fallback } = loc(obj);
  const node = el(`${tag}${cls ? '.' + cls.split(' ').join('.') : ''}`, text);
  if (fallback) {
    node.lang = 'es';
    node.append(' ', el('abbr.badge-es', { title: t('common.untranslated'), aria: { label: t('common.untranslated') }, lang: current, data: { i18nFallback: 'es' } }, 'ES'));
  }
  return node;
}

// ---- catalog vocabularies (GET /catalog/manifest → vocabularies: categories, systems, sides, qualifiers) ----
const vocabs = {};
export function setVocabularies(v) {
  for (const [kind, list] of Object.entries(v || {})) if (Array.isArray(list)) vocabs[kind] = new Map(list.map((x) => [x.id, x]));
}
const VOCAB_KEY = { categories: 'category', systems: 'system', sides: 'side', qualifiers: 'qualifier' };
/** Label for a vocabulary id: manifest first, then the UI catalog, then the id itself. */
export function vocab(kind, id) {
  const hit = vocabs[kind] && vocabs[kind].get(id);
  if (hit && hit.name) { const l = loc(hit.name); if (l.text && !l.fallback) return l.text; }
  const k = `${VOCAB_KEY[kind] || kind}.${id}`;
  const v = t(k);
  if (v !== k) return v;
  return hit && hit.name ? loc(hit.name).text : String(id);
}

// ---- formatters ----
/** BCP-47 tag for Intl formatting in the active locale. */
export function intlLocale() { return INTL[current] || current || 'en-US'; }

export function parseDateOnly(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function fmtDate(s, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  const d = parseDateOnly(s); return d ? new Intl.DateTimeFormat(intlLocale(), opts).format(d) : '—';
}
export function fmtDateTime(s) {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime())
    ? new Intl.DateTimeFormat(intlLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d) : '—';
}
export function fmtTime(s) {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric', minute: '2-digit' }).format(d) : '—';
}
export function fmtRelativeDay(s) {
  const d = parseDateOnly(s); if (!d) return '—';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const diff = Math.round((dd - today) / 86400000);
  return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(diff, 'day');
}
export function ageFrom(dob, at = new Date()) {
  const d = parseDateOnly(dob); if (!d) return null;
  let a = at.getFullYear() - d.getFullYear();
  const m = at.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < d.getDate())) a -= 1;
  return a;
}
export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'); const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
export function fmtNumber(n) { return new Intl.NumberFormat(intlLocale()).format(n); }
