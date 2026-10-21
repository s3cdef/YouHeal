// Patient chart: Overview · Intake & Consent (Hoja de Registro) · Sessions (with trend) · Reports.
import { el, mount, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, errorMessage } from '../api.js';
import { t, fmtDate, fmtDateTime, locNode, fmtRelativeDay } from '../i18n.js';
import { navigate, setLeaveGuard } from '../router.js';
import { can, loadCore, getList, normSession } from '../state.js';
import { tabs, card, emptyState, table, statusBadge, chip, field, input, textarea, alertBox, setLoading, skeleton, categoryChip } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { avatar, fullName, demographics, errorPanel, methodologyLabel } from './common.js';
import { startScan } from './start-scan.js';

const TABS = ['overview', 'intake', 'sessions', 'reports'];

export async function renderChart({ main, params }) {
  const tab = TABS.includes(params.tab) ? params.tab : 'overview';
  mount(main, el('div.page', skeleton(6)));
  let patient; let sessions; let consents;
  try {
    [patient, sessions, consents] = await Promise.all([
      api.get(`/patients/${encodeURIComponent(params.id)}`),
      api.get(`/patients/${encodeURIComponent(params.id)}/sessions`).then((r) => items(r).map(normSession)).catch(() => []),
      api.get(`/patients/${encodeURIComponent(params.id)}/consents`).then(items).catch(() => []),
    ]);
  } catch (err) { mount(main, el('div.page', errorPanel(err, () => renderChart({ main, params })))); return null; }
  const latest = consents[0] || null;
  // Full session detail (findings) is clinical data: only fetched for admin/practitioner, newest 8, once per render.
  let detailsP = null;
  const sessionDetails = () => {
    if (!detailsP) detailsP = can.clinical() ? Promise.all(sessions.slice(0, 8).map((x) => api.get(`/sessions/${encodeURIComponent(x.id)}`).then(normSession).catch(() => ({ ...x, findings: [] })))) : Promise.resolve([]);
    return detailsP;
  };
  const absolute = latest?.contraindications?.absolute || [];
  const relative = latest?.contraindications?.relative || [];
  const flags = el('div.chart-flags',
    !latest ? chip(t('chart.noIntake'), 'amber', 'chip-flag') : chip(t('chart.intakeOn', { date: fmtDate(latest.signedAt || latest.createdAt) }), 'teal', 'chip-flag'),
    absolute.length ? el('span.chip.tone-rose.chip-flag', icon('alert', { size: 14 }), t('chart.absoluteFlag', { count: absolute.length })) : null,
    relative.length ? el('span.chip.tone-amber.chip-flag', icon('info', { size: 14 }), t('chart.relativeFlag', { count: relative.length })) : null,
  );
  const startBtn = can.scan() ? el('button.btn.btn-primary.btn-lg', { type: 'button', onClick: () => startScan(patient) }, icon('magnet', { size: 20 }), t('chart.startScan')) : null;
  const header = el('header.chart-head',
    el('a.back-link', { href: '#/patients' }, icon('arrowLeft', { size: 16 }), el('span', t('patients.title'))),
    el('div.chart-id',
      avatar(patient, 'lg'),
      el('div.chart-id-text',
        el('h1.page-title', { tabindex: '-1' }, fullName(patient)),
        el('p.page-sub', demographics(patient)),
        flags)),
    el('div.page-actions',
      can.patients() ? el('a.btn.btn-secondary', { href: `#/patients/${patient.id}/edit` }, icon('edit', { size: 18 }), t('common.edit')) : null,
      startBtn));

  const tb = tabs({
    label: t('chart.sections'), active: tab, variant: 'line',
    tabs: [
      { id: 'overview', label: t('chart.tabOverview'), icon: 'user' },
      { id: 'intake', label: t('chart.tabIntake'), icon: 'clipboard' },
      { id: 'sessions', label: t('chart.tabSessions'), icon: 'activity', count: sessions.length },
      can.reports() ? { id: 'reports', label: t('chart.tabReports'), icon: 'file', count: sessions.filter((s) => s.status !== 'draft').length } : null,
    ].filter(Boolean),
    onChange: (id, panel, user) => {
      if (user) history.replaceState(null, '', `#/patients/${patient.id}/${id}`);
      clear(panel);
      const ctx = { patient, sessions, consents, panel, sessionDetails, refresh: () => renderChart({ main, params: { ...params, tab: id } }) };
      if (id === 'overview') overview(ctx);
      else if (id === 'intake') intake(ctx);
      else if (id === 'sessions') sessionsTab(ctx);
      else reportsTab(ctx);
    },
  });
  mount(main, el('div.page.page-chart', header, tb.root, tb.panel));
  return () => setLeaveGuard(null);
}

