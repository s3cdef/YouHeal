// Setup wizard, login (password → TOTP), MFA enrollment with QR + recovery codes.
import { el, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, errorMessage, MfaRequiredError, ValidationError } from '../api.js';
import { t } from '../i18n.js';
import { navigate } from '../router.js';
import { state } from '../state.js';
import { field, input, alertBox, setLoading } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { qrSvg } from '../ui/qr.js';
import { afterLogin, goAfterLogin, takeNotice, signOut } from '../app.js';

function authCard({ title, sub, children, steps = null }) {
  return el('section.auth-card',
    steps,
    el('h1.auth-title', { tabindex: '-1' }, title),
    sub ? el('p.auth-sub', sub) : null,
    children,
  );
}

function stepper(labels, current) {
  return el('ol.stepper', { aria: { label: t('common.progress') } }, labels.map((l, i) => el(`li.step${i < current ? '.is-done' : ''}${i === current ? '.is-current' : ''}`, { aria: { current: i === current ? 'step' : null } },
    el('span.step-num', i < current ? icon('check', { size: 14 }) : String(i + 1)), el('span.step-label', l))));
}

function passwordInput(props = {}) {
  const inp = input({ type: 'password', autocomplete: 'new-password', ...props });
  const toggle = el('button.icon-btn.pw-toggle', { type: 'button', aria: { label: t('auth.showPassword'), pressed: 'false' } }, icon('eye', { size: 18 }));
  toggle.addEventListener('click', () => {
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    toggle.setAttribute('aria-label', show ? t('auth.hidePassword') : t('auth.showPassword'));
  });
  const wrap = el('div.pw-wrap', inp, toggle);
  wrap.input = inp;
  return wrap;
}

function passwordProblems(pw, email = '') {
  const probs = [];
  if (pw.length < 12) probs.push(t('auth.pw.minLength'));
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890|password|qwerty)/i.test(pw)) probs.push(t('auth.pw.common'));
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 3) probs.push(t('auth.pw.containsEmail'));
  return probs;
}

function bindPwField(pwWrap, fieldWrap, emailInput) {
  const meter = el('div.pw-meter', { aria: { hidden: 'true' } }, el('span'), el('span'), el('span'), el('span'));
  fieldWrap.insertBefore(meter, fieldWrap.querySelector('.field-hint'));
  pwWrap.input.addEventListener('input', () => {
    const pw = pwWrap.input.value;
    let score = 0;
    if (pw.length >= 12) score++;
    if (pw.length >= 16) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    if (passwordProblems(pw, emailInput ? emailInput.value : '').length) score = Math.min(score, 1);
    meter.dataset.score = String(score);
  });
}

function applyFieldErrors(err, map) {
  if (err instanceof ValidationError && err.fields) {
    for (const [k, msg] of Object.entries(err.fields)) if (map[k]) map[k].setError(String(msg));
    return true;
  }
  return false;
}

