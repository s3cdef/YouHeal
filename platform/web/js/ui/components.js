// Small presentational components: tabs, table, empty state, chips, meters, polarity glyphs, fields.
import { el, nextId, clear } from './dom.js';
import { icon } from './icons.js';
import { t, locText, vocab } from '../i18n.js';

// ---------- Tabs (roving tabindex, arrow keys) ----------
/** tabs({ tabs:[{id,label,icon,count}], active, onChange(id), label, variant }) → { root, panel, select(id) } */
export function tabs({ tabs: list, active, onChange, label, variant = '' }) {
  const panelId = nextId('tabpanel');
  const tablist = el(`div.tabs${variant ? '.tabs-' + variant : ''}`, { role: 'tablist', aria: { label } });
  const panel = el('div.tabpanel', { id: panelId, role: 'tabpanel', tabindex: '-1' });
  const buttons = list.map((tb) => {
    const b = el('button.tab', { type: 'button', role: 'tab', id: `${panelId}-${tb.id}`, aria: { controls: panelId, selected: 'false' }, tabindex: '-1', data: { tab: tb.id } },
      tb.icon ? icon(tb.icon, { size: 18 }) : null, el('span', tb.label), tb.count !== undefined && tb.count !== null ? el('span.tab-count', String(tb.count)) : null);
    b.addEventListener('click', () => select(tb.id, true));
    return b;
  });
  tablist.append(...buttons);
  tablist.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement); if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = buttons.length - 1;
    if (j !== null) { e.preventDefault(); buttons[j].focus(); select(list[j].id, true); }
  });
  function select(id, user = false) {
    buttons.forEach((b) => {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; b.classList.toggle('is-active', on);
      if (on) panel.setAttribute('aria-labelledby', b.id);
    });
    if (onChange) onChange(id, panel, user);
  }
  queueMicrotask(() => select(active || list[0].id));
  return { root: tablist, panel, select };
}

// ---------- Data table ----------
/** table({ columns:[{key,label,render,cls,align}], rows, onRowClick, caption, empty, rowLabel, dense }) */
export function table({ columns, rows, onRowClick, caption, empty, rowLabel, dense = false, cls = '' }) {
  if (!rows.length && empty) return empty;
  const thead = el('thead', el('tr', columns.map((c) => el('th', { scope: 'col', class: [c.cls, c.align ? 'ta-' + c.align : ''].filter(Boolean).join(' ') || null }, c.label))));
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr', columns.map((c) => el('td', { class: [c.cls, c.align ? 'ta-' + c.align : ''].filter(Boolean).join(' ') || null, data: { label: typeof c.label === 'string' ? c.label : null } }, c.render ? c.render(r) : (r[c.key] ?? '—'))));
    if (onRowClick) {
      tr.classList.add('is-clickable'); tr.tabIndex = 0;
      if (rowLabel) tr.setAttribute('aria-label', rowLabel(r));
      tr.addEventListener('click', (e) => { if (e.target.closest('button,a,input,select')) return; onRowClick(r, e); });
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) onRowClick(r, e); });
    }
    tbody.append(tr);
  }
  return el('div.table-wrap', el(`table.table${dense ? '.table-dense' : ''}${cls ? '.' + cls : ''}`, caption ? el('caption.sr-only', caption) : null, thead, tbody));
}

// ---------- Empty state ----------
export function emptyState({ icon: ic = 'info', title, body = null, action = null, compact = false }) {
  return el(`div.empty${compact ? '.empty-compact' : ''}`,
    el('div.empty-icon', icon(ic, { size: compact ? 22 : 28 })),
    el('p.empty-title', title),
    body ? el('p.empty-body', body) : null,
    action,
  );
}

export function spinner(label) {
  return el('div.loading', { role: 'status' }, el('span.spinner', { aria: { hidden: 'true' } }), el('span.loading-label', label || t('common.loading')));
}

export function skeleton(lines = 3) {
  return el('div.skeleton', { aria: { hidden: 'true' } }, Array.from({ length: lines }, (_, i) => el('div.skeleton-line', { style: { width: `${90 - i * 12}%` } })));
}

