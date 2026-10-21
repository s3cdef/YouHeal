// Settings: Profile (locale/theme/password/MFA) · Clinic profile · Users · Audit log.
import { el, mount, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, errorMessage, ValidationError } from '../api.js';
import { t, setLocale, getLocale, fmtDateTime } from '../i18n.js';
import { state, can, DEFAULT_POLARITY } from '../state.js';
import { tabs, card, field, input, textarea, select, segmented, alertBox, setLoading, table, chip, emptyState, skeleton } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { pageHeader, applyTheme, getTheme, errorPanel } from './common.js';
import { navigate } from '../router.js';

const ROLES = ['admin', 'practitioner', 'assistant', 'auditor'];

export async function renderSettings({ main, params, route }) {
  const wanted = params.tab || (route && route.tab);
  const available = [
    { id: 'profile', label: t('settings.tabProfile'), icon: 'user' },
    can.admin() ? { id: 'clinic', label: t('settings.tabClinic'), icon: 'home' } : null,
    can.admin() ? { id: 'users', label: t('settings.tabUsers'), icon: 'users' } : null,
    can.audit() ? { id: 'audit', label: t('settings.tabAudit'), icon: 'shield' } : null,
  ].filter(Boolean);
  const active = available.some((x) => x.id === wanted) ? wanted : 'profile';
  const tb = tabs({
    label: t('settings.title'), active, variant: 'line', tabs: available,
    onChange: (id, panel, user) => {
      if (user) history.replaceState(null, '', `#/settings/${id}`);
      clear(panel);
      ({ profile, clinic, users, audit })[id](panel);
    },
  });
  mount(main, el('div.page', pageHeader({ title: t('settings.title'), subtitle: t('settings.subtitle') }), tb.root, tb.panel));
  return null;
}