// ---------------- Overview ----------------
function overview({ patient, sessions, consents, panel, sessionDetails }) {
  const latestS = sessions.find((x) => !x.supersededBy) || sessions[0];
  const finals = sessions.filter((s) => s.status !== 'draft');
  const followDue = latestS && latestS.followUpDate;
  const dl = (rows) => el('dl.dl', rows.filter(([, v]) => v).map(([k, v]) => [el('dt', k), el('dd', v)]));
  mount(panel, el('div.overview-grid',
    card({ title: t('chart.details'), icon: 'user', actions: can.patients() ? el('a.btn.btn-sm.btn-ghost', { href: `#/patients/${patient.id}/edit` }, icon('edit', { size: 16 }), t('common.edit')) : null,
      children: [dl([
        [t('patient.phone'), patient.phone], [t('patient.email'), patient.email], [t('patient.address'), patient.address],
        [t('patient.emergencyContact'), patient.emergencyContact], [t('patient.referredBy'), patient.referredBy], [t('patient.occupation'), patient.occupation],
        [t('patient.mrn'), patient.mrn], [t('patient.notes'), patient.notes],
      ])] }),
    card({ title: t('chart.latestSession'), icon: 'activity',
      children: latestS ? [
        el('div.latest',
          el('p.latest-date', fmtDateTime(latestS.startedAt), ' ', statusBadge(latestS.status)),
          el('p', methodologyLabel(latestS.methodology), latestS.practitioner ? ` · ${latestS.practitioner.name}` : ''),
          el('p.muted', t('dashboard.findingsCount', { count: latestS.findingsCount || 0 })),
          followDue ? el('p.follow', icon('clock', { size: 16 }), t('chart.followUpDue', { when: fmtRelativeDay(followDue), date: fmtDate(followDue) })) : null,
          can.clinical() ? el('div.btn-row',
            latestS.status === 'draft' ? el('a.btn.btn-primary', { href: `#/sessions/${latestS.id}` }, t('dashboard.resume')) : el('a.btn.btn-secondary', { href: `#/sessions/${latestS.id}/report` }, icon('file', { size: 18 }), t('chart.viewReport'))) : null),
      ] : [emptyState({ icon: 'activity', title: t('chart.noSessions'), compact: true })] }),
    can.clinical() ? card({ title: t('chart.recurring'), icon: 'layers', sub: t('chart.recurringSub'),
      children: [finals.length ? recurringList(sessionDetails) : emptyState({ icon: 'layers', title: t('chart.noTrend'), compact: true })] }) : null,
    card({ title: t('chart.intakeStatus'), icon: 'clipboard', actions: el('a.btn.btn-sm.btn-ghost', { href: `#/patients/${patient.id}/intake` }, t('chart.openIntake')),
      children: [consents[0] ? el('div',
        el('p', t('chart.signedBy', { name: consents[0].signatureName, date: fmtDate(consents[0].signedAt || consents[0].createdAt) })),
        contraSummary(consents[0])) : emptyState({ icon: 'clipboard', title: t('chart.noIntake'), body: t('chart.noIntakeBody'), compact: true })] }),
  ));
}

