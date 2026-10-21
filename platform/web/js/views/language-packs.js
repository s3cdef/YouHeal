// Settings → Language packs (admin, CONTRACT §9.3/9.4): coverage per pack, stale/missing review lists
// with search, inline edit (PUT /i18n/strings → override), revert (DELETE /i18n/strings) and export.
import { el, mount, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, errorMessage } from '../api.js';
import { t, fmtNumber, fmtDateTime, loadPacks, localeLabel, intlLocale } from '../i18n.js';
import { card, select, input, textarea, chip, emptyState, skeleton, setLoading, alertBox } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { errorPanel } from './common.js';

const STATUSES = ['curated', 'machine', 'reviewed', 'missing', 'stale'];
const STATUS_TONE = { curated: 'teal', machine: 'slate', reviewed: 'teal', missing: 'amber', stale: 'rose', baseline: 'slate' };
const PAGE = 25;

function pct(n) { return new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 1 }).format((Number(n) || 0) / 100); }

/** Normalize a /i18n/strings or coverage row across API revisions. */
function normRow(r) {
  return {
    key: r.key,
    baseline: r.baseline ?? r.source ?? r.es ?? '',
    text: r.text ?? r.translation ?? r.staleText ?? '',
    status: r.status || (r.text ? 'curated' : 'missing'),
    override: !!(r.override || r.overridden || r.status === 'reviewed'),
    editedAt: r.editedAt || r.updatedAt || null,
  };
}

export async function renderLanguagePacks(panel) {
  mount(panel, skeleton(6));
  let packs;
  try { packs = await loadPacks(true); } catch (err) { mount(panel, errorPanel(err, () => renderLanguagePacks(panel))); return; }
  const mirrors = packs.filter((p) => p.role !== 'baseline');
  const coverage = new Map();
  await Promise.all(mirrors.map(async (p) => {
    try { coverage.set(p.locale, await api.get(`/i18n/packs/${encodeURIComponent(p.locale)}/coverage`, { limit: 0 })); } catch { coverage.set(p.locale, null); }
  }));

  const cards = el('div.lp-cards', packs.map((p) => packCard(p, coverage.get(p.locale))));
  const review = el('div.lp-review');
  mount(panel, el('div.stack.lp-page',
    el('p.muted', t('langpacks.intro')),
    cards,
    mirrors.length ? review : alertBox({ tone: 'info', children: [el('p', t('langpacks.noMirrors'))] })));
  if (mirrors.length) reviewPanel(review, mirrors, coverage);
}

function packCard(p, cov) {
  const isBase = p.role === 'baseline';
  const c = p.coverage || {};
  const fields = cov?.fields ?? c.fields ?? null;
  const by = cov?.byStatus || {};
  const percent = isBase ? 100 : (c.percent ?? (fields ? ((cov?.translated ?? 0) / fields) * 100 : 0));
  const bar = el('div.lp-bar', { role: 'img', aria: { label: t('langpacks.coverageLabel', { percent: pct(percent) }) } });
  if (!isBase && fields) {
    for (const s of STATUSES) {
      const n = by[s] ?? (s === 'missing' ? c.missing : s === 'stale' ? c.stale : 0) ?? 0;
      if (!n) continue;
      const seg = el(`span.lp-seg.is-${s}`); seg.style.width = `${(n / fields) * 100}%`; bar.append(seg);
    }
  } else { const seg = el('span.lp-seg.is-baseline'); seg.style.width = `${percent}%`; bar.append(seg); }
  return el('article.lp-card', { lang: p.locale, data: { locale: p.locale } },
    el('div.lp-card-head',
      el('div', el('h3.lp-name', p.nativeName || p.name || p.locale), el('p.muted.small', { lang: document.documentElement.lang }, `${p.name || ''} · ${p.locale}${p.dir === 'rtl' ? ' · RTL' : ''}`)),
      chip(isBase ? t('langpacks.baseline') : t('langpacks.mirror'), isBase ? 'gold' : 'slate')),
    el('p.lp-percent', { lang: document.documentElement.lang }, el('strong', pct(percent)), ' ', el('span.muted', isBase ? t('langpacks.baselineNote') : t('langpacks.translated'))),
    bar,
    !isBase ? el('ul.lp-legend', { lang: document.documentElement.lang }, STATUSES.map((s) => {
      const n = by[s] ?? (s === 'missing' ? c.missing : s === 'stale' ? c.stale : null);
      return n === null || n === undefined ? null : el('li', el(`span.lp-dot.is-${s}`, { aria: { hidden: 'true' } }), t(`langpacks.status.${s}`), ' ', el('strong', fmtNumber(n)));
    })) : null,
    !isBase ? el('a.btn.btn-ghost.btn-sm.lp-export', { href: `/api/v1/i18n/packs/${encodeURIComponent(p.locale)}/export`, download: `catalog.${p.locale}.json`, lang: document.documentElement.lang },
      icon('download', { size: 16 }), t('langpacks.export')) : null);
}