// ---------------- Profile ----------------
function profile(panel) {
  const u = state.user || {};
  const langSeg = segmented({ name: 'lang', label: t('settings.language'), value: getLocale(), options: [{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }],
    onChange: async (v) => { try { await api.patch('/auth/prefs', { locale: v }); if (state.user) state.user.locale = v; } catch (err) { toast(errorMessage(err), { tone: 'error' }); } await setLocale(v); } });
  const themeSeg = segmented({ name: 'theme', label: t('settings.theme'), value: getTheme(), options: ['light', 'dark', 'system'].map((v) => ({ value: v, label: t(`theme.${v}`), icon: v === 'light' ? 'sun' : v === 'dark' ? 'moon' : 'monitor' })),
    onChange: (v) => { applyTheme(v); api.patch('/auth/prefs', { theme: v }).catch(() => {}); } });

  const cur = input({ type: 'password', autocomplete: 'current-password' });
  const next = input({ type: 'password', autocomplete: 'new-password' });
  const conf = input({ type: 'password', autocomplete: 'new-password' });
  const fCur = field({ label: t('settings.currentPassword'), input: cur, required: true });
  const fNext = field({ label: t('settings.newPassword'), input: next, hint: t('auth.pw.hint'), required: true });
  const fConf = field({ label: t('auth.confirmPassword'), input: conf, required: true });
  const pwBtn = el('button.btn.btn-secondary', { type: 'submit' }, t('settings.changePassword'));
  const pwForm = el('form.form', { novalidate: true }, fCur, fNext, fConf, el('div.form-actions', pwBtn));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault(); [fCur, fNext, fConf].forEach((f) => f.setError(null));
    if (!cur.value) { fCur.setError(t('validation.required')); cur.focus(); return; }
    if (next.value.length < 12) { fNext.setError(t('auth.pw.minLength')); next.focus(); return; }
    if (next.value !== conf.value) { fConf.setError(t('validation.passwordMismatch')); conf.focus(); return; }
    setLoading(pwBtn, true);
    try { await api.post('/auth/password', { current: cur.value, next: next.value }); pwForm.reset(); toast(t('settings.passwordChanged'), { tone: 'success' }); }
    catch (err) { if (err instanceof ValidationError && err.fields) { if (err.fields.current) fCur.setError(err.fields.current); if (err.fields.next) fNext.setError(err.fields.next); } else toast(errorMessage(err), { tone: 'error' }); }
    finally { setLoading(pwBtn, false); }
  });

  const mfaBody = u.mfaEnabled
    ? el('div', el('p.ok-line', icon('shield', { size: 18 }), t('settings.mfaOn')),
      u.role === 'admin' ? el('p.muted.small', t('settings.mfaAdminRequired')) : el('button.btn.btn-ghost.danger', { type: 'button', onClick: disableMfa }, t('settings.mfaDisable')))
    : el('div', alertBox({ tone: 'warn', children: [el('p', t('settings.mfaOff'))] }), el('a.btn.btn-primary', { href: '#/mfa' }, icon('shield', { size: 18 }), t('settings.mfaSetup')));

  mount(panel, el('div.settings-grid',
    card({ title: t('settings.account'), icon: 'user', children: [el('dl.dl', el('dt', t('settings.name')), el('dd', u.name || '—'), el('dt', t('auth.email')), el('dd', u.email || '—'), el('dt', t('settings.role')), el('dd', u.role ? t(`roles.${u.role}`) : '—'))] }),
    card({ title: t('settings.preferences'), icon: 'settings', children: [
      el('div.field', el('span.label', t('settings.language')), langSeg, el('p.field-hint', t('settings.languageHint'))),
      el('div.field', el('span.label', t('settings.theme')), themeSeg)] }),
    card({ title: t('settings.password'), icon: 'lock', children: [pwForm] }),
    card({ title: t('settings.mfa'), icon: 'shield', children: [mfaBody] })));

  async function disableMfa() {
    const pw = input({ type: 'password', autocomplete: 'current-password' });
    const code = input({ inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', class: 'input-code' });
    const f1 = field({ label: t('auth.password'), input: pw, required: true });
    const f2 = field({ label: t('auth.totpCode'), input: code, required: true });
    const m = openModal({ title: t('settings.mfaDisable'), icon: 'alert', tone: 'danger', body: el('div.stack', el('p', t('settings.mfaDisableBody')), f1, f2),
      actions: [{ label: t('common.cancel'), value: null, variant: 'ghost' }, { label: t('settings.mfaDisable'), value: 'ok', variant: 'danger', onClick: async () => {
        try { await api.post('/auth/mfa/disable', { password: pw.value, code: code.value }); return true; } catch (err) { f2.setError(errorMessage(err)); return false; }
      } }] });
    if ((await m.result) === 'ok') { state.user.mfaEnabled = false; toast(t('settings.mfaDisabled'), { tone: 'success' }); profile(clear(panel)); }
  }
}

// ---------------- Clinic ----------------
async function clinic(panel) {
  mount(panel, skeleton(8));
  let org;
  try { org = await api.get('/org'); } catch (err) { mount(panel, errorPanel(err)); return; }
  const f = {};
  const mk = (k, label, inp, opts = {}) => { inp.name = k; inp.value = org[k] ?? ''; f[k] = field({ label, input: inp, ...opts }); return f[k]; };
  let logo = org.logo || null;
  const pol = { ...DEFAULT_POLARITY, ...(org.polarity || {}) };
  const logoPreview = el('div.logo-preview');
  const renderLogo = () => mount(logoPreview, logo ? el('img', { src: logo, alt: t('settings.logoPreview') }) : el('span.muted', t('settings.noLogo')));
  renderLogo();
  const fileIn = el('input.sr-only', { type: 'file', id: 'logo-file', accept: 'image/png,image/jpeg,image/webp' });
  fileIn.addEventListener('change', () => {
    const file = fileIn.files && fileIn.files[0]; if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast(t('settings.logoType'), { tone: 'error' }); return; }
    if (file.size > 200 * 1024) { toast(t('settings.logoTooBig'), { tone: 'error' }); return; }
    const r = new FileReader();
    r.onload = () => { logo = String(r.result); renderLogo(); };
    r.readAsDataURL(file);
  });
  const negIn = el('input.color-input', { type: 'color', id: 'pol-neg', value: pol.negative });
  const posIn = el('input.color-input', { type: 'color', id: 'pol-pos', value: pol.positive });
  const polPreview = el('div.pol-preview', { aria: { hidden: 'true' } });
  const renderPol = () => {
    clear(polPreview);
    const a = el('span.mag.mag-lg', '−'); a.style.background = negIn.value;
    const b = el('span.mag.mag-lg', '+'); b.style.background = posIn.value;
    polPreview.append(a, b);
  };
  negIn.addEventListener('input', renderPol); posIn.addEventListener('input', renderPol); renderPol();
  const locSel = select([{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]);
  const btn = el('button.btn.btn-primary.btn-lg', { type: 'submit' }, icon('check', { size: 18 }), t('common.saveChanges'));
  const form = el('form.form.form-sections', { novalidate: true },
    card({ title: t('settings.clinicIdentity'), icon: 'home', children: [el('div.grid-2',
      mk('name', t('settings.clinicName'), input(), { required: true }), mk('legalName', t('settings.legalName'), input(), { optional: true }),
      mk('address', t('settings.address'), input(), { cls: 'span-2', optional: true }),
      mk('phone', t('patient.phone'), input({ type: 'tel' }), { optional: true }), mk('email', t('auth.email'), input({ type: 'email' }), { optional: true }),
      mk('website', t('settings.website'), input(), { optional: true }), mk('license', t('settings.license'), input(), { optional: true }),
      mk('defaultLocale', t('settings.defaultLocale'), locSel))] }),
    card({ title: t('settings.logo'), icon: 'upload', children: [el('div.logo-row', logoPreview,
      el('div.stack', el('label.btn.btn-secondary', { for: 'logo-file' }, icon('upload', { size: 18 }), t('settings.uploadLogo')), fileIn,
        el('button.btn.btn-ghost', { type: 'button', onClick: () => { logo = null; renderLogo(); } }, t('settings.removeLogo')),
        el('p.field-hint', t('settings.logoHint'))))] }),
    card({ title: t('settings.reportSection'), icon: 'file', children: [
      mk('reportFooter', t('settings.reportFooter'), textarea({ rows: 2 }), { optional: true, hint: t('settings.reportFooterHint') }),
      el('fieldset.pol-field', el('legend.label', t('settings.polarity')),
        el('div.pol-row',
          el('label.pol-item', { for: 'pol-neg' }, negIn, el('span', t('polarity.trackingNeg'))),
          el('label.pol-item', { for: 'pol-pos' }, posIn, el('span', t('polarity.impactPos'))),
          polPreview,
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => { negIn.value = DEFAULT_POLARITY.negative; posIn.value = DEFAULT_POLARITY.positive; renderPol(); } }, t('settings.resetDefaults'))),
        el('p.field-hint', t('settings.polarityHint')))] }),
    el('div.form-actions.sticky-actions', btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(Object.keys(f).map((k) => [k, form.elements[k].value.trim()]));
    if (!data.name) { f.name.setError(t('validation.required')); form.elements.name.focus(); return; }
    data.logo = logo; data.polarity = { negative: negIn.value.toUpperCase(), positive: posIn.value.toUpperCase() };
    setLoading(btn, true);
    try {
      const saved = await api.patch('/org', data);
      state.org = { ...(state.org || {}), ...(saved || data) };
      document.documentElement.style.setProperty('--pol-neg', data.polarity.negative);
      document.documentElement.style.setProperty('--pol-pos', data.polarity.positive);
      toast(t('settings.clinicSaved'), { tone: 'success' });
    } catch (err) {
      if (err instanceof ValidationError && err.fields) for (const [k, m] of Object.entries(err.fields)) if (f[k]) f[k].setError(String(m));
      toast(errorMessage(err), { tone: 'error' });
    } finally { setLoading(btn, false); }
  });
  mount(panel, form);
}

