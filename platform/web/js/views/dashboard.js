// Dashboard: today's sessions, drafts to finalize, follow-ups due, recent patients, quick search.
import { el, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, NotFoundError } from '../api.js';
import { t, fmtTime, fmtDate, fmtRelativeDay, locText, parseDateOnly } from '../i18n.js';
import { navigate } from '../router.js';
import { state, can, normSession } from '../state.js';
import { combobox } from '../ui/combobox.js';
import { card, emptyState, statusBadge, skeleton, chip } from '../ui/components.js';
import { pageHeader, fullName, avatar, demographics, todayISO, addDaysISO, methodologyLabel, errorPanel } from './common.js';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? t('dashboard.morning') : h < 18 ? t('dashboard.afternoon') : t('dashboard.evening');
}

export function quickSearch({ autofocus = false } = {}) {
  const cb = combobox({
    label: t('dashboard.searchLabel'), placeholder: can.patients() ? t('dashboard.searchPlaceholder') : t('dashboard.searchPlaceholderCatalog'), size: 'lg',
    source: async (q) => {
      const [pts, cat] = await Promise.all([
        can.patients() ? api.get('/patients', { q, limit: 6 }).then(items).catch(() => []) : [],
        api.get('/catalog/search', { q, limit: 12 }).then(items).catch(() => []),
      ]);
      return [
        ...pts.map((p) => ({ id: p.id, type: 'patient', label: fullName(p), sublabel: `${t('search.types.patient')} · ${demographics(p)}`, badge: chip(t('search.types.patient'), 'teal') })),
        ...cat.slice(0, 8).map((r) => { const type = r.kind || r.type; return { id: r.id, type, label: `${r.number ? '#' + r.number + ' ' : ''}${locText(r.name)}`, sublabel: t(`search.types.${type}`), badge: chip(t(`search.types.${type}`), type === 'pair' ? 'gold' : 'slate') }; }),
      ];
    },
    onSelect: (it) => {
      if (it.type === 'patient') navigate(`/patients/${it.id}`);
      else if (it.type === 'pair') navigate(`/catalog/pairs?open=${encodeURIComponent(it.id)}`);
      else if (it.type === 'protocol') navigate(`/catalog/protocols?open=${encodeURIComponent(it.id)}`);
      else if (it.type === 'entity') navigate(`/catalog/entities?q=${encodeURIComponent(it.label)}`);
      else if (it.type === 'symptom') navigate(`/catalog/symptoms?q=${encodeURIComponent(it.label)}`);
      else if (it.type === 'point') navigate(`/catalog/pairs?point=${encodeURIComponent(it.id)}`);
    },
  });
  if (autofocus) queueMicrotask(() => cb.focus());
  return cb.root;
}

function sessionRow(s, { showDate = false, action = null } = {}) {
  const href = !can.clinical() ? `#/patients/${s.patientId}/sessions` : s.status === 'draft' ? `#/sessions/${s.id}` : `#/sessions/${s.id}/report`;
  return el('li.list-row',
    el('a.list-row-link', { href },
      el('span.list-time', showDate ? fmtDate(s.startedAt, { month: 'short', day: 'numeric' }) : fmtTime(s.startedAt)),
      avatar(s.patient || {}),
      el('span.list-main', el('span.list-title', fullName(s.patient)), el('span.list-sub', [methodologyLabel(s.methodology), s.chiefComplaint].filter(Boolean).join(' · '))),
      el('span.list-meta', s.findingsCount !== undefined ? el('span.count-pill', { title: t('dashboard.findingsCount', { count: s.findingsCount }) }, icon('target', { size: 14 }), String(s.findingsCount)) : null, statusBadge(s.status)),
      action || el('span.list-chevron', icon('chevronRight', { size: 18 }))));
}

