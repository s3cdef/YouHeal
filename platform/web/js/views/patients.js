// Patients: list/search and create/edit demographics.
import { el, mount, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, errorMessage, ValidationError } from '../api.js';
import { t, fmtDate, ageFrom } from '../i18n.js';
import { navigate, setLeaveGuard } from '../router.js';
import { can } from '../state.js';
import { table, emptyState, field, input, textarea, select, alertBox, setLoading, skeleton, card } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { pageHeader, fullName, avatar, errorPanel, todayISO } from './common.js';

export async function renderPatientList({ main, query }) {
  let q = query.q || '';
  const search = el('input.input.input-lg', { type: 'search', id: 'patient-search', placeholder: t('patients.searchPlaceholder'), value: q, autocomplete: 'off', spellcheck: 'false', aria: { describedby: 'patient-search-hint' } });
  const letters = el('div.alpha', { role: 'group', aria: { label: t('patients.byLetter') } },
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((L) => el('button.alpha-btn', { type: 'button', aria: { pressed: q.toUpperCase() === L ? 'true' : 'false' }, onClick: () => { q = q.toUpperCase() === L ? '' : L; search.value = q; load(); } }, L)));
  const results = el('div.results', skeleton(5));
  const count = el('p.results-count', { aria: { live: 'polite' } });
  mount(main, el('div.page',
    pageHeader({ title: t('patients.title'), subtitle: t('patients.subtitle'), actions: can.patients() ? [el('a.btn.btn-primary', { href: '#/patients/new' }, icon('plus', { size: 18 }), t('patients.new'))] : [] }),
    el('div.toolbar',
      el('div.search-field', el('label.sr-only', { for: 'patient-search' }, t('patients.searchLabel')), el('span.search-icon', icon('search', { size: 20 })), search),
      el('p.field-hint', { id: 'patient-search-hint' }, t('patients.searchHint'))),
    letters, count, results));

  async function load() {
    letters.querySelectorAll('.alpha-btn').forEach((b) => b.setAttribute('aria-pressed', b.textContent === q.toUpperCase() ? 'true' : 'false'));
    const url = new URLSearchParams(); if (q) url.set('q', q);
    history.replaceState(null, '', `#/patients${q ? '?' + url.toString() : ''}`);
    let list;
    try { list = items(await api.get('/patients', { q, limit: 200 })); } catch (err) { mount(results, errorPanel(err, load)); return; }
    count.textContent = t('patients.count', { count: list.length });
    mount(results, table({
      caption: t('patients.title'),
      rows: list,
      onRowClick: (p) => navigate(`/patients/${p.id}`),
      rowLabel: (p) => fullName(p),
      empty: emptyState({ icon: 'users', title: q ? t('patients.noMatch', { q }) : t('patients.empty'), body: q ? t('patients.noMatchBody') : t('patients.emptyBody'),
        action: can.patients() ? el('a.btn.btn-primary', { href: '#/patients/new' }, icon('plus', { size: 18 }), t('patients.new')) : null }),
      columns: [
        { key: 'name', label: t('patients.colName'), render: (p) => el('span.cell-person', avatar(p, 'sm'), el('a.cell-link', { href: `#/patients/${p.id}` }, fullName(p))) },
        { key: 'dob', label: t('patients.colDob'), render: (p) => el('span', fmtDate(p.dob), el('span.muted', ` · ${t('patient.ageYears', { age: ageFrom(p.dob) ?? '—' })}`)) },
        { key: 'sex', label: t('patients.colSex'), render: (p) => (p.sex ? t(`sex.${p.sex}`) : '—') },
        { key: 'mrn', label: t('patients.colMrn'), cls: 'mono' },
        { key: 'last', label: t('patients.colLastScan'), render: (p) => (p.lastSessionAt ? fmtDate(p.lastSessionAt) : el('span.muted', t('dashboard.noScans'))) },
        { key: 'sessions', label: t('patients.colSessions'), align: 'right', render: (p) => String(p.sessionCount ?? '—') },
      ],
    }));
  }
  search.addEventListener('input', debounce(() => { q = search.value.trim(); load(); }, 250));
  await load();
  return null;
}

const SEXES = ['female', 'male', 'intersex', 'unknown'];