// ---------- Chips / badges ----------
export const CATEGORY_TONES = {
  virus: 'rose', bacteria: 'amber', fungus: 'olive', parasite: 'violet', dysfunctional: 'slate', psychoemotional: 'sky',
  reservoir: 'teal', complex: 'indigo', prion: 'rose', special: 'gold', temporary: 'slate', 'glandular-dysfunction': 'sky',
};
export function categoryChip(cat) {
  if (!cat) return null;
  return el(`span.chip.chip-cat.tone-${CATEGORY_TONES[cat] || 'slate'}`, vocab('categories', cat));
}
export function chip(text, tone = 'slate', extra = '') { return el(`span.chip.tone-${tone}${extra ? '.' + extra : ''}`, text); }

export const STATE_ICON = { candidate: null, found: 'target', impacted: 'magnet', cleared: 'check', 'not-present': 'minus' };
export function stateBadge(state) {
  const s = state || 'candidate';
  return el(`span.state-badge.state-${s}`, STATE_ICON[s] ? icon(STATE_ICON[s], { size: 14 }) : el('span.state-dot'), el('span', t(`state.${s}`)));
}

export function statusBadge(status) {
  return el(`span.status-badge.status-${status}`, t(`sessionStatus.${status}`));
}

/** F/P/R ratings as 1–3 dot meters. */
export function ratingMeter(letter, value) {
  if (value === null || value === undefined || value === '') {
    return el('span.meter.is-na', { role: 'img', aria: { label: `${t(`ratings.${letter}`)}: ${t('ratings.na')}` }, title: `${t(`ratings.${letter}`)} — ${t('ratings.na')}` },
      el('span.meter-letter', { aria: { hidden: 'true' } }, letter), el('span.meter-na', { aria: { hidden: 'true' } }, '—'));
  }
  const v = Math.max(0, Math.min(3, Number(value) || 0));
  return el('span.meter', { role: 'img', aria: { label: `${t(`ratings.${letter}`)}: ${v} / 3` }, title: `${t(`ratings.${letter}`)} ${v}/3` },
    el('span.meter-letter', { aria: { hidden: 'true' } }, letter),
    el('span.meter-dots', { aria: { hidden: 'true' } }, [1, 2, 3].map((i) => el(`span.meter-dot${i <= v ? '.on' : ''}`))));
}
export function ratingsRow(r) {
  if (!r || (r.F == null && r.P == null && r.R == null)) return el('span.muted.small', { title: t('ratings.none') }, '—');
  return el('span.meters', ['F', 'P', 'R'].map((k) => ratingMeter(k, r[k])));
}

/** Polarity glyph: never color alone — always "−" / "+". */
export function pole(polarity, { small = false } = {}) {
  const neg = polarity === 'negative';
  return el(`span.pole.${neg ? 'pole-neg' : 'pole-pos'}${small ? '.pole-sm' : ''}`, { role: 'img', aria: { label: neg ? t('polarity.negative') : t('polarity.positive') } }, neg ? '−' : '+');
}

export function sideLabel(side) { return side ? vocab('sides', side) : ''; }

/** "Timo (−)  →  Recto (+)" pair line */
export function pairPoles(pair, points, { sides = null, compact = false } = {}) {
  const tp = points.get(pair.tracking?.point || pair.trackingPoint);
  const ip = points.get(pair.impact?.point || pair.impactPoint);
  const ts = sides ? sides.tracking : pair.tracking?.side;
  const is = sides ? sides.impact : pair.impact?.side;
  const side = (s) => (s && s !== 'C' ? el('span.side-tag', s === 'RL' ? t('side.RLshort') : t(`side.${s}short`)) : null);
  return el(`span.pair-poles${compact ? '.compact' : ''}`,
    el('span.pp', pole('negative', { small: true }), el('span.pp-name', tp ? locText(tp.name) : (pair.tracking?.point || '?')), side(ts)),
    el('span.pp-sep', { aria: { hidden: 'true' } }, '—'),
    el('span.pp', pole('positive', { small: true }), el('span.pp-name', ip ? locText(ip.name) : (pair.impact?.point || '?')), side(is)),
  );
}