// ---------------- Setup wizard ----------------
export async function renderSetup({ main }) {
  let step = 0;
  const data = { orgName: '', name: '', email: '', password: '' };

  function draw() {
    const steps = stepper([t('setup.stepClinic'), t('setup.stepAdmin'), t('setup.stepSecure')], step);
    if (step === 0) {
      const org = input({ autocomplete: 'organization', value: data.orgName });
      const f = field({ label: t('setup.orgName'), input: org, hint: t('setup.orgNameHint'), required: true });
      const form = el('form.form', { novalidate: true },
        f,
        el('div.form-actions', el('button.btn.btn-primary.btn-lg.btn-block', { type: 'submit' }, t('common.continue'), icon('chevronRight', { size: 18 }))));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!org.value.trim()) { f.setError(t('validation.required')); org.focus(); return; }
        data.orgName = org.value.trim(); step = 1; draw();
      });
      mount(main, authCard({ title: t('setup.title'), sub: t('setup.sub'), steps, children: [form] }));
      org.focus();
      return;
    }
    if (step === 1) {
      const name = input({ autocomplete: 'name', value: data.name });
      const email = input({ type: 'email', autocomplete: 'username', value: data.email, inputmode: 'email' });
      const pw = passwordInput();
      const pw2 = passwordInput();
      const fName = field({ label: t('setup.adminName'), input: name, required: true });
      const fEmail = field({ label: t('auth.email'), input: email, required: true });
      const fPw = field({ label: t('auth.password'), input: pw.input, control: pw, hint: t('auth.pw.hint'), required: true });
      const fPw2 = field({ label: t('auth.confirmPassword'), input: pw2.input, control: pw2, required: true });
      bindPwField(pw, fPw, email);
      const errBox = el('div.form-error-slot', { aria: { live: 'assertive' } });
      const submit = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'submit' }, t('setup.create'));
      const form = el('form.form', { novalidate: true }, fName, fEmail, fPw, fPw2, errBox,
        el('div.form-actions.form-actions-split',
          el('button.btn.btn-ghost', { type: 'button', onClick: () => { step = 0; draw(); } }, icon('arrowLeft', { size: 18 }), t('common.back')),
          submit));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        [fName, fEmail, fPw, fPw2].forEach((f) => f.setError(null)); errBox.textContent = '';
        let bad = null;
        if (!name.value.trim()) { fName.setError(t('validation.required')); bad = bad || name; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { fEmail.setError(t('validation.email')); bad = bad || email; }
        const probs = passwordProblems(pw.input.value, email.value);
        if (probs.length) { fPw.setError(probs.join(' ')); bad = bad || pw.input; }
        if (pw.input.value !== pw2.input.value) { fPw2.setError(t('validation.passwordMismatch')); bad = bad || pw2.input; }
        if (bad) { bad.focus(); return; }
        data.name = name.value.trim(); data.email = email.value.trim(); data.password = pw.input.value;
        setLoading(submit, true);
        try {
          await api.post('/setup', { org: { name: data.orgName }, admin: { email: data.email, name: data.name, password: data.password } }, { auth: false });
          step = 2; draw();
        } catch (err) {
          if (!applyFieldErrors(err, { email: fEmail, password: fPw, name: fName })) errBox.replaceChildren(alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] }));
        } finally { setLoading(submit, false); }
      });
      mount(main, authCard({ title: t('setup.adminTitle'), sub: t('setup.adminSub', { org: data.orgName }), steps, children: [form] }));
      name.focus();
      return;
    }
    // step 2: done → sign in
    const go = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', onClick: () => { data.password = ''; navigate(`/login?email=${encodeURIComponent(data.email)}`); } }, t('setup.signInNow'));
    mount(main, authCard({ title: t('setup.doneTitle'), sub: t('setup.doneSub'), steps,
      children: [alertBox({ tone: 'info', ic: 'shield', title: t('setup.mfaNextTitle'), children: [el('p', t('setup.mfaNext'))] }), el('div.form-actions', go)] }));
    go.focus();
  }
  draw();
  return null;
}