export async function renderPatientForm({ main, params }) {
  const editing = !!params.id;
  let patient = {};
  if (editing) {
    mount(main, skeleton(8));
    try { patient = await api.get(`/patients/${encodeURIComponent(params.id)}`); } catch (err) { mount(main, errorPanel(err, () => renderPatientForm({ main, params }))); return null; }
  }
  const f = {};
  const mk = (name, label, inp, opts = {}) => { inp.name = name; if (patient[name] !== undefined && patient[name] !== null) inp.value = patient[name]; f[name] = field({ label, input: inp, ...opts }); return f[name]; };
  const dobInput = input({ type: 'date', max: todayISO(), autocomplete: 'off' });
  const sexSel = select([{ value: '', label: t('common.select') }, ...SEXES.map((s) => ({ value: s, label: t(`sex.${s}`) }))]);

  const errBox = el('div.form-error-slot', { aria: { live: 'assertive' } });
  const submit = el('button.btn.btn-primary.btn-lg', { type: 'submit' }, icon('check', { size: 18 }), editing ? t('common.saveChanges') : t('patients.create'));
  const form = el('form.form.form-sections', { novalidate: true },
    card({ title: t('patients.secIdentity'), icon: 'user', children: [el('div.grid-2',
      mk('firstName', t('patient.firstName'), input({ autocomplete: 'off' }), { required: true }),
      mk('lastName', t('patient.lastName'), input({ autocomplete: 'off' }), { required: true }),
      mk('dob', t('patient.dob'), dobInput, { required: true }),
      mk('sex', t('patient.sex'), sexSel, { required: true }))] }),
    card({ title: t('patients.secContact'), icon: 'globe', children: [el('div.grid-2',
      mk('phone', t('patient.phone'), input({ type: 'tel', autocomplete: 'off', inputmode: 'tel' }), { optional: true }),
      mk('email', t('patient.email'), input({ type: 'email', autocomplete: 'off', inputmode: 'email' }), { optional: true }),
      mk('address', t('patient.address'), input({ autocomplete: 'off' }), { optional: true, cls: 'span-2' }),
      mk('emergencyContact', t('patient.emergencyContact'), input({ autocomplete: 'off' }), { optional: true, cls: 'span-2' }))] }),
    card({ title: t('patients.secClinical'), icon: 'clipboard', children: [el('div.grid-2',
      mk('mrn', t('patient.mrn'), input({ autocomplete: 'off', class: 'mono' }), { optional: true, hint: t('patient.mrnHint') }),
      mk('referredBy', t('patient.referredBy'), input({ autocomplete: 'off' }), { optional: true }),
      mk('occupation', t('patient.occupation'), input({ autocomplete: 'off' }), { optional: true }),
      mk('notes', t('patient.notes'), textarea({ rows: 3 }), { optional: true, cls: 'span-2', hint: t('patient.notesHint') }))] }),
    errBox,
    el('div.form-actions.sticky-actions',
      el('a.btn.btn-ghost', { href: editing ? `#/patients/${patient.id}` : '#/patients' }, t('common.cancel')),
      submit));

  let dirty = false;
  form.addEventListener('input', () => { dirty = true; });
  setLeaveGuard(async () => (dirty ? confirmDialog({ title: t('common.unsavedTitle'), message: t('common.unsavedBody'), confirmLabel: t('common.discard'), danger: true }) : true));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    Object.values(f).forEach((x) => x.setError(null)); errBox.textContent = '';
    const data = Object.fromEntries(Object.keys(f).map((k) => [k, form.elements[k].value.trim()]));
    let bad = null;
    for (const k of ['firstName', 'lastName', 'dob', 'sex']) if (!data[k]) { f[k].setError(t('validation.required')); bad = bad || form.elements[k]; }
    if (data.dob && data.dob > todayISO()) { f.dob.setError(t('validation.dobFuture')); bad = bad || form.elements.dob; }
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { f.email.setError(t('validation.email')); bad = bad || form.elements.email; }
    if (bad) { bad.focus(); errBox.replaceChildren(alertBox({ tone: 'danger', children: [el('p', t('validation.fixErrors'))] })); return; }
    setLoading(submit, true);
    try {
      const saved = editing ? await api.patch(`/patients/${patient.id}`, data) : await api.post('/patients', data);
      dirty = false;
      toast(editing ? t('patients.saved') : t('patients.created', { name: fullName(saved) }), { tone: 'success' });
      navigate(editing ? `/patients/${saved.id || patient.id}` : `/patients/${saved.id}/intake`);
    } catch (err) {
      if (err instanceof ValidationError && err.fields) for (const [k, m] of Object.entries(err.fields)) if (f[k]) f[k].setError(String(m));
      errBox.replaceChildren(alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] }));
    } finally { setLoading(submit, false); }
  });

  mount(main, el('div.page.page-narrow',
    pageHeader({ title: editing ? t('patients.editTitle', { name: fullName(patient) }) : t('patients.newTitle'), subtitle: t('patients.formSub'), back: { href: editing ? `#/patients/${patient.id}` : '#/patients', label: editing ? fullName(patient) : t('patients.title') } }),
    form));
  return () => { dirty = false; };
}