// ---------- Form fields ----------
/** field({ label, input, hint, error, required }) → wrapper; links label/hint/error ids. */
export function field({ label, input, control = null, hint = null, required = false, cls = '', optional = false }) {
  const id = input.id || nextId('f');
  input.id = id;
  const hintId = hint ? `${id}-hint` : null;
  const errId = `${id}-err`;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  const err = el('p.field-error', { id: errId, hidden: true });
  const wrap = el(`div.field${cls ? '.' + cls : ''}`,
    el('label.label', { for: id }, label, required ? el('span.req', { aria: { hidden: 'true' } }, ' *') : null, optional ? el('span.opt', ` ${t('common.optional')}`) : null),
    control || input,
    hint ? el('p.field-hint', { id: hintId }, hint) : null,
    err,
  );
  if (required) input.required = true;
  wrap.setError = (msg) => {
    err.hidden = !msg; err.textContent = msg || '';
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    const ids = [hintId, msg ? errId : null].filter(Boolean).join(' ');
    if (ids) input.setAttribute('aria-describedby', ids); else input.removeAttribute('aria-describedby');
  };
  return wrap;
}

export function input(props = {}) { return el('input.input', { type: 'text', ...props }); }
export function textarea(props = {}) { return el('textarea.input.textarea', { rows: 3, ...props }); }
export function select(options, props = {}) {
  return el('select.input.select', props, options.map((o) => (o.group
    ? el('optgroup', { label: o.group }, o.options.map((x) => el('option', { value: x.value, selected: x.selected || null }, x.label)))
    : el('option', { value: o.value, selected: o.selected || null, disabled: o.disabled || null }, o.label))));
}

/** Segmented control (radio group semantics). */
export function segmented({ name, options, value, onChange, label, size = '' }) {
  const group = el(`div.segmented${size ? '.segmented-' + size : ''}`, { role: 'radiogroup', aria: { label } });
  const btns = options.map((o) => {
    const b = el('button.seg', { type: 'button', role: 'radio', aria: { checked: o.value === value ? 'true' : 'false' }, tabindex: o.value === value ? '0' : '-1', data: { value: o.value }, title: o.title || null },
      o.icon ? icon(o.icon, { size: 16 }) : null, el('span', o.label));
    b.addEventListener('click', () => set(o.value, true));
    return b;
  });
  group.append(...btns);
  group.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement); if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % btns.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + btns.length) % btns.length;
    if (j !== null) { e.preventDefault(); btns[j].focus(); set(options[j].value, true); }
  });
  function set(v, user) {
    btns.forEach((b) => { const on = b.dataset.value === v; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    if (user && onChange) onChange(v);
  }
  group.setValue = (v) => set(v, false);
  return group;
}

/** Toggle switch (button role=switch). */
export function toggleSwitch({ label, checked = false, onChange }) {
  const b = el('button.switch', { type: 'button', role: 'switch', aria: { checked: checked ? 'true' : 'false' } }, el('span.switch-track', el('span.switch-thumb')), el('span.switch-label', label));
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', v ? 'true' : 'false');
    onChange && onChange(v);
  });
  b.setChecked = (v) => b.setAttribute('aria-checked', v ? 'true' : 'false');
  return b;
}

export function card({ title, actions = null, children = [], cls = '', icon: ic = null, headingLevel = 'h2', sub = null }) {
  return el(`section.card${cls ? '.' + cls : ''}`,
    title ? el('header.card-head', el('div.card-title-wrap', ic ? el('span.card-icon', icon(ic, { size: 18 })) : null, el(`${headingLevel}.card-title`, title), sub ? el('span.card-sub', sub) : null), actions ? el('div.card-actions', actions) : null) : null,
    el('div.card-body', children),
  );
}

export function alertBox({ tone = 'info', title = null, children = [], ic = null }) {
  return el(`div.alert.alert-${tone}`, { role: tone === 'danger' ? 'alert' : null },
    el('span.alert-icon', icon(ic || (tone === 'info' ? 'info' : 'alert'), { size: 20 })),
    el('div.alert-content', title ? el('p.alert-title', title) : null, children));
}

export function kbd(k) { return el('kbd', k); }

export function setLoading(btn, on) {
  btn.disabled = !!on;
  btn.classList.toggle('is-loading', !!on);
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

export { clear };