// ---------------- Users ----------------
async function users(panel) {
  mount(panel, skeleton(6));
  let list;
  try { list = items(await api.get('/users')); } catch (err) { mount(panel, errorPanel(err)); return; }
  const add = el('button.btn.btn-primary', { type: 'button', onClick: () => addUser() }, icon('plus', { size: 18 }), t('settings.addUser'));
  mount(panel, card({ title: t('settings.tabUsers'), icon: 'users', actions: add, children: [table({
    caption: t('settings.tabUsers'), rows: list,
    columns: [
      { key: 'name', label: t('settings.name'), render: (u) => el('span.cell-stack', el('span.cell-strong', u.name), el('span.muted.small', u.email)) },
      { key: 'role', label: t('settings.role'), render: (u) => {
        const s = select(ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) })), { class: 'select-sm', aria: { label: t('settings.roleFor', { name: u.name }) }, disabled: u.id === state.user.id });
        s.value = u.role;
        s.addEventListener('change', async () => { try { await api.patch(`/users/${u.id}`, { role: s.value }); toast(t('settings.userUpdated'), { tone: 'success' }); } catch (err) { s.value = u.role; toast(errorMessage(err), { tone: 'error' }); } });
        return s;
      } },
      { key: 'mfa', label: 'MFA', render: (u) => (u.mfaEnabled ? chip(t('settings.mfaOnShort'), 'teal') : chip(t('settings.mfaOffShort'), 'amber')) },
      { key: 'status', label: t('session.status'), render: (u) => (u.active !== false ? chip(t('settings.active'), 'teal') : chip(t('settings.inactive'), 'slate')) },
      { key: 'last', label: t('settings.lastLogin'), render: (u) => (u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : el('span.muted', t('settings.never'))) },
      { key: 'act', label: el('span.sr-only', t('common.actions')), align: 'right', render: (u) => (u.id === state.user.id ? el('span.muted.small', t('settings.you')) : el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: async () => {
        const deactivate = u.active !== false;
        const ok = await confirmDialog({ title: deactivate ? t('settings.deactivateTitle', { name: u.name }) : t('settings.reactivateTitle', { name: u.name }), message: deactivate ? t('settings.deactivateBody') : t('settings.reactivateBody'), confirmLabel: deactivate ? t('settings.deactivate') : t('settings.reactivate'), danger: deactivate });
        if (!ok) return;
        try { await api.patch(`/users/${u.id}`, { active: !deactivate }); toast(t('settings.userUpdated'), { tone: 'success' }); users(panel); } catch (err) { toast(errorMessage(err), { tone: 'error' }); }
      } }, u.active !== false ? t('settings.deactivate') : t('settings.reactivate'))) },
    ],
  })] }));

  function addUser() {
    const name = input({ autocomplete: 'off' }); const email = input({ type: 'email', autocomplete: 'off' });
    const role = select(ROLES.map((r) => ({ value: r, label: t(`roles.${r}`), selected: r === 'practitioner' })));
    const pw = input({ autocomplete: 'off', class: 'mono' });
    const gen = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); pw.value = Array.from(a, (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('').replace(/(.{4})(?=.)/g, '$1-'); };
    gen();
    const fN = field({ label: t('settings.name'), input: name, required: true });
    const fE = field({ label: t('auth.email'), input: email, required: true });
    const fR = field({ label: t('settings.role'), input: role, hint: t('settings.roleHint') });
    const fP = field({ label: t('settings.tempPassword'), input: pw, hint: t('settings.tempPasswordHint'), required: true });
    const m = openModal({ title: t('settings.addUser'), icon: 'user', body: el('div.stack', fN, fE, fR, el('div', fP, el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: gen }, icon('refresh', { size: 16 }), t('settings.generate')))),
      actions: [{ label: t('common.cancel'), value: null, variant: 'ghost' }, { label: t('settings.createUser'), value: 'ok', variant: 'primary', onClick: async () => {
        [fN, fE, fP].forEach((x) => x.setError(null));
        if (!name.value.trim()) { fN.setError(t('validation.required')); return false; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { fE.setError(t('validation.email')); return false; }
        if (pw.value.length < 12) { fP.setError(t('auth.pw.minLength')); return false; }
        try { await api.post('/users', { name: name.value.trim(), email: email.value.trim(), role: role.value, password: pw.value }); return true; }
        catch (err) { if (err.fields?.email) fE.setError(err.fields.email); else fP.setError(errorMessage(err)); return false; }
      } }] });
    m.result.then((v) => { if (v === 'ok') { toast(t('settings.userCreated'), { tone: 'success' }); users(panel); } });
  }
}

