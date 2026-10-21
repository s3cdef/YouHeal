// Settings: Profile (locale/theme/password/MFA) · Clinic profile · Users · Language packs · Audit log.
import { el, mount, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, errorMessage, ValidationError } from '../api.js';
import { t, setLocale, getLocale, fmtDateTime } from '../i18n.js';
import { state, can, DEFAULT_POLARITY } from '../state.js';
import { tabs, card, field, input, textarea, select, segmented, languagePicker, languageOptions, alertBox, setLoading, table, chip, emptyState, skeleton } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { pageHeader, applyTheme, getTheme, errorPanel } from './common.js';
import { navigate } from '../router.js';
import { showSidebarLogo, handleLockout, refreshMe } from '../app.js';
import { recoveryCodesBlock } from '../ui/recovery.js';
import { renderLanguagePacks } from './language-packs.js';

const ROLES = ['admin', 'practitioner', 'assistant', 'auditor'];

export async function renderSettings({ main, params, route, query }) {
  const wanted = params.tab || (route && route.tab);
  const available = [
    { id: 'profile', label: t('settings.tabProfile'), icon: 'user' },
    can.admin() ? { id: 'clinic', label: t('settings.tabClinic'), icon: 'home' } : null,
    can.admin() ? { id: 'users', label: t('settings.tabUsers'), icon: 'users' } : null,
    can.admin() ? { id: 'languages', label: t('settings.tabLanguages'), icon: 'globe' } : null,
    can.audit() ? { id: 'audit', label: t('settings.tabAudit'), icon: 'shield' } : null,
  ].filter(Boolean);
  const active = available.some((x) => x.id === wanted) ? wanted : 'profile';
  const tb = tabs({
    label: t('settings.title'), active, variant: 'line', tabs: available,
    onChange: (id, panel, user) => {
      if (user) history.replaceState(null, '', `#/settings/${id}`);
      clear(panel);
      ({ profile, clinic, users, audit, languages: renderLanguagePacks })[id](panel, query || {});
    },
  });
  mount(main, el('div.page', pageHeader({ title: t('settings.title'), subtitle: t('settings.subtitle') }), tb.root, tb.panel));
  return null;
}