// ---------------- Login ----------------
export async function renderLogin({ main, query }) {
  let creds = null;
  const notice = takeNotice();

  function passwordStep() {
    const email = input({ type: 'email', autocomplete: 'username', inputmode: 'email', value: (creds && creds.email) || query.email || '' });
    const pw = passwordInput({ autocomplete: 'current-password' });
    const fEmail = field({ label: t('auth.email'), input: email, required: true });
    const fPw = field({ label: t('auth.password'), input: pw.input, control: pw, required: true });
    const errBox = el('div.form-error-slot', { aria: { live: 'assertive' } });
    const submit = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'submit' }, t('auth.signIn'));
    const form = el('form.form', { novalidate: true }, fEmail, fPw, errBox, el('div.form-actions', submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.textContent = '';
      fEmail.setError(null); fPw.setError(null);
      if (!email.value.trim()) { fEmail.setError(t('validation.required')); email.focus(); return; }
      if (!pw.input.value) { fPw.setError(t('validation.required')); pw.input.focus(); return; }
      creds = { email: email.value.trim(), password: pw.input.value };
      setLoading(submit, true);
      try {
        await api.post('/auth/login', creds, { auth: false });
        creds = null;
        await afterLogin(); goAfterLogin();
      } catch (err) {
        if (err instanceof MfaRequiredError) { totpStep(); return; }
        creds = null;
        errBox.replaceChildren(alertBox({ tone: 'danger', children: [el('p', err.status === 401 ? t('auth.invalid') : errorMessage(err))] }));
        pw.input.value = ''; pw.input.focus();
      } finally { if (submit.isConnected) setLoading(submit, false); }
    });
    mount(main, authCard({
      title: t('auth.signInTitle'), sub: t('auth.signInSub'),
      children: [notice ? alertBox({ tone: 'info', children: [el('p', notice)] }) : null, form, el('p.auth-foot', icon('lock', { size: 14 }), t('auth.secureNote'))],
    }));
    (email.value ? pw.input : email).focus();
  }

  function totpStep(recovery = false) {
    const code = input({
      autocomplete: 'one-time-code', inputmode: recovery ? 'text' : 'numeric', maxlength: recovery ? 24 : 6,
      pattern: recovery ? null : '[0-9]*', class: recovery ? 'input-code-recovery' : 'input-code', spellcheck: 'false',
    });
    const fCode = field({ label: recovery ? t('auth.recoveryCode') : t('auth.totpCode'), input: code, hint: recovery ? t('auth.recoveryHint') : t('auth.totpHint'), required: true });
    const errBox = el('div.form-error-slot', { aria: { live: 'assertive' } });
    const submit = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'submit' }, t('auth.verify'));
    const form = el('form.form', { novalidate: true }, fCode, errBox, el('div.form-actions', submit),
      el('div.auth-alt',
        el('button.link-btn', { type: 'button', onClick: () => totpStep(!recovery) }, recovery ? t('auth.useAuthenticator') : t('auth.useRecovery')),
        el('button.link-btn', { type: 'button', onClick: () => { creds = null; passwordStep(); } }, t('auth.startOver'))));
    if (!recovery) code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); if (code.value.length === 6) form.requestSubmit(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = code.value.trim();
      if (!recovery && !/^\d{6}$/.test(v)) { fCode.setError(t('validation.totp')); code.focus(); return; }
      if (!v) { fCode.setError(t('validation.required')); return; }
      setLoading(submit, true);
      try {
        await api.post('/auth/login', { ...creds, totp: v }, { auth: false });
        creds = null;
        await afterLogin(); goAfterLogin();
      } catch (err) {
        errBox.replaceChildren(alertBox({ tone: 'danger', children: [el('p', err.status === 401 ? t('auth.invalidCode') : errorMessage(err))] }));
        code.value = ''; code.focus();
      } finally { if (submit.isConnected) setLoading(submit, false); }
    });
    mount(main, authCard({ title: t('auth.mfaTitle'), sub: t('auth.mfaSub'), children: [el('div.auth-badge', icon('shield', { size: 28 })), form] }));
    code.focus();
  }

  passwordStep();
  return () => { creds = null; };
}

