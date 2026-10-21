// i18n: UI strings from /locales/{en,es}.json; catalog text via loc().
import { el } from './ui/dom.js';

export const LOCALES = ['en', 'es'];
const catalogs = {};
let current = 'en';
const listeners = new Set();

async function load(locale) {
  if (catalogs[locale]) return catalogs[locale];
  const res = await fetch(`/locales/${locale}.json`, { credentials: 'same-origin', cache: 'no-cache' });
  if (!res.ok) throw new Error(`locale ${locale} failed to load`);
  catalogs[locale] = await res.json();
  return catalogs[locale];
}

export async function initI18n(locale) {
  await load('en');
  await setLocale(locale, { silent: true });
}

export function detectLocale() {
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return LOCALES.includes(nav) ? nav : 'en';
}

export async function setLocale(locale, { silent = false } = {}) {
  const l = LOCALES.includes(locale) ? locale : 'en';
  await load(l);
  current = l;
  document.documentElement.lang = l;
  if (!silent) for (const fn of listeners) fn(l);
}

export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getLocale() { return current; }

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
  if (s === undefined) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined && vars[n] !== null ? String(vars[n]) : m));
  return s;
}

/** Localized catalog text: name[locale] ?? name.es. Returns { text, fallback }. */
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
    node.append(' ', el('abbr.badge-es', { title: t('common.untranslated'), lang: 'en' }, 'ES'));
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
function intlLocale() { return current === 'es' ? 'es-US' : 'en-US'; }

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