function reviewPanel(root, mirrors, coverage) {
  const locSel = select(mirrors.map((p) => ({ value: p.locale, label: p.nativeName || p.name || p.locale })), { id: 'lp-locale' });
  const firstCov = coverage.get(mirrors[0].locale);
  const startStatus = firstCov && (firstCov.byStatus?.stale || firstCov.stale?.length) ? 'stale' : 'missing';
  const statusSel = select([{ value: '', label: t('langpacks.allStatuses') }, ...STATUSES.map((s) => ({ value: s, label: t(`langpacks.status.${s}`), selected: s === startStatus }))], { id: 'lp-status' });
  const q = input({ type: 'search', id: 'lp-q', placeholder: t('langpacks.searchPlaceholder'), autocomplete: 'off' });
  const list = el('div.lp-list', { aria: { live: 'polite' } });
  const more = el('button.btn.btn-secondary', { type: 'button', hidden: true }, t('settings.loadMore'));
  const countLine = el('p.muted.small');
  let rows = []; let offset = 0; let total = 0; let seq = 0;

  mount(root, card({ title: t('langpacks.reviewTitle'), icon: 'edit', sub: t('langpacks.reviewSub'), children: [
    el('div.filters',
      el('div.filter', el('label.label', { for: 'lp-locale' }, t('langpacks.pack')), locSel),
      el('div.filter', el('label.label', { for: 'lp-status' }, t('langpacks.statusFilter')), statusSel),
      el('div.filter.filter-grow', el('label.label', { for: 'lp-q' }, t('common.search')), q)),
    countLine, list, more] }));

  async function load(reset = true) {
    const my = ++seq;
    if (reset) { rows = []; offset = 0; mount(list, skeleton(4)); }
    try {
      const r = await api.get('/i18n/strings', { locale: locSel.value, q: q.value.trim(), status: statusSel.value, limit: PAGE, offset });
      if (my !== seq) return;
      const got = items(r).map(normRow);
      rows = rows.concat(got); total = r.total ?? rows.length; offset = rows.length;
    } catch (err) { if (my === seq) mount(list, errorPanel(err, () => load(true))); return; }
    more.hidden = rows.length >= total;
    countLine.textContent = t('langpacks.showing', { shown: fmtNumber(rows.length), total: fmtNumber(total) });
    clear(list);
    if (!rows.length) { list.append(emptyState({ icon: 'check', title: t('langpacks.nothingHere'), compact: true })); return; }
    list.append(...rows.map((row) => stringRow(row, locSel.value, () => load(true))));
  }
  let tmr;
  q.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => load(true), 350); });
  locSel.addEventListener('change', () => load(true));
  statusSel.addEventListener('change', () => load(true));
  more.addEventListener('click', () => load(false));
  load(true);
}

function stringRow(row, locale, refresh) {
  const id = `lp-${row.key.replace(/[^\w-]/g, '_')}`;
  const ta = textarea({ id, rows: Math.min(6, Math.max(2, Math.ceil((row.baseline || '').length / 90))), lang: locale, value: row.text || '' });
  ta.value = row.text || '';
  const save = el('button.btn.btn-primary.btn-sm', { type: 'button' }, icon('check', { size: 16 }), t('langpacks.save'));
  const revert = row.override ? el('button.btn.btn-ghost.btn-sm', { type: 'button' }, icon('refresh', { size: 16 }), t('langpacks.revert')) : null;
  save.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); toast(t('validation.required'), { tone: 'error' }); return; }
    setLoading(save, true);
    try { await api.put('/i18n/strings', { locale, key: row.key, text }); toast(t('langpacks.saved'), { tone: 'success' }); refresh(); }
    catch (err) { toast(errorMessage(err), { tone: 'error' }); }
    finally { setLoading(save, false); }
  });
  if (revert) revert.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: t('langpacks.revertTitle'), message: t('langpacks.revertBody'), confirmLabel: t('langpacks.revert') }))) return;
    setLoading(revert, true);
    try { await api.del('/i18n/strings', { body: { locale, key: row.key } }); toast(t('langpacks.reverted'), { tone: 'success' }); refresh(); }
    catch (err) { toast(errorMessage(err), { tone: 'error' }); }
    finally { setLoading(revert, false); }
  });
  return el('article.lp-row', { data: { key: row.key } },
    el('div.lp-row-head', el('code.code-tag.lp-key', row.key), chip(t(`langpacks.status.${row.status}`) || row.status, STATUS_TONE[row.status] || 'slate', 'chip-sm'),
      row.override ? chip(t('langpacks.overridden'), 'gold', 'chip-sm') : null,
      row.editedAt ? el('span.muted.small', fmtDateTime(row.editedAt)) : null),
    el('div.lp-row-body',
      el('div.lp-src', el('span.label', t('langpacks.baselineText', { lang: localeLabel('es') })), el('p.lp-src-text', { lang: 'es' }, row.baseline || '—')),
      el('div.lp-dst', el('label.label', { for: id }, t('langpacks.translationText', { lang: localeLabel(locale) })), ta,
        row.status === 'stale' && row.text ? el('p.field-hint', t('langpacks.staleHint')) : null)),
    el('div.lp-row-actions', revert, save));
}