function contraSummary(consent) {
  const box = el('div.contra-summary', skeleton(1));
  getList('/catalog/contraindications').then((all) => {
    const by = new Map(all.map((c) => [c.id, c]));
    const abs = consent.contraindications?.absolute || []; const rel = consent.contraindications?.relative || [];
    if (!abs.length && !rel.length) { mount(box, el('p.ok-line', icon('check', { size: 16 }), t('chart.noContra'))); return; }
    mount(box,
      abs.length ? el('div', el('p.contra-head.is-absolute', icon('alert', { size: 16 }), t('intake.absolute')), el('ul.contra-list.is-absolute', abs.map((id) => el('li', by.has(id) ? locNode(by.get(id).text) : id)))) : null,
      rel.length ? el('div', el('p.contra-head.is-relative', icon('info', { size: 16 }), t('intake.relative')), el('ul.contra-list', rel.map((id) => el('li', by.has(id) ? locNode(by.get(id).text) : id)))) : null);
  }).catch(() => mount(box, el('p.muted', t('errors.loadFailed'))));
  return box;
}

function recurringList(sessionDetails) {
  const box = el('div', skeleton(3));
  Promise.all([loadCore(), sessionDetails()]).then(([core, sessions]) => {
    const counts = new Map();
    for (const s of sessions) for (const f of s.findings || []) if (f.pairId) counts.set(f.pairId, (counts.get(f.pairId) || 0) + 1);
    const top = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!top.length) { mount(box, el('p.muted', t('chart.noRecurring'))); return; }
    mount(box, el('ul.recurring', top.map(([pid, n]) => {
      const p = core.pairs.get(pid);
      return el('li', el('span.recurring-name', p ? locNode(p.name) : pid), p ? categoryChip(p.category) : null, el('span.recurring-n', t('chart.timesSeen', { count: n })));
    })));
  });
  return box;
}

// ---------------- Intake & consent ----------------
const SCOPE_QUESTIONS = ['understandsScope', 'continuesMedical', 'authorizesPlacement', 'followUpInformed'];