// ---------------- Profile ----------------
function profile(panel, query = {}) {
  const u = state.user || {};
  const langSeg = languagePicker({ name: 'lang', label: t('settings.language'), value: getLocale(), names: true,
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
    catch (err) { if (handleLockout(err)) return; if (err instanceof ValidationError && err.fields) { if (err.fields.current) fCur.setError(err.fields.current); if (err.fields.next) fNext.setError(err.fields.next); } else toast(errorMessage(err), { tone: 'error' }); }
    finally { setLoading(pwBtn, false); }
  });

  const regenBtn = el('button.btn.btn-secondary', { type: 'button', id: 'regen-recovery', onClick: () => regenerateRecovery() }, icon('refresh', { size: 18 }), t('recovery.regenerate'));
  const recoverySection = el('div.recovery-section#recovery-codes',
    el('h3.sub-title', t('recovery.title')),
    state.recoveryRegen ? alertBox({ tone: 'warn', children: [el('p', t('recovery.banner'))] })
      : el('p.muted.small', t('recovery.remaining', { count: u.recoveryCodesRemaining ?? 0 })),
    el('p.field-hint', t('recovery.hint')),
    regenBtn);
  const mfaBody = u.mfaEnabled
    ? el('div.stack', el('p.ok-line', icon('shield', { size: 18 }), t('settings.mfaOn')),
      u.role === 'admin' ? el('p.muted.small', t('settings.mfaAdminRequired')) : el('button.btn.btn-ghost.danger', { type: 'button', onClick: disableMfa }, t('settings.mfaDisable')),
      recoverySection)
    : el('div', alertBox({ tone: 'warn', children: [el('p', t('settings.mfaOff'))] }), el('a.btn.btn-primary', { href: '#/mfa' }, icon('shield', { size: 18 }), t('settings.mfaSetup')));

  mount(panel, el('div.settings-grid',
    card({ title: t('settings.account'), icon: 'user', children: [el('dl.dl', el('dt', t('settings.name')), el('dd', u.name || '—'), el('dt', t('auth.email')), el('dd', u.email || '—'), el('dt', t('settings.role')), el('dd', u.role ? t(`roles.${u.role}`) : '—'))] }),
    card({ title: t('settings.preferences'), icon: 'settings', children: [
      el('div.field', el('span.label', t('settings.language')), langSeg, el('p.field-hint', t('settings.languageHint'))),
      el('div.field', el('span.label', t('settings.theme')), themeSeg)] }),
    card({ title: t('settings.password'), icon: 'lock', children: [pwForm] }),
    card({ title: t('settings.mfa'), icon: 'shield', children: [mfaBody] })));

  if (query.focus === 'recovery' && u.mfaEnabled) requestAnimationFrame(() => { recoverySection.scrollIntoView({ block: 'center' }); regenBtn.focus({ preventScroll: true }); });

  async function regenerateRecovery() {
    const pw = input({ type: 'password', autocomplete: 'current-password', id: 'regen-pw' });
    const code = input({ inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', class: 'input-code', id: 'regen-code' });
    const f1 = field({ label: t('auth.password'), input: pw, required: true });
    const f2 = field({ label: t('auth.totpCode'), input: code, hint: t('auth.totpHint'), required: true });
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });
    const m = openModal({ title: t('recovery.regenerate'), icon: 'shield', body: el('div.stack', el('p', t('recovery.regenBody')), f1, f2),
      actions: [{ label: t('common.cancel'), value: null, variant: 'ghost' }, { label: t('recovery.regenConfirm'), value: 'ok', variant: 'primary', onClick: async () => {
        f1.setError(null); f2.setError(null);
        if (!pw.value) { f1.setError(t('validation.required')); pw.focus(); return false; }
        if (!/^\d{6}$/.test(code.value)) { f2.setError(t('validation.totp')); code.focus(); return false; }
        try { m.codes = (await api.post('/auth/mfa/recovery-codes', { password: pw.value, code: code.value })).recoveryCodes || []; return true; } catch (err) {
          if (handleLockout(err)) { m.close(null); return false; }
          if (err.code === 'REAUTH_FAILED' || err.status === 403) { f2.setError(t('recovery.reauthFailed')); code.value = ''; code.focus(); return false; }
          f2.setError(errorMessage(err)); return false;
        }
      } }] });
    if ((await m.result) !== 'ok' || !m.codes) return;
    await refreshMe().catch(() => {});
    // must-acknowledge: not dismissible until the user confirms the new codes were saved
    const shown = openModal({ title: t('mfa.recoveryTitle'), icon: 'shield', size: 'md', dismissible: false,
      body: el('div.stack', el('p', t('recovery.newCodesBody')),
        recoveryCodesBlock(m.codes, { email: u.email, doneLabel: t('common.done'), onDone: () => shown.close('done') })) });
    await shown.result;
    toast(t('recovery.regenerated'), { tone: 'success' });
    profile(clear(panel));
  }

  async function disableMfa() {
    const pw = input({ type: 'password', autocomplete: 'current-password' });
    const code = input({ inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', class: 'input-code' });
    const f1 = field({ label: t('auth.password'), input: pw, required: true });
    const f2 = field({ label: t('auth.totpCode'), input: code, required: true });
    const m = openModal({ title: t('settings.mfaDisable'), icon: 'alert', tone: 'danger', body: el('div.stack', el('p', t('settings.mfaDisableBody')), f1, f2),
      actions: [{ label: t('common.cancel'), value: null, variant: 'ghost' }, { label: t('settings.mfaDisable'), value: 'ok', variant: 'danger', onClick: async () => {
        try { await api.post('/auth/mfa/disable', { password: pw.value, code: code.value }); return true; } catch (err) { if (handleLockout(err)) { m.close(null); return false; } f2.setError(errorMessage(err)); return false; }
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
    if (file.size > 200 * 1024) { toast(t('settings.logoTooBig'), { tone: 'error' }); fileIn.value = ''; return; }
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
  const locSel = select(languageOptions(org.defaultLocale || 'en'));
  const btn = el('button.btn.btn-primary.btn-lg', { type: 'submit' }, icon('check', { size: 18 }), t('common.saveChanges'));
  const form = el('form.form.form-sections', { novalidate: true },
    card({ title: t('settings.clinicIdentity'), icon: 'home', children: [el('div.grid-2',
      mk('name', t('settings.clinicName'), input(), { required: true }), mk('legalName', t('settings.legalName'), input(), { optional: true }),
      mk('address', t('settings.address'), input(), { cls: 'span-2', optional: true }),
      mk('phone', t('patient.phone'), input({ type: 'tel' }), { optional: true }), mk('email', t('auth.email'), input({ type: 'email' }), { optional: true }),
      mk('website', t('settings.website'), input({ type: 'url', placeholder: 'https://' }), { optional: true }), mk('license', t('settings.license'), input(), { optional: true }),
      mk('defaultLocale', t('settings.defaultLocale'), locSel))] }),
    !('logo' in org) ? null : card({ title: t('settings.logo'), icon: 'upload', children: [el('div.logo-row', logoPreview,
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
    if ('logo' in org) data.logo = logo;
    data.polarity = { negative: negIn.value.toUpperCase(), positive: posIn.value.toUpperCase() };
    for (const k of ['legalName', 'address', 'phone', 'email', 'website', 'license', 'reportFooter']) if (data[k] === '') data[k] = null;
    if (data.website && !/^https?:\/\//.test(data.website)) { f.website.setError(t('validation.website')); form.elements.website.focus(); return; }
    setLoading(btn, true);
    try {
      const saved = await api.patch('/org', data);
      state.org = { ...(state.org || {}), ...(saved || data), hasLogo: !!logo };
      state.orgLogo = logo || null;
      showSidebarLogo();
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
  const patchUser = async (u, body, msg) => {
    try { await api.patch(`/users/${u.id}`, body); toast(msg || t('settings.userUpdated'), { tone: 'success' }); users(panel); } catch (err) { toast(errorMessage(err), { tone: 'error' }); }
  };
  mount(panel, card({ title: t('settings.tabUsers'), icon: 'users', actions: add, children: [table({
    caption: t('settings.tabUsers'), rows: list,
    columns: [
      { key: 'name', label: t('settings.name'), render: (u) => el('span.cell-stack', el('span.cell-strong', u.name), el('span.muted.small', u.email)) },
      { key: 'role', label: t('settings.role'), render: (u) => {
        const sel = select(ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) })), { class: 'select-sm', aria: { label: t('settings.roleFor', { name: u.name }) }, disabled: u.id === state.user.id });
        sel.value = u.role;
        sel.addEventListener('change', async () => { try { await api.patch(`/users/${u.id}`, { role: sel.value }); toast(t('settings.userUpdated'), { tone: 'success' }); } catch (err) { sel.value = u.role; toast(errorMessage(err), { tone: 'error' }); } });
        return sel;
      } },
      { key: 'mfa', label: t('settings.colMfa'), render: (u) => (u.mfaEnabled ? chip(t('settings.mfaOnShort'), 'teal') : chip(t('settings.mfaOffShort'), u.role === 'admin' ? 'rose' : 'amber')) },
      { key: 'status', label: t('session.status'), render: (u) => el('span.chips-inline',
        u.active !== false ? chip(t('settings.active'), 'teal') : chip(t('settings.inactive'), 'slate'),
        u.locked ? chip(t('settings.locked'), 'rose') : null,
        u.mustChangePassword ? chip(t('settings.mustChange'), 'amber') : null) },
      { key: 'last', label: t('settings.lastLogin'), render: (u) => (u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : el('span.muted', t('settings.never'))) },
      { key: 'act', label: el('span.sr-only', t('common.actions')), align: 'right', render: (u) => (u.id === state.user.id ? el('span.muted.small', t('settings.you')) : el('div.btn-row.end',
        u.locked ? el('button.btn.btn-sm.btn-secondary', { type: 'button', onClick: () => patchUser(u, { unlock: true }, t('settings.unlocked')) }, icon('lock', { size: 16 }), t('settings.unlock')) : null,
        u.mfaEnabled ? el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: async () => {
          if (await confirmDialog({ title: t('settings.resetMfaTitle', { name: u.name }), message: t('settings.resetMfaBody'), confirmLabel: t('settings.resetMfa'), danger: true })) patchUser(u, { resetMfa: true });
        } }, t('settings.resetMfa')) : null,
        el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: async () => {
          const deactivate = u.active !== false;
          const ok = await confirmDialog({ title: deactivate ? t('settings.deactivateTitle', { name: u.name }) : t('settings.reactivateTitle', { name: u.name }), message: deactivate ? t('settings.deactivateBody') : t('settings.reactivateBody'), confirmLabel: deactivate ? t('settings.deactivate') : t('settings.reactivate'), danger: deactivate });
          if (ok) patchUser(u, { active: !deactivate });
        } }, u.active !== false ? t('settings.deactivate') : t('settings.reactivate')))) },
    ],
  })] }));

  function addUser() {
    const name = input({ autocomplete: 'off' }); const email = input({ type: 'email', autocomplete: 'off' });
    const role = select(ROLES.map((r) => ({ value: r, label: t(`roles.${r}`), selected: r === 'practitioner' })));
    const pw = input({ type: 'text', autocomplete: 'off', class: 'mono' });
    const fN = field({ label: t('settings.name'), input: name, required: true });
    const fE = field({ label: t('auth.email'), input: email, required: true });
    const fR = field({ label: t('settings.role'), input: role, hint: t('settings.roleHint') });
    const fP = field({ label: t('settings.tempPassword'), input: pw, hint: t('settings.tempPasswordHint') });
    fP.hidden = true;
    const gen = el('input', { type: 'checkbox', checked: true });
    gen.addEventListener('change', () => { fP.hidden = gen.checked; });
    const m = openModal({ title: t('settings.addUser'), icon: 'user', body: el('div.stack', fN, fE, fR, el('label.check', gen, el('span', t('settings.generateTemp'))), fP),
      actions: [{ label: t('common.cancel'), value: null, variant: 'ghost' }, { label: t('settings.createUser'), value: 'ok', variant: 'primary', onClick: async () => {
        [fN, fE, fP].forEach((x) => x.setError(null));
        if (!name.value.trim()) { fN.setError(t('validation.required')); return false; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { fE.setError(t('validation.email')); return false; }
        if (!gen.checked && pw.value.length < 12) { fP.setError(t('auth.pw.minLength')); return false; }
        try {
          m.res = await api.post('/users', { name: name.value.trim(), email: email.value.trim(), role: role.value, ...(gen.checked ? {} : { password: pw.value, mustChangePassword: true }) });
          return true;
        } catch (err) { if (err.code === 'EMAIL_TAKEN' || err.fields?.email) fE.setError(errorMessage(err)); else if (err.fields?.password) fP.setError(err.fields.password); else fN.setError(errorMessage(err)); return false; }
      } }] });
    m.result.then((v) => {
      if (v !== 'ok') return;
      users(panel);
      const temp = m.res && m.res.temporaryPassword;
      if (!temp) { toast(t('settings.userCreated'), { tone: 'success' }); return; }
      const copy = el('button.btn.btn-secondary', { type: 'button' }, icon('copy', { size: 18 }), t('common.copy'));
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(temp); toast(t('common.copied'), { tone: 'success' }); } catch { toast(t('common.copyFailed'), { tone: 'warn' }); } });
      openModal({ title: t('settings.userCreated'), icon: 'lock', body: el('div.stack', el('p', t('settings.tempShown', { email: m.res.user ? m.res.user.email : '' })), el('div.secret-box', el('code.secret', temp), copy), alertBox({ tone: 'warn', children: [el('p', t('settings.tempWarn'))] })),
        actions: [{ label: t('common.done'), value: null, variant: 'primary', autofocus: true }] });
    });
  }
}

// ---------------- Audit ----------------
async function audit(panel) {
  const actor = select([{ value: '', label: t('settings.allUsers') }], { id: 'audit-actor' });
  api.get('/users', { minimal: 1 }).then((r) => { for (const u of items(r)) actor.append(el('option', { value: u.id }, u.email ? `${u.name} · ${u.email}` : u.name)); }).catch(() => { actor.disabled = true; });
  const action = input({ type: 'search', id: 'audit-action', placeholder: t('settings.auditAction'), spellcheck: 'false' });
  const verifyBtn = el('button.btn.btn-secondary', { type: 'button' }, icon('shield', { size: 18 }), t('settings.verify'));
  const verifyOut = el('div', { aria: { live: 'polite' } });
  const results = el('div', skeleton(6));
  const more = el('button.btn.btn-ghost', { type: 'button', hidden: true }, t('settings.loadMore'));
  let rows = []; let offset = 0; let total = 0;
  mount(panel,
    card({ title: t('settings.integrity'), icon: 'shield', sub: t('settings.integritySub'), actions: el('div.btn-row', verifyBtn, can.admin() ? el('a.btn.btn-ghost', { href: '/api/v1/admin/backup', download: '' }, icon('download', { size: 18 }), t('settings.backup')) : null), children: [verifyOut] }),
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
      const a = action.value.trim().toLowerCase().replace(/[^a-z0-9_.*]/g, '');
      const r = await api.get('/audit', { limit: 50, offset, actor: actor.value, action: a ? (a.endsWith('*') ? a : `${a}*`) : '' });
      rows = rows.concat(items(r)); total = r.total ?? rows.length; offset = rows.length;
    } catch (err) { mount(results, errorPanel(err, () => load(true))); return; }
    more.hidden = rows.length >= total;
    mount(results, table({
      caption: t('settings.tabAudit'), rows, dense: true, empty: emptyState({ icon: 'list', title: t('settings.noAudit'), compact: true }),
      columns: [
        { key: 'ts', label: t('settings.time'), render: (a) => fmtDateTime(a.ts) },
        { key: 'actor', label: t('settings.actor'), render: (a) => (a.actor ? el('span.cell-stack', el('span', a.actor.name || a.actor.email), el('span.muted.small', a.actor.email || '')) : el('span.muted', '—')) },
        { key: 'action', label: t('settings.action'), render: (a) => el('span.cell-stack', el('code.code-tag', a.action), a.outcome && a.outcome !== 'success' ? chip(t(`settings.outcome.${a.outcome}`), 'rose', 'chip-sm') : null) },
        { key: 'target', label: t('settings.target'), cls: 'small', render: (a) => {
          const id2 = a.targetId || a.target; if (!id2) return '—';
          const label = `${a.targetType ? a.targetType + ' · ' : ''}${String(id2).slice(0, 8)}…`;
          // auditors can only open signed reports: link from finalize/amend/report rows, not draft activity
          const signedRow = can.clinical() || /^(session\.finalize|session\.amend|report\.)/.test(a.action);
          return a.targetType === 'session' && can.reports() && signedRow ? el('a.mono', { href: `#/sessions/${id2}/report`, title: t('settings.openReport') }, label) : el('span.mono', { title: String(id2) }, label);
        } },
        { key: 'ip', label: t('settings.colIp'), cls: 'mono small' },
        { key: 'hash', label: t('report.hash'), cls: 'mono small', render: (a) => (a.hash ? `${a.hash.slice(0, 12)}…` : '—') },
      ],
    }));
  }
  let tmr;
  action.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => load(true), 350); });
  actor.addEventListener('change', () => load(true));
  more.addEventListener('click', () => load(false));
  load(true);
  void navigate;
}
