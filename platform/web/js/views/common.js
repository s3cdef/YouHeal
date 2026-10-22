// Shared view helpers: page header, patient formatting, error panels, theme.
import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { t, ageFrom, fmtDate } from '../i18n.js';
import { errorMessage } from '../api.js';
import { alertBox } from '../ui/components.js';

export function pageHeader({ title, subtitle = null, actions = [], back = null, eyebrow = null, meta = null }) {
  return el('header.page-head',
    el('div.page-head-main',
      back ? el('a.back-link', { href: back.href }, icon('arrowLeft', { size: 16 }), el('span', back.label)) : null,
      eyebrow ? el('p.eyebrow', eyebrow) : null,
      el('h1.page-title', { tabindex: '-1' }, title),
      subtitle ? el('p.page-sub', subtitle) : null,
      meta,
    ),
    actions && actions.length ? el('div.page-actions', actions) : null,
  );
}

export function fullName(p) {
  if (!p) return '—';
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || '—';
}
export function initials(p) {
  const n = fullName(p).split(/\s+/).filter(Boolean);
  return ((n[0] || '?')[0] + (n.length > 1 ? n[n.length - 1][0] : '')).toUpperCase();
}
export function avatar(p, size = '') {
  return el(`span.avatar${size ? '.avatar-' + size : ''}`, { aria: { hidden: 'true' } }, initials(p));
}
export function demographics(p) {
  const parts = [];
  const age = ageFrom(p.dob);
  if (age !== null) parts.push(t('patient.ageYears', { age }));
  if (p.sex) parts.push(t(`sex.${p.sex}`));
  if (p.dob) parts.push(fmtDate(p.dob));
  if (p.mrn) parts.push(`${t('patient.mrnShort')} ${p.mrn}`);
  return parts.join(' · ');
}

export function errorPanel(err, retry) {
  return el('div.page-error',
    alertBox({ tone: 'danger', title: t('errors.loadFailed'), children: [el('p', errorMessage(err))] }),
    retry ? el('button.btn.btn-secondary', { type: 'button', onClick: retry }, icon('refresh', { size: 18 }), t('common.retry')) : null,
  );
}

export function focusTitle(root = document) {
  const h = root.querySelector('h1.page-title, h1[tabindex]');
  if (h) h.focus({ preventScroll: false });
}

// ---------- theme (localStorage allowed for theme only) ----------
const THEME_KEY = 'yh.theme';
export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}
export function applyTheme(theme) {
  const th = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.theme = th;
  try { localStorage.setItem(THEME_KEY, th); } catch { /* ignore */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effectiveTheme() === 'dark' ? '#0B1217' : '#F6F4EF');
}
export function effectiveTheme() {
  const th = document.documentElement.dataset.theme;
  if (th === 'light' || th === 'dark') return th;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const LAST_ROUTE_KEY = 'yh.lastRoute';
export function rememberRoute(path) {
  try { if (path && !/^\/(login|setup|mfa)/.test(path)) localStorage.setItem(LAST_ROUTE_KEY, path); } catch { /* ignore */ }
}
export function lastRoute() { try { return localStorage.getItem(LAST_ROUTE_KEY); } catch { return null; } }

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDaysISO(iso, n) {
  const d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

export function methodologyLabel(m) { return m ? t(`methodology.${m}`) : '—'; }