function intake({ patient, consents, panel, refresh }) {
  if (!can.intake()) { mount(panel, emptyState({ icon: 'lock', title: t('errors.forbidden') })); return; }
  const latest = consents[0];
  const answers = { ...(latest?.answers || {}) };
  const absSel = new Set(latest?.contraindications?.absolute || []);
  const relSel = new Set(latest?.contraindications?.relative || []);
  let dirty = false;
  const markDirty = () => { dirty = true; };
  setLeaveGuard(async () => (dirty ? confirmDialog({ title: t('common.unsavedTitle'), message: t('common.unsavedBody'), confirmLabel: t('common.discard'), danger: true }) : true));

  const reason = textarea({ rows: 2, value: answers.reason || '' });
  const meds = textarea({ rows: 2, value: answers.medications || '' });
  const physician = input({ value: answers.physician || '' });
  const yn = (key) => {
    const name = `q-${key}`;
    const mk = (val, label) => {
      const r = el('input', { type: 'radio', name, value: val, checked: answers[key] === (val === 'yes') && answers[key] !== undefined });
      r.addEventListener('change', () => { answers[key] = val === 'yes'; markDirty(); });
      return el('label.radio-pill', r, el('span', label));
    };
    return el('fieldset.yn', el('legend', t(`intake.q.${key}`)), el('div.yn-opts', mk('yes', t('common.yes')), mk('no', t('common.no'))));
  };
  const explained = el('input', { type: 'checkbox', checked: !!answers.techniqueExplained });
  const questions = el('input', { type: 'checkbox', checked: !!answers.questionsAnswered });
  explained.addEventListener('change', () => { answers.techniqueExplained = explained.checked; markDirty(); });
  questions.addEventListener('change', () => { answers.questionsAnswered = questions.checked; markDirty(); });

  const absAlert = el('div.abs-alert', { aria: { live: 'polite' } });
  const updateAbsAlert = () => {
    mount(absAlert, absSel.size ? alertBox({ tone: 'danger', title: t('intake.absBlockTitle'), children: [el('p', t('intake.absBlockBody'))] }) : null);
  };
  const contraBox = el('div.contra-grid', skeleton(4));
  getList('/catalog/contraindications').then((all) => {
    const group = (kind, sel, title, tone) => el(`fieldset.contra-group.is-${kind}`,
      el('legend', icon(kind === 'absolute' ? 'alert' : 'info', { size: 18 }), title),
      el('p.field-hint', t(`intake.${kind}Hint`)),
      all.filter((c) => c.kind === kind).map((c) => {
        const cb = el('input', { type: 'checkbox', value: c.id, checked: sel.has(c.id) });
        cb.addEventListener('change', () => { if (cb.checked) sel.add(c.id); else sel.delete(c.id); markDirty(); if (kind === 'absolute') updateAbsAlert(); });
        return el(`label.check.check-card${tone ? '.' + tone : ''}`, cb, el('span.check-text', locNode(c.text), c.source ? el('span.cite', `${c.source.doc} p.${c.source.page}`) : null));
      }));
    mount(contraBox, group('absolute', absSel, t('intake.absolute'), 'is-danger'), group('relative', relSel, t('intake.relative'), null));
    updateAbsAlert();
  }).catch((err) => mount(contraBox, errorPanel(err)));

  const sigName = input({ autocomplete: 'off', value: '' });
  const sigAck = el('input', { type: 'checkbox' });
  const fSig = field({ label: t('intake.signatureName'), input: sigName, hint: t('intake.signatureHint'), required: true });
  const errBox = el('div.form-error-slot', { aria: { live: 'assertive' } });
  const submit = el('button.btn.btn-primary.btn-lg', { type: 'submit' }, icon('check', { size: 18 }), t('intake.save'));
  const form = el('form.form.form-sections.intake-form', { novalidate: true },
    latest ? alertBox({ tone: 'info', children: [el('p', t('intake.previous', { date: fmtDateTime(latest.signedAt || latest.createdAt), name: latest.signatureName }))] }) : null,
    card({ title: t('intake.secData'), icon: 'user', sub: t('intake.secDataSub'), children: [
      el('dl.dl.dl-inline', [[t('patient.name'), fullName(patient)], [t('patient.dob'), fmtDate(patient.dob)], [t('patient.sex'), patient.sex ? t(`sex.${patient.sex}`) : '—'], [t('patient.phone'), patient.phone || '—']].map(([k, v]) => [el('dt', k), el('dd', v)])),
      el('div.grid-2',
        field({ label: t('intake.reason'), input: reason, cls: 'span-2' }),
        field({ label: t('intake.medications'), input: meds, optional: true }),
        field({ label: t('intake.physician'), input: physician, optional: true })),
    ] }),
    card({ title: t('intake.secTechnique'), icon: 'magnet', children: [
      el('div.prose', el('p', t('intake.techniqueP1')), el('p', t('intake.techniqueP2'))),
      el('label.check', explained, el('span', t('intake.explained'))),
      el('label.check', questions, el('span', t('intake.questions'))),
    ] }),
    card({ title: t('intake.secScope'), icon: 'shield', children: [el('div.yn-list', SCOPE_QUESTIONS.map(yn))] }),
    card({ title: t('intake.secContra'), icon: 'alert', sub: t('intake.secContraSub'), children: [contraBox, absAlert] }),
    card({ title: t('intake.secSign'), icon: 'edit', children: [
      el('div.grid-2', fSig, el('div.field', el('span.label', t('intake.signedAt')), el('p.static', fmtDateTime(new Date().toISOString())))),
      el('label.check', sigAck, el('span', t('intake.signAck'))),
    ] }),
    errBox,
    el('div.form-actions.sticky-actions', submit));
  for (const n of [reason, meds, physician, sigName]) n.addEventListener('input', markDirty);

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); errBox.textContent = ''; fSig.setError(null);
    const problems = [];
    if (!explained.checked) problems.push(t('intake.errExplained'));
    if (SCOPE_QUESTIONS.some((k) => answers[k] === undefined)) problems.push(t('intake.errScope'));
    if (!sigName.value.trim()) { fSig.setError(t('validation.required')); problems.push(t('intake.errSignature')); }
    if (!sigAck.checked) problems.push(t('intake.errSignAck'));
    if (problems.length) { errBox.replaceChildren(alertBox({ tone: 'danger', title: t('validation.fixErrors'), children: [el('ul', problems.map((p) => el('li', p)))] })); errBox.scrollIntoView({ block: 'center' }); return; }
    setLoading(submit, true);
    try {
      const res = await api.post(`/patients/${encodeURIComponent(patient.id)}/consents`, {
        type: 'intake',
        answers: { ...answers, reason: reason.value.trim(), medications: meds.value.trim(), physician: physician.value.trim() },
        contraindications: { absolute: [...absSel], relative: [...relSel] },
        signatureName: sigName.value.trim(), signedAt: new Date().toISOString(),
      });
      dirty = false;
      toast(t('intake.saved'), { tone: 'success' });
      const warns = (res && res.warnings) || [];
      if (warns.some((w) => w.code === 'ABSOLUTE_CONTRAINDICATION') || absSel.size) toast(t('intake.savedBlocked'), { tone: 'warn', timeout: 10000 });
      else if (warns.some((w) => w.code === 'RELATIVE_CONTRAINDICATION')) toast(t('intake.savedRelative'), { tone: 'warn' });
      refresh();
    } catch (err) { errBox.replaceChildren(alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })); }
    finally { setLoading(submit, false); }
  });
  mount(panel, form);
}