// ---------------- MFA enrollment ----------------
export async function renderMfaEnroll({ main }) {
  const forced = state.user && state.user.role === 'admin' && !state.user.mfaEnabled;
  if (state.user && state.user.mfaEnabled) {
    mount(main, authCard({ title: t('mfa.alreadyTitle'), sub: t('mfa.alreadySub'), children: [el('a.btn.btn-primary.btn-block', { href: '#/settings/profile' }, t('mfa.backToSettings'))] }));
    return null;
  }
  let setup;
  try { setup = await api.post('/auth/mfa/setup', {}); } catch (err) {
    mount(main, authCard({ title: t('mfa.title'), children: [alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })] }));
    return null;
  }
  const secretGrouped = (setup.secret || '').replace(/(.{4})/g, '$1 ').trim();
  const code = input({ autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, class: 'input-code' });
  const fCode = field({ label: t('auth.totpCode'), input: code, hint: t('mfa.codeHint'), required: true });
  const errBox = el('div.form-error-slot', { aria: { live: 'assertive' } });
  const submit = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'submit' }, t('mfa.verifyEnable'));
  const copyBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button' }, icon('copy', { size: 16 }), t('common.copy'));
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(setup.secret); toast(t('common.copied'), { tone: 'success' }); } catch { toast(t('common.copyFailed'), { tone: 'warn' }); }
  });
  let qr;
  try { qr = qrSvg(setup.otpauthUrl, { px: 208, label: t('mfa.qrLabel') }); } catch { qr = el('p', t('mfa.qrUnavailable')); }
  const form = el('form.form', { novalidate: true }, fCode, errBox, el('div.form-actions', submit));
  code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.value)) { fCode.setError(t('validation.totp')); code.focus(); return; }
    setLoading(submit, true);
    try {
      const res = await api.post('/auth/mfa/enable', { code: code.value });
      if (state.user) state.user.mfaEnabled = true;
      showRecovery(res.recoveryCodes || []);
    } catch (err) {
      errBox.replaceChildren(alertBox({ tone: 'danger', children: [el('p', err.status === 400 || err.status === 401 ? t('auth.invalidCode') : errorMessage(err))] }));
      code.value = ''; code.focus();
    } finally { if (submit.isConnected) setLoading(submit, false); }
  });

  mount(main, el('section.auth-card.auth-card-wide',
    stepper([t('mfa.stepScan'), t('mfa.stepVerify'), t('mfa.stepSave')], 0),
    el('h1.auth-title', { tabindex: '-1' }, t('mfa.title')),
    el('p.auth-sub', forced ? t('mfa.requiredAdmin') : t('mfa.sub')),
    el('div.mfa-grid',
      el('div.mfa-qr', qr),
      el('div.mfa-steps',
        el('ol.numbered',
          el('li', t('mfa.step1')),
          el('li', t('mfa.step2')),
          el('li', t('mfa.step3'))),
        el('div.secret-box',
          el('span.label', t('mfa.manualKey')),
          el('code.secret', { aria: { label: t('mfa.manualKey') } }, secretGrouped),
          copyBtn),
      )),
    form,
    forced ? el('p.auth-foot', el('button.link-btn', { type: 'button', onClick: () => signOut() }, t('auth.signOut'))) : el('p.auth-foot', el('a.link-btn', { href: '#/settings/profile' }, t('common.cancel'))),
  ));
  code.focus();

  function showRecovery(codes) {
    const ack = el('input', { type: 'checkbox', id: 'ack-codes' });
    const cont = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', disabled: true }, t('common.continue'));
    ack.addEventListener('change', () => { cont.disabled = !ack.checked; });
    cont.addEventListener('click', () => { goAfterLogin(); });
    const list = el('ol.recovery-codes', codes.map((c) => el('li', el('code', c))));
    const copy = el('button.btn.btn-secondary', { type: 'button' }, icon('copy', { size: 18 }), t('mfa.copyCodes'));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(codes.join('\n')); toast(t('common.copied'), { tone: 'success' }); } catch { toast(t('common.copyFailed'), { tone: 'warn' }); }
    });
    const print = el('button.btn.btn-secondary', { type: 'button' }, icon('print', { size: 18 }), t('common.print'));
    print.addEventListener('click', () => {
      document.body.classList.add('print-recovery');
      const done = () => { document.body.classList.remove('print-recovery'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
    });
    mount(main, el('section.auth-card.auth-card-wide.recovery-sheet',
      stepper([t('mfa.stepScan'), t('mfa.stepVerify'), t('mfa.stepSave')], 2),
      el('h1.auth-title', { tabindex: '-1' }, t('mfa.recoveryTitle')),
      el('p.auth-sub', t('mfa.recoverySub')),
      alertBox({ tone: 'warn', children: [el('p', t('mfa.recoveryWarn'))] }),
      el('div.recovery-print-head', el('strong', 'YOU HEAL Clinical'), el('span', state.user ? state.user.email : '')),
      list,
      el('div.btn-row', copy, print),
      el('label.check', ack, el('span', t('mfa.savedAck'))),
      el('div.form-actions', cont),
    ));
    main.querySelector('h1').focus();
  }
  return null;
}