// ---------------- Audit ----------------
async function audit(panel) {
  const actor = input({ type: 'search', id: 'audit-actor', placeholder: t('settings.auditActor') });
  const action = input({ type: 'search', id: 'audit-action', placeholder: t('settings.auditAction') });
  const verifyBtn = el('button.btn.btn-secondary', { type: 'button' }, icon('shield', { size: 18 }), t('settings.verify'));
  const verifyOut = el('div', { aria: { live: 'polite' } });
  const results = el('div', skeleton(6));
  const more = el('button.btn.btn-ghost', { type: 'button', hidden: true }, t('settings.loadMore'));
  let rows = []; let offset = 0; let total = 0;
  mount(panel,
    card({ title: t('settings.integrity'), icon: 'shield', sub: t('settings.integritySub'), actions: el('div.btn-row', verifyBtn, can.admin() ? el('a.btn.btn-ghost', { href: '/api/v1/admin/backup', download: '' }, icon('upload', { size: 18 }), t('settings.backup')) : null), children: [verifyOut] }),
    card({ title: t('settings.tabAudit'), icon: 'list', children: [
      el('div.filters', el('div.filter', el('label.label', { for: 'audit-actor' }, t('settings.actor')), actor), el('div.filter', el('label.label', { for: 'audit-action' }, t('settings.action')), action)),
      results, more] }));
  verifyBtn.addEventListener('click', async () => {
    setLoading(verifyBtn, true);
    try {
      const r = await api.get('/audit/verify');
      mount(verifyOut, r.ok ? alertBox({ tone: 'success', ic: 'check', title: t('settings.verifyOk'), children: [el('p', t('settings.verifyOkBody', { n: r.checked }))] })
        : alertBox({ tone: 'danger', title: t('settings.verifyBroken'), children: [el('p', t('settings.verifyBrokenBody', { row: r.brokenAt }))] }));
    } catch (err) { mount(verifyOut, alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })); }
    finally { setLoading(verifyBtn, false); }
  });
  async function load(reset = true) {
    if (reset) { offset = 0; rows = []; }
    try {
      const r = await api.get('/audit', { limit: 50, offset, actor: actor.value.trim(), action: action.value.trim() });
      rows = rows.concat(items(r)); total = r.total ?? rows.length; offset = rows.length;
    } catch (err) { mount(results, errorPanel(err, () => load(true))); return; }
    more.hidden = rows.length >= total;
    mount(results, table({
      caption: t('settings.tabAudit'), rows, dense: true, empty: emptyState({ icon: 'list', title: t('settings.noAudit'), compact: true }),
      columns: [
        { key: 'ts', label: t('settings.time'), render: (a) => fmtDateTime(a.ts) },
        { key: 'actor', label: t('settings.actor'), render: (a) => (a.actor ? el('span.cell-stack', el('span', a.actor.name || a.actor.email), el('span.muted.small', a.actor.email || '')) : el('span.muted', '—')) },
        { key: 'action', label: t('settings.action'), render: (a) => el('code.code-tag', a.action) },
        { key: 'target', label: t('settings.target'), cls: 'mono small', render: (a) => (a.target ? String(a.target) : '—') },
        { key: 'ip', label: 'IP', cls: 'mono small' },
        { key: 'hash', label: t('report.hash'), cls: 'mono small', render: (a) => (a.hash ? `${a.hash.slice(0, 12)}…` : '—') },
      ],
    }));
  }
  let tmr;
  for (const n of [actor, action]) n.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => load(true), 300); });
  more.addEventListener('click', () => load(false));
  load(true);
  void navigate;
}