// ---------------- Sessions + trend ----------------
function sessionsTab({ patient, sessions, panel, sessionDetails }) {
  if (!sessions.length) {
    mount(panel, emptyState({ icon: 'activity', title: t('chart.noSessions'), body: t('chart.noSessionsBody'), action: can.scan() ? el('button.btn.btn-primary', { type: 'button', onClick: () => startScan(patient) }, icon('magnet', { size: 18 }), t('chart.startScan')) : null }));
    return;
  }
  const trendBox = el('div', skeleton(4));
  mount(panel,
    can.clinical() ? card({ title: t('chart.trendTitle'), icon: 'layers', sub: t('chart.trendSub'), children: [trendBox] }) : null,
    card({ title: t('chart.history'), icon: 'activity', sub: can.clinical() ? null : t('chart.summaryOnly'), children: [table({
      caption: t('chart.history'), rows: sessions,
      onRowClick: can.clinical() ? (s) => navigate(s.status === 'draft' ? `/sessions/${s.id}` : `/sessions/${s.id}/report`) : null,
      rowLabel: (s) => fmtDateTime(s.startedAt),
      columns: [
        { key: 'date', label: t('session.date'), render: (s) => fmtDateTime(s.startedAt) },
        { key: 'methodology', label: t('session.methodology'), render: (s) => methodologyLabel(s.methodology) },
        { key: 'by', label: t('report.practitioner'), render: (s) => s.practitioner?.name || '—' },
        { key: 'findings', label: t('session.findings'), align: 'right', render: (s) => String(s.findingsCount || 0) },
        { key: 'status', label: t('session.status'), render: (s) => el('span.cell-stack', statusBadge(s.status), s.revision > 1 ? el('span.muted.small', t('report.revision', { n: s.revision })) : null, s.supersededBy ? el('span.muted.small', t('chart.superseded')) : null) },
        { key: 'act', label: el('span.sr-only', t('common.actions')), align: 'right', render: (s) => (!can.clinical() ? null : s.status === 'draft'
          ? el('a.btn.btn-sm.btn-primary', { href: `#/sessions/${s.id}` }, t('dashboard.resume'))
          : el('a.btn.btn-sm.btn-secondary', { href: `#/sessions/${s.id}/report` }, icon('file', { size: 16 }), t('chart.report'))) },
      ],
    })] }));
  if (!can.clinical()) return;
  Promise.all([loadCore(), sessionDetails()]).then(([core, details]) => {
    const chrono = details.filter((s) => !s.supersededBy).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const rows = new Map();
    chrono.forEach((s, col) => { for (const f of s.findings || []) { const key = f.pairId || `${f.trackingPoint}--${f.impactPoint}`; if (!rows.has(key)) rows.set(key, { key, pairId: f.pairId, cells: new Map(), n: 0 }); const r = rows.get(key); r.cells.set(col, f.status); r.n++; } });
    const ordered = [...rows.values()].sort((a, b) => b.n - a.n);
    if (!ordered.length) { mount(trendBox, el('p.muted', t('chart.noTrend'))); return; }
    const thead = el('thead', el('tr', el('th', { scope: 'col' }, t('catalog.pair')), chrono.map((s) => el('th.trend-col', { scope: 'col' }, el('span', fmtDate(s.startedAt, { month: 'short', day: 'numeric' })))), el('th.ta-right', { scope: 'col' }, t('chart.seen'))));
    const tbody = el('tbody', ordered.map((r) => {
      const p = r.pairId ? core.pairs.get(r.pairId) : null;
      return el(`tr${r.n > 1 ? '.is-recurring' : ''}`,
        el('th', { scope: 'row' }, el('span.trend-pair', p ? el('span.pair-num', `#${p.number}`) : null, p ? locNode(p.name) : r.key)),
        chrono.map((s, col) => el('td.trend-cell', r.cells.has(col) ? el(`span.trend-mark.state-${r.cells.get(col)}`, { title: t(`state.${r.cells.get(col)}`), role: 'img', aria: { label: t(`state.${r.cells.get(col)}`) } }) : el('span.trend-empty', { aria: { label: t('chart.notFound') }, role: 'img' }))),
        el('td.ta-right', el(`span.count-pill${r.n > 1 ? '.is-hot' : ''}`, `${r.n}×`)));
    }));
    mount(trendBox, el('div.table-wrap', el('table.table.trend-table', el('caption.sr-only', t('chart.trendTitle')), thead, tbody)),
      el('div.legend', ['found', 'impacted', 'cleared'].map((s) => el('span.legend-item', el(`span.trend-mark.state-${s}`), t(`state.${s}`)))));
  });
}