function stat(label, value, ic, tone, target) {
  if (target.startsWith('#/')) return el('a.stat', { href: target, data: { tone } }, el('span.stat-icon', icon(ic, { size: 20 })), el('span.stat-value', String(value)), el('span.stat-label', label));
  const b = el('button.stat', { type: 'button', data: { tone } }, el('span.stat-icon', icon(ic, { size: 20 })), el('span.stat-value', String(value)), el('span.stat-label', label));
  b.addEventListener('click', () => {
    const n = document.getElementById(target); if (!n) return;
    n.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    const h = n.querySelector('h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  });
  return b;
}

export async function renderDashboard({ main }) {
  const user = state.user || {};
  const header = pageHeader({
    eyebrow: new Intl.DateTimeFormat(document.documentElement.lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()),
    title: `${greeting()}, ${(user.name || '').split(' ').slice(0, 2).join(' ')}`,
    actions: [
      can.patients() ? el('a.btn.btn-primary', { href: '#/patients/new' }, icon('plus', { size: 18 }), t('patients.new')) : null,
    ].filter(Boolean),
  });
  const statsSlot = el('div.stats', skeleton(1));
  const grid = el('div.dash-grid', skeleton(6));
  mount(main, el('div.page.page-dashboard', header, el('div.dash-search', quickSearch()), statsSlot, grid));

  const today = todayISO();
  const tomorrow = addDaysISO(today, 1);
  async function load() {
    const patients = items(await api.get('/patients', { limit: 50 }));
    const byId = new Map(patients.map((p) => [p.id, p]));
    let sessions;
    try {
      // Preferred (not in CONTRACT §5 yet): cross-patient listing.
      sessions = items(await api.get('/sessions', { limit: 200 }));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      // Fallback: aggregate per-patient session summaries for the most recent patients.
      const lists = await Promise.all(patients.slice(0, 40).map((p) => api.get(`/patients/${encodeURIComponent(p.id)}/sessions`).then(items).catch(() => [])));
      sessions = lists.flat();
    }
    sessions = sessions.map(normSession).map((s) => ({ ...s, patient: s.patient || byId.get(s.patientId) || null })).filter((s) => !s.supersededBy);
    sessions.sort((x, y) => String(y.startedAt).localeCompare(String(x.startedAt)));
    const isToday = (iso) => iso && todayISO(new Date(iso)) === today;
    const latestByPatient = new Map();
    for (const s of sessions) if (!latestByPatient.has(s.patientId)) latestByPatient.set(s.patientId, s);
    const todays = sessions.filter((s) => isToday(s.startedAt)).sort((x, y) => String(x.startedAt).localeCompare(String(y.startedAt)));
    const drafts = sessions.filter((s) => s.status === 'draft');
    const follow = [...latestByPatient.values()].filter((s) => s.status !== 'draft' && s.followUpDate && s.followUpDate <= addDaysISO(today, 7)).sort((x, y) => x.followUpDate.localeCompare(y.followUpDate));
    for (const p of patients) { const l = latestByPatient.get(p.id); p.lastSessionAt = l ? l.startedAt : null; }
    return { todays, drafts, follow, patients };
  }
  let data;
  try { data = await load(); } catch (err) { mount(grid, errorPanel(err, () => renderDashboard({ main }))); statsSlot.remove(); return null; }
  const due = data.follow.filter((s) => s.followUpDate && s.followUpDate <= tomorrow);
  mount(statsSlot,
    stat(t('dashboard.statToday'), data.todays.length, 'calendar', 'teal', 'dash-today'),
    stat(t('dashboard.statDrafts'), data.drafts.length, 'edit', 'amber', 'dash-drafts'),
    stat(t('dashboard.statFollowUps'), due.length, 'refresh', 'violet', 'dash-follow'),
    stat(t('dashboard.statPatients'), data.patients.length, 'users', 'slate', '#/patients'),
  );

  const todayCard = card({
    title: t('dashboard.today'), icon: 'calendar', cls: 'card-today',
    children: data.todays.length ? el('ul.list', data.todays.map((s) => sessionRow(s))) : emptyState({ icon: 'calendar', title: t('dashboard.noToday'), body: t('dashboard.noTodayBody'), compact: true }),
  });
  todayCard.id = 'dash-today';
  const draftCard = card({
    title: t('dashboard.drafts'), icon: 'edit', sub: data.drafts.length ? t('dashboard.draftsSub') : null,
    children: data.drafts.length ? el('ul.list', data.drafts.map((s) => sessionRow(s, { showDate: true, action: el('span.btn.btn-sm.btn-secondary', t('dashboard.resume')) }))) : emptyState({ icon: 'check', title: t('dashboard.noDrafts'), compact: true }),
  });
  draftCard.id = 'dash-drafts';
  const followCard = card({
    title: t('dashboard.followUps'), icon: 'refresh', sub: t('dashboard.followUpsSub'),
    children: data.follow.length ? el('ul.list', data.follow.map((s) => {
      const d = parseDateOnly(s.followUpDate); const overdue = d && s.followUpDate < today;
      return el('li.list-row', el('a.list-row-link', { href: `#/patients/${s.patientId}` },
        avatar(s.patient || {}),
        el('span.list-main', el('span.list-title', fullName(s.patient)), el('span.list-sub', t('dashboard.lastScan', { date: fmtDate(s.startedAt) }))),
        el(`span.due${overdue ? '.is-overdue' : s.followUpDate === today ? '.is-today' : ''}`, icon(overdue ? 'alert' : 'clock', { size: 14 }), fmtRelativeDay(s.followUpDate)),
        el('span.list-chevron', icon('chevronRight', { size: 18 }))));
    })) : emptyState({ icon: 'refresh', title: t('dashboard.noFollowUps'), compact: true }),
  });
  followCard.id = 'dash-follow';
  const recent = [...data.patients].sort((a, b) => String(b.lastSessionAt || b.createdAt || '').localeCompare(String(a.lastSessionAt || a.createdAt || ''))).slice(0, 6);
  const recentCard = card({
    title: t('dashboard.recentPatients'), icon: 'users',
    actions: el('a.btn.btn-sm.btn-ghost', { href: '#/patients' }, t('common.viewAll'), icon('chevronRight', { size: 16 })),
    children: recent.length ? el('ul.list', recent.map((p) => el('li.list-row', el('a.list-row-link', { href: `#/patients/${p.id}` },
      avatar(p), el('span.list-main', el('span.list-title', fullName(p)), el('span.list-sub', demographics(p))),
      el('span.list-meta.muted', p.lastSessionAt ? t('dashboard.lastScanShort', { date: fmtDate(p.lastSessionAt, { month: 'short', day: 'numeric' }) }) : t('dashboard.noScans')),
      el('span.list-chevron', icon('chevronRight', { size: 18 })))))) : emptyState({ icon: 'users', title: t('patients.empty'), body: t('patients.emptyBody'), compact: true, action: can.patients() ? el('a.btn.btn-primary', { href: '#/patients/new' }, icon('plus', { size: 18 }), t('patients.new')) : null }),
  });
  mount(grid, el('div.dash-col', todayCard, draftCard), el('div.dash-col', followCard, recentCard));
  return null;
}

export async function renderNotFound({ main }) {
  mount(main, el('div.page', pageHeader({ title: t('errors.notFoundTitle') }), emptyState({ icon: 'alert', title: t('errors.notFoundBody'), action: el('a.btn.btn-primary', { href: '#/' }, t('nav.dashboard')) })));
  return null;
}