// ---------------- Reports ----------------
function reportsTab({ sessions, panel }) {
  const finals = sessions.filter((s) => s.status !== 'draft');
  if (!can.reports()) { mount(panel, emptyState({ icon: 'lock', title: t('errors.forbidden') })); return; }
  mount(panel, card({ title: t('chart.tabReports'), icon: 'file', children: [table({
    caption: t('chart.tabReports'), rows: finals,
    empty: emptyState({ icon: 'file', title: t('chart.noReports'), body: t('chart.noReportsBody'), compact: true }),
    onRowClick: (s) => navigate(`/sessions/${s.id}/report`), rowLabel: (s) => fmtDateTime(s.startedAt),
    columns: [
      { key: 'date', label: t('session.date'), render: (s) => fmtDate(s.startedAt) },
      { key: 'signed', label: t('report.signedOn'), render: (s) => fmtDateTime(s.finalizedAt) },
      { key: 'by', label: t('report.practitioner'), render: (s) => s.practitioner?.name || '—' },
      { key: 'status', label: t('session.status'), render: (s) => statusBadge(s.status) },
      { key: 'rev', label: t('report.revisionShort'), render: (s) => el('span.cell-stack', `R${s.revision || 1}`, s.supersededBy ? el('span.muted.small', t('chart.superseded')) : null) },
      { key: 'hash', label: t('report.hash'), cls: 'mono', render: (s) => (s.reportHash ? s.reportHash.slice(0, 16) : '—') },
      { key: 'act', label: el('span.sr-only', t('common.actions')), align: 'right', render: (s) => el('a.btn.btn-sm.btn-secondary', { href: `#/sessions/${s.id}/report` }, icon('file', { size: 16 }), t('common.open')) },
    ],
  })] }));
}

