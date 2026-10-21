#!/usr/bin/env node
// End-to-end UI walkthrough with screenshots (Playwright + Chromium).
//   node tests/web/walkthrough.mjs                  # starts the mock server on a free port
//   BASE_URL=http://127.0.0.1:8080 node tests/web/walkthrough.mjs   # against a running backend (fresh data dir)
// Playwright is NOT a project dependency: set PLAYWRIGHT_MODULE or install it outside the repo.
// Screenshots + report.pdf → tests/artifacts/ (gitignored). Exits non-zero on console errors / CSP violations.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(ART, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright/index.mjs', '/tmp/claude-0/pw-web/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c.startsWith('/') ? pathToFileURL(c).href : c); } catch { /* next */ }
  }
  throw new Error('playwright not found — set PLAYWRIGHT_MODULE');
}

// ---- TOTP (RFC 6238) to answer the MFA enrollment like a phone would ----
function b32dec(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/[\s=]/g, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
// The server rejects re-use of a TOTP step, so each step-up waits for a fresh 30 s window.
let lastStep = 0;
async function freshTotp(secret) {
  while (Math.floor(Date.now() / 30000) <= lastStep) await new Promise((r) => setTimeout(r, 500));
  lastStep = Math.floor(Date.now() / 30000);
  return totp(secret);
}
function totp(secret, offset = 0) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(msg).digest(); const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Obviously fictitious demo identities only.
/** Runs in the page: creates obviously fictitious patients, intakes and backdated sessions through /api/v1. */
async function seedDemo(password) {
  const me = await (await fetch('/api/v1/auth/me')).json();
  const H = { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken };
  const j = async (m, u, b) => { const r = await fetch(`/api/v1${u}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const d = await r.json().catch(() => null); if (!r.ok) throw new Error(`${m} ${u} ${r.status} ${JSON.stringify(d)}`); return d; };
  const protoIds = async (id) => { const p = await j('GET', `/catalog/protocols/${id}`); return (p.pairs || []).map((x) => x.pairId); };
  const protos = (await j('GET', '/catalog/protocols?limit=5000')).items;
  const leg = protos.find((p) => p.kind === 'application') || protos[0];
  const gi = protos.find((p) => p.kind === 'top10' && /gastro/i.test(p.id)) || protos.find((p) => p.kind === 'top10') || protos[1];
  const legPairs = await protoIds(leg.id); const giPairs = await protoIds(gi.id);
  const contra = (await j('GET', '/catalog/contraindications?limit=500')).items;
  const abs = contra.find((c) => c.kind === 'absolute'); const rel = contra.find((c) => c.kind === 'relative');
  const day = (n, h = 10) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 15, 0, 0); return d.toISOString(); };
  const answers = { techniqueExplained: true, questionsAnswered: true, understandsScope: true, continuesMedical: true, authorizesPlacement: true, followUpInformed: true, reason: 'Demo record' };
  let count = 0;
  const patient = async (firstName, lastName, dob, sex, ci = { relative: [], absolute: [] }, extra = {}) => {
    const p = await j('POST', '/patients', { firstName, lastName, dob, sex, phone: '(555) 010-0000', email: `${firstName.toLowerCase()}@example.test`, ...extra });
    await j('POST', `/patients/${p.id}/consents`, { type: 'intake', answers, contraindications: ci, signatureName: `${firstName} ${lastName}`, signedAt: day(20) });
    return p;
  };
  const session = async (p, daysAgo, pairs, { protocolIds = [], chief, finalize = true, statuses = [] } = {}) => {
    const s = await j('POST', `/patients/${p.id}/sessions`, { methodology: 'biomagnetism', protocolIds, chiefComplaint: chief, symptoms: [], sessionDate: day(daysAgo, daysAgo ? 10 : Math.max(8, new Date().getHours() - 1)) });
    for (const [i, pid] of pairs.entries()) await j('POST', `/sessions/${s.id}/findings`, { pairId: pid, status: statuses[i] || 'found', dwellMinutes: 15, phenomena: i === 0 && daysAgo > 10 ? ['infiltrate'] : [] });
    if (finalize) await j('POST', `/sessions/${s.id}/finalize`, { signatureName: me.user.name, password });
    count++;
    return s.id;
  };
  const mary = await patient('Mary', 'Example', '1979-04-12', 'female', { relative: rel ? [rel.id] : [], absolute: [] });
  await session(mary, 14, legPairs.slice(0, 3), { protocolIds: [leg.id], chief: 'Heavy legs, evening ankle swelling', statuses: ['cleared', 'cleared', 'impacted'] });
  await session(mary, 7, [legPairs[0], legPairs[2], legPairs[5] || legPairs[1]].filter(Boolean), { protocolIds: [leg.id], chief: 'Follow-up: leg circulation', statuses: ['cleared', 'impacted', 'impacted'] });
  const john = await patient('John', 'Demo', '1964-09-30', 'male');
  await session(john, 1, giPairs.slice(0, 2), { protocolIds: [gi.id], chief: 'Gastritis, bloating after meals', finalize: false });
  await patient('Ana', 'Prueba', '1991-01-22', 'female', { relative: [], absolute: abs ? [abs.id] : [] });
  // prefers Spanish: his reports are signed in Spanish (reportLocale defaults to the patient's preferred language)
  const robert = await patient('Robert', 'Testcase', '1958-06-05', 'male', undefined, { preferredLanguage: 'es' });
  await session(robert, 35, legPairs.slice(4, 5), { chief: 'Dolor lumbar', statuses: ['cleared'] });
  const esReport = await session(robert, 0, legPairs.slice(4, 6), { chief: 'Dolor lumbar irradiado a la pierna derecha', statuses: ['impacted', 'cleared'] });
  return { count, esReport };
}

async function waitViewer(page) {
  // 3D mesh builds in a worker (~1 s, slower under SwiftShader); the 2D fallback is immediate.
  await page.waitForFunction(() => !document.querySelector('.viewer-loading') && !Array.from(document.querySelectorAll('.yh-viewer__loading')).some((n) => n.offsetParent !== null && !n.hidden), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
}

// ---- language leak check (CONTRACT §9.4) ----
// Every visible text node / aria-label / title / placeholder / alt is judged against the language of its nearest
// [lang] ancestor (the page is <html lang=ui>; Spanish-baseline fallbacks carry lang="es"; the report paper carries
// the report language). A node leaks when it is exactly a UI string of the other pack, or when it contains more
// function words of the other language than of its own. Fictitious user-entered data is excluded.
const PACKS = path.resolve(__dirname, '../../data/i18n/packs');
function packValues(locale) {
  const out = []; const walk = (o) => { for (const v of Object.values(o)) { if (v && typeof v === 'object') walk(v); else if (typeof v === 'string') out.push(v); } };
  walk(JSON.parse(fs.readFileSync(path.join(PACKS, locale, 'ui.json'), 'utf8'))); return out;
}
const UI_EN = packValues('en'); const UI_ES = packValues('es');
// single short words are skipped: many are cognates or catalog terms shared by both languages ("Temporal", "Prion")
const exclusive = (a, b) => { const sb = new Set(b); return [...new Set(a)].filter((v) => !sb.has(v) && !v.includes('{') && /\p{L}{3,}/u.test(v) && v.length < 80 && (/\s/.test(v.trim()) || v.length >= 10)); };
const ONLY_EN = exclusive(UI_EN, UI_ES); const ONLY_ES = exclusive(UI_ES, UI_EN);
const USER_TEXT = ['Heavy legs', 'Follow-up: leg circulation', 'Gastritis, bloating', 'Low-back pain', 'Dolor lumbar', 'night cramps', 'Demo record', 'Demo Clinic', 'Dr. Alex Demo', 'Jane Sample', 'Mary Example', 'John Demo', 'Ana Prueba', 'Robert Testcase', 'example.test', 'clinic.test'];
async function checkLeaks(page, label, problems) {
  const flags = await page.evaluate(({ onlyEn, onlyEs, user }) => {
    const EN = new Set(['the', 'and', 'with', 'of', 'for', 'your', 'this', 'that', 'from', 'are', 'is', 'was', 'will', 'been', 'have', 'has', 'to', 'on', 'at', 'by', 'after', 'before', 'into', 'than', 'you', 'or', 'be', 'it', 'its', 'which', 'there', 'were', 'not', 'yet']);
    const ES = new Set(['el', 'la', 'los', 'las', 'del', 'de', 'con', 'para', 'por', 'una', 'unos', 'unas', 'que', 'es', 'en', 'se', 'su', 'sus', 'al', 'más', 'sin', 'pero', 'como', 'este', 'esta', 'son', 'está', 'les', 'ya']);
    const sets = { en: new Set(onlyEn), es: new Set(onlyEs) };
    const out = [];
    const where = (el) => { const parts = []; for (let n = el; n && n !== document.body && parts.length < 3; n = n.parentElement) parts.unshift(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '')); return parts.join(' > '); };
    const judge = (text, el, kind) => {
      const tx = text.replace(/YOU HEAL/g, ' ').replace(/\s+/g, ' ').trim(); if (!tx || !/\p{L}{2,}/u.test(tx) || /^[A-Z]{2,3}$/.test(tx)) return; // locale codes / abbreviations
      if (user.some((u) => tx.includes(u))) return;
      const lang = ((el.closest('[lang]') || document.documentElement).getAttribute('lang') || 'en').slice(0, 2);
      const other = lang === 'es' ? 'en' : 'es';
      const words = tx.toLowerCase().match(/\p{L}+/gu) || [];
      const own = words.filter((w) => (lang === 'es' ? ES : EN).has(w)).length;
      const foreign = words.filter((w) => (lang === 'es' ? EN : ES).has(w)).length;
      if (sets[other].has(tx) || (foreign && foreign > own)) out.push(`${kind} [lang=${lang}] "${tx.slice(0, 90)}" @ ${where(el)}`);
    };
    const skip = (el) => el.closest('script, style, noscript, code, kbd, .mono, .badge-es, [data-leak-ok], .lp-src-text, .lp-key, textarea, .toast');
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { const el = n.parentElement; if (el && !skip(el)) judge(n.nodeValue, el, 'text'); }
    for (const el of document.body.querySelectorAll('[aria-label], [title], [placeholder], img[alt]')) {
      if (skip(el)) continue;
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) if (el.hasAttribute(a)) judge(el.getAttribute(a), el, a);
    }
    return [...new Set(out)].slice(0, 25);
  }, { onlyEn: ONLY_EN, onlyEs: ONLY_ES, user: USER_TEXT });
  for (const f of flags) problems.push(`[${label}] language leak: ${f}`);
  console.log(`  🔤 ${label}: ${flags.length ? `${flags.length} leak(s)` : 'no language leaks'}`);
}

const ADMIN = { org: 'YOU HEAL Demo Clinic', name: 'Dr. Alex Demo', email: 'admin@clinic.test', password: 'Magnets-align-at-528hz' };
const PATIENT = { first: 'Jane', last: 'Sample', dob: '1980-01-01' };

async function main() {
  const { chromium } = await loadPlaywright();
  let base = process.env.BASE_URL;
  let child = null;
  if (!base) {
    const port = 4300 + Math.floor(Math.random() * 500);
    child = spawn(process.execPath, [path.join(__dirname, 'mock-server.mjs'), '--port', String(port), '--latency', '20', '--legacy-recovery'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    await new Promise((r) => child.stdout.on('data', (d) => { out += String(d); if (out.includes('mock on')) r(); }));
    const m = /setup token: (\S+)/.exec(out); if (m) process.env.SETUP_TOKEN = m[1];
    base = `http://127.0.0.1:${port}`;
  }
  const problems = problems_;
  let mfaSecret = null;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const shot = async (page, name, opts = {}) => { if (!opts.toasts) await page.locator('.toast').evaluateAll((ts) => ts.forEach((n) => n.remove())).catch(() => {}); await page.waitForTimeout(opts.wait ?? 250); await page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: !!opts.full }); console.log('  📸', name); };

  async function newPage(viewport, label) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT || 15000));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()} ${m.location() && m.location().url ? '@ ' + m.location().url : ''}`); });
    // the anatomical MakeHuman body must load — a procedural-mannequin fallback frame is a failure
    page.on('console', (m) => { if (/procedural mannequin|body asset unavailable/i.test(m.text())) problems.push(`[${label}] viewer fell back to the procedural body: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
    return { ctx, page };
  }

  // ================================================================ desktop flow
  console.log('Desktop 1440×900 —', base);
  const { ctx, page } = await newPage({ width: 1440, height: 900 }, 'desktop');
  globalThis.__page = page;
  await page.goto(`${base}/`);

  // 1. setup wizard (hardened servers ask for the one-time setup token from the log / data folder)
  await page.getByLabel('Clinic name').waitFor();
  if (await page.getByLabel(/^Setup token/).count()) {
    const token = process.env.SETUP_TOKEN || (process.env.SETUP_TOKEN_FILE && fs.existsSync(process.env.SETUP_TOKEN_FILE) ? fs.readFileSync(process.env.SETUP_TOKEN_FILE, 'utf8').trim() : '');
    await page.getByLabel(/^Setup token/).fill(token);
  }
  await page.getByLabel('Clinic name').fill(ADMIN.org);
  await shot(page, '01-setup-clinic');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Full name').fill(ADMIN.name);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel(/^Password/).fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await shot(page, '02-setup-admin');
  await page.getByRole('button', { name: 'Create clinic' }).click();
  await page.getByRole('heading', { name: 'Your clinic is ready' }).waitFor();
  await page.getByRole('button', { name: 'Sign in' }).click();

  // 2. login
  await page.getByLabel(/^Password/).fill(ADMIN.password);
  await shot(page, '03-login');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // 3. MFA enrollment (admins must enroll) — unless the server runs with MFA disabled for dev
  const mfa = await page.getByRole('heading', { name: 'Set up two-step verification' }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  if (mfa) {
    await page.locator('svg.qr').waitFor();
    await shot(page, '04-mfa-enroll');
    mfaSecret = (await page.locator('code.secret').textContent()).replace(/\s/g, '');
    await page.getByLabel('Authentication code').fill(await freshTotp(mfaSecret));
    await page.getByRole('button', { name: 'Verify and turn on' }).click();
    await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
    await shot(page, '05-mfa-recovery');
    await page.getByLabel('I have saved my recovery codes in a safe place.').check();
    await page.getByRole('button', { name: 'Continue' }).click();
  }

  // 4. dashboard (optionally seed fictitious demo records through the public API first)
  let esReportId = null;
  if (process.env.SEED === '1') { const r = await page.evaluate(seedDemo, ADMIN.password); esReportId = r.esReport; console.log(`  🌱 seeded ${r.count} demo sessions via API`); await page.reload(); }
  await page.locator('.dash-grid .card').first().waitFor();
  await shot(page, '06-dashboard');

  // 4a. recovery codes: banner for legacy-format codes (mock flags the user) → Settings → regenerate (password + fresh TOTP)
  if (mfaSecret) {
    const banner = page.locator('#shell-banner:not([hidden]) .shell-banner-inner');
    const hasBanner = await banner.waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
    if (hasBanner) {
      await shot(page, '34a-recovery-banner');
      await banner.getByRole('link', { name: 'Regenerate now' }).click();
    } else {
      await page.goto(`${base}/#/settings/profile?focus=recovery`);
    }
    await page.locator('#regen-recovery').click();
    const rd = page.locator('dialog[open]');
    await rd.getByLabel('Password', { exact: false }).first().fill(ADMIN.password);
    await rd.getByLabel('Authentication code').fill(await freshTotp(mfaSecret));
    await rd.getByRole('button', { name: 'Generate new codes' }).click();
    const codesDlg = page.locator('dialog[open]', { has: page.locator('.recovery-codes') });
    await codesDlg.waitFor();
    if (await codesDlg.getByRole('button', { name: 'Done' }).isEnabled()) problems.push('[desktop] recovery codes: Done must stay disabled until acknowledged');
    await shot(page, '34-recovery-regenerate');
    await codesDlg.getByLabel('I have saved my recovery codes in a safe place.').check();
    await codesDlg.getByRole('button', { name: 'Done' }).click();
    await page.getByText('New recovery codes are active').waitFor();
    if (await page.locator('#shell-banner:not([hidden]) .shell-banner-inner').count()) problems.push('[desktop] recovery banner still shown after regeneration');
    await page.goto(`${base}/#/`);
    await page.locator('.dash-grid .card').first().waitFor();
  }

  // 4b. clinic logo (generated in-page: an obviously fictitious "Demo Clinic" mark) → sidebar + report header
  await page.goto(`${base}/#/settings/clinic`);
  await page.locator('#logo-file').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 240; const g = c.getContext('2d');
    g.fillStyle = '#0F4C55'; g.beginPath(); g.roundRect(0, 0, 240, 240, 48); g.fill();
    g.strokeStyle = '#D4AF6A'; g.lineWidth = 6; for (const r of [70, 50, 30]) { g.beginPath(); g.ellipse(120, 112, r * 1.25, r, 0, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = '#F1ECE2'; g.font = '700 46px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('DEMO', 120, 205);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'demo-logo.png', { type: 'image/png' }));
    const input = document.getElementById('logo-file'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('.logo-preview img').waitFor();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Clinic profile saved').waitFor();
  await page.locator('.side-org-logo img').waitFor();
  await page.goto(`${base}/#/`);
  await page.locator('.dash-grid .card').first().waitFor();
  await page.locator('.side-org-logo img').waitFor();
  await page.locator('.toast-close').evaluateAll((bs) => bs.forEach((b) => b.click()));
  await shot(page, '06-dashboard', { wait: 400 }); // re-shot with the clinic logo in the sidebar
  await checkLeaks(page, 'en dashboard', problems);

  // 5. create patient
  await page.getByRole('link', { name: 'New patient' }).first().click();
  await page.getByLabel('First name').fill(PATIENT.first);
  await page.getByLabel('Last name').fill(PATIENT.last);
  await page.getByLabel('Date of birth').fill(PATIENT.dob);
  await page.getByLabel('Sex').selectOption('female');
  await page.getByLabel('Phone').fill('(718) 555-0199');
  if (!(await page.getByLabel('Preferred language').count())) problems.push('[desktop] patient form: no Preferred language select');
  await shot(page, '07-patient-form');
  await page.getByRole('button', { name: 'Create patient' }).click();

  // 6. intake & consent (Hoja de Registro)
  await page.getByRole('heading', { name: 'Explanation of the technique' }).waitFor();
  await page.getByLabel('Reason for consultation').fill('Heavy legs and night cramps for 3 months');
  await page.getByLabel('The technique, its scope and its limitations were explained to the patient.').check();
  await page.getByLabel('The patient had the opportunity to ask questions and they were answered.').check();
  for (const fs2 of await page.locator('fieldset.yn').all()) await fs2.getByLabel('Yes', { exact: true }).check();
  await page.locator('.contra-group.is-relative label').first().click();
  await page.getByLabel('Full name of patient or legal guardian').fill(`${PATIENT.first} ${PATIENT.last}`);
  await page.getByLabel('The patient (or legal guardian) read and signed the authorization for treatment.').check();
  await shot(page, '08-intake', { full: true });
  await page.getByRole('button', { name: 'Save intake & consent' }).click();
  await page.getByText('Intake and consent saved').waitFor();

  // 7. start scan
  await page.getByRole('button', { name: 'Start scan' }).first().click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Chief complaint').fill('Heavy legs, evening ankle swelling');
  await dlg.getByRole('combobox', { name: 'Protocols to run' }).fill('leg');
  await dlg.locator('.combo-option').first().click();
  await shot(page, '09-start-scan');
  await dlg.getByRole('button', { name: 'Begin scan' }).click();

  // 8. workspace
  await page.locator('.scan-bar').waitFor();
  await page.locator('.ck-item').first().waitFor();
  await waitViewer(page);
  await shot(page, '10-scan-workspace');
  await page.locator('.ck-item.is-current').focus();
  await page.keyboard.press('f'); await page.waitForTimeout(200);
  await page.keyboard.press('j'); await page.keyboard.press('n');
  await page.keyboard.press('i'); await page.waitForTimeout(200);
  await page.keyboard.press('j'); await page.keyboard.press('f');
  await page.waitForTimeout(600);
  await shot(page, '11-scan-findings');
  await checkLeaks(page, 'en scan', problems);
  // point via the accessible point list fallback
  await page.getByRole('button', { name: 'Point list' }).click();
  await page.locator('.point-list .pl-btn').filter({ hasText: /Liver|Hígado/ }).first().click();
  await page.locator('.point-drawer .pa-toggle').first().waitFor();
  await page.locator('.point-drawer .pa-panel:not([hidden]) .pair-detail, .point-drawer .pa-toggle').first().waitFor();
  const expanded = await page.locator('.point-drawer .pa-toggle[aria-expanded="true"]').count();
  if (!expanded) await page.locator('.point-drawer .pa-toggle').first().click();
  await page.locator('.point-drawer .pair-detail').first().waitFor();
  await page.locator('.stage-toolbar .seg', { hasText: 'Back' }).click(); // reset the camera framing (list picks zoom in)
  await page.locator('.stage-toolbar .seg', { hasText: 'Front' }).click();
  await page.waitForTimeout(1800); // let the camera animation settle
  await shot(page, '12-point-drawer');
  const drawerBadges = await page.locator('.point-drawer .badge-es').count();
  console.log(`  🏷  EN point drawer ES badges: ${drawerBadges}`);
  const markBtn = page.locator('.point-drawer .pa-actions .btn-primary').first();
  if (await markBtn.isEnabled()) await markBtn.click();
  await page.keyboard.press('Escape');
  // directed scan
  await page.getByRole('tab', { name: 'Directed' }).click();
  const symBox = page.getByRole('combobox', { name: 'Reported symptoms' });
  await symBox.fill('fatig'); await page.locator('.directed-panel .combo-option').first().click();
  await symBox.fill('head'); await page.locator('.directed-panel .combo-option').first().click().catch(() => {});
  await page.getByRole('button', { name: 'Suggest pairs' }).click();
  await page.locator('.suggest-item').first().waitFor();
  await shot(page, '13-directed-scan');
  // finding details
  await page.locator('.finding-expand').first().click();
  await page.locator('.finding-details .chip-toggle', { hasText: 'Infiltrate' }).click();
  await page.waitForTimeout(800);
  await shot(page, '14-finding-details');
  // reload: checklist marks, cursor and directed input come back from the draft's scanState
  await page.waitForFunction(() => document.querySelector('.save-status')?.dataset.state === 'saved', null, { timeout: 15000 });
  await page.waitForTimeout(1600); // scanState debounce (~1 s) + save
  await page.waitForFunction(() => document.querySelector('.save-status')?.dataset.state === 'saved', null, { timeout: 15000 });
  await page.reload();
  await page.locator('.ck-item').first().waitFor();
  await waitViewer(page);
  const restoredMarks = await page.locator('.ck-item.state-not-present').count();
  if (!restoredMarks) problems.push('[desktop] scanState: not-present mark was not restored after reload');
  await page.getByRole('tab', { name: 'Directed' }).click();
  await page.getByRole('tab', { name: 'Protocol' }).click();
  await shot(page, '14b-scan-state-restored');

  // 9. finalize & sign
  await page.locator('.scan-bar').getByRole('button', { name: 'Finalize & sign' }).click();
  const fin = page.locator('dialog[open]');
  await fin.locator('#attest').check();
  await fin.getByLabel('Confirm with your password').fill(ADMIN.password);
  if (!(await fin.getByLabel('Report language').count())) problems.push('[desktop] finalize: no Report language select');
  await shot(page, '15-finalize');
  await fin.getByRole('button', { name: 'Sign and finalize' }).click();

  // 10. report
  await page.locator('article.report[data-ready="true"]').waitFor({ timeout: 30000 });
  await shot(page, '16-report', { full: true });
  await page.emulateMedia({ media: 'print' });
  await shot(page, '17-report-print', { full: true });
  await page.pdf({ path: path.join(ART, 'report.pdf'), format: 'Letter', preferCSSPageSize: true, printBackground: true });
  console.log('  📄 report.pdf');
  await page.emulateMedia({ media: 'screen' });
  await checkLeaks(page, 'en report', problems);
  const reportUrl = page.url();
  // the signed report shown in the other language is marked as a translation (paper + screen notice)
  await page.locator('.report-lang .seg', { hasText: 'ES' }).click();
  await page.locator('article.report[lang="es"][data-ready="true"] .rpt-translation').waitFor({ timeout: 30000 });
  await shot(page, '16b-report-translation', { full: true });
  await checkLeaks(page, 'en ui / es report', problems);
  await page.locator('.report-lang .seg', { hasText: 'EN' }).click();
  await page.locator('article.report[lang="en"][data-ready="true"]').waitFor({ timeout: 30000 });
  if (await page.locator('.rpt-translation').count()) problems.push('[desktop] report: translation notice shown for the signed language');

  // 11. other views (demo data seeded by the mock)
  await page.goto(`${base}/#/patients`);
  await page.getByLabel('Last name or MRN').fill('Example');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('.results-count', { hasText: 'Example' }).waitFor();
  if ((await page.evaluate(() => location.href)).includes('Example')) problems.push('[desktop] patient search term leaked into the URL');
  await shot(page, '18-patients');
  await page.locator('tbody tr').first().click();
  await page.getByRole('tab', { name: /Sessions/ }).click();
  await page.locator('.trend-table').waitFor({ timeout: 8000 }).catch(() => {});
  await shot(page, '19-chart-trend');
  await page.goto(`${base}/#/catalog/pairs`);
  await page.locator('tbody tr').first().waitFor();
  await shot(page, '20-catalog-pairs');
  await page.locator('tbody tr').first().click();
  await page.locator('dialog[open] .pair-detail').waitFor();
  await shot(page, '21-catalog-pair-sheet');
  await checkLeaks(page, 'en pair sheet', problems);
  await page.keyboard.press('Escape');
  await page.goto(`${base}/#/catalog/protocols?open=app-19-circulacion-de-piernas`);
  await page.locator('.proto-pairs').waitFor();
  await shot(page, '22a-catalog-protocols');
  await page.getByRole('link', { name: 'Protocol card' }).click();
  await page.locator('.pc-img img').first().waitFor({ timeout: 20000 }).catch(() => {});
  await shot(page, '22-protocol-card');
  await page.goto(`${base}/#/settings/audit`);
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await page.locator('.alert-success, .alert-danger').first().waitFor();
  await shot(page, '23-audit');
  await page.goto(`${base}/#/settings/clinic`);
  await page.locator('#pol-neg').waitFor();
  await shot(page, '24-settings-clinic');
  // Settings → Language packs: coverage, review list, inline edit (override) + revert
  await page.goto(`${base}/#/settings/languages`);
  await page.locator('.lp-card').first().waitFor();
  await page.locator('.lp-row, .lp-list .empty').first().waitFor({ timeout: 20000 }).catch(() => {});
  const lpRow = page.locator('.lp-row').first();
  if (await lpRow.count()) {
    const key = await lpRow.getAttribute('data-key');
    const ta = lpRow.locator('textarea');
    const cur = (await ta.inputValue()) || 'Reviewed translation';
    await ta.fill(cur.trim());
    await lpRow.getByRole('button', { name: 'Save translation' }).click();
    await page.getByText('Translation saved').waitFor();
    // the saved key is now an override: find it again (it may have left a status-filtered list) and revert
    await page.locator('#lp-status').selectOption('reviewed');
    const edited = page.locator(`.lp-row[data-key="${key}"]`);
    await edited.waitFor({ timeout: 10000 });
    await shot(page, '28-language-packs');
    await checkLeaks(page, 'en language packs', problems);
    await edited.getByRole('button', { name: 'Revert to pack' }).click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Revert to pack' }).click();
    await page.getByText('Reverted to the pack translation').waitFor();
  } else {
    await shot(page, '28-language-packs');
  }
  // dark mode
  await page.goto(`${base}/#/`);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.dash-grid .card').first().waitFor();
  await shot(page, '25-dashboard-dark');
  const sessionUrl = await (async () => { await page.goto(`${base}/#/`); await page.locator('.list-row-link').first().waitFor(); return page.locator('.list-row-link[href^="#/sessions/"]:not([href$="/report"])').first().getAttribute('href'); })();
  if (sessionUrl) { await page.goto(`${base}/${sessionUrl}`); await page.locator('.scan-bar').waitFor(); await waitViewer(page); await shot(page, '26-scan-dark'); }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // ================================================================ Spanish pass (UI language = es)
  console.log('Spanish (es)');
  await page.goto(`${base}/#/`);
  await page.locator('.dash-grid .card').first().waitFor();
  await page.locator('.side-prefs .seg', { hasText: 'ES' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'es');
  await page.locator('.dash-grid .card').first().waitFor();
  await shot(page, '40-es-dashboard');
  await checkLeaks(page, 'es dashboard', problems);
  if (sessionUrl) {
    await page.goto(`${base}/${sessionUrl}`);
    await page.locator('.scan-bar').waitFor(); await page.locator('.ck-item').first().waitFor(); await waitViewer(page);
    await shot(page, '41-es-scan');
    await checkLeaks(page, 'es scan', problems);
    await page.getByRole('button', { name: 'Lista de puntos' }).click();
    await page.locator('.point-list .pl-btn').filter({ hasText: /Hígado/ }).first().click();
    await page.locator('.point-drawer .pa-toggle').first().waitFor();
    if (!(await page.locator('.point-drawer .pa-toggle[aria-expanded="true"]').count())) await page.locator('.point-drawer .pa-toggle').first().click();
    await page.locator('.point-drawer .pair-detail').first().waitFor();
    await page.locator('.stage-toolbar .seg').nth(1).click(); await page.locator('.stage-toolbar .seg').nth(0).click();
    await page.waitForTimeout(1800);
    await shot(page, '42-es-point-drawer');
    await checkLeaks(page, 'es point drawer', problems);
    await page.keyboard.press('Escape');
  }
  await page.goto(`${base}/#/catalog/pairs`);
  await page.locator('tbody tr').first().waitFor();
  await page.waitForTimeout(400);
  await shot(page, '27-catalog-es');
  await checkLeaks(page, 'es catalog', problems);
  await page.locator('tbody tr').first().click();
  await page.locator('dialog[open] .pair-detail').waitFor();
  await shot(page, '43-es-pair-detail');
  await checkLeaks(page, 'es pair detail', problems);
  await page.keyboard.press('Escape');
  await page.goto(`${base}/#/catalog/protocols/app-19-circulacion-de-piernas/card`);
  await page.locator('.pc-img img').first().waitFor({ timeout: 20000 }).catch(() => {});
  await shot(page, '44-es-protocol-card');
  await checkLeaks(page, 'es protocol card', problems);
  // the report signed in English, viewed in a Spanish UI: defaults to the signed language; switch to Spanish → translation
  await page.goto(reportUrl);
  await page.locator('article.report[data-ready="true"]').waitFor({ timeout: 30000 });
  await checkLeaks(page, 'es ui / en report', problems);
  await page.locator('.report-lang .seg', { hasText: 'ES' }).click();
  await page.locator('article.report[lang="es"][data-ready="true"] .rpt-translation').waitFor({ timeout: 30000 });
  await shot(page, '45-es-report', { full: true });
  await checkLeaks(page, 'es report', problems);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: path.join(ART, 'report-es-translation.pdf'), format: 'Letter', preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  console.log('  📄 report-es-translation.pdf');
  // a report signed in Spanish (patient prefers Spanish): no translation notice
  if (esReportId) {
    await page.goto(`${base}/#/sessions/${esReportId}/report`);
    await page.locator('article.report[lang="es"][data-ready="true"]').waitFor({ timeout: 30000 });
    if (await page.locator('.rpt-translation').count()) problems.push('[desktop] Spanish-signed report shows a translation notice');
    await shot(page, '47-es-report-signed', { full: true });
    await checkLeaks(page, 'es signed report', problems);
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: path.join(ART, 'report-es.pdf'), format: 'Letter', preferCSSPageSize: true, printBackground: true });
    await page.emulateMedia({ media: 'screen' });
    console.log('  📄 report-es.pdf');
  }
  await page.goto(`${base}/#/settings/languages`);
  await page.locator('.lp-card').first().waitFor();
  await page.waitForTimeout(600);
  await shot(page, '46-es-language-packs');
  await checkLeaks(page, 'es language packs', problems);
  // back to English (the preference is saved on the account, so the tablet session follows it)
  await page.locator('.side-prefs .seg', { hasText: 'EN' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.waitForTimeout(500);
  const storageCookies = await ctx.storageState();

  // ================================================================ tablet 1024×768
  console.log('Tablet 1024×768');
  const tctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, storageState: storageCookies, hasTouch: true });
  const tpage = await tctx.newPage();
  tpage.on('console', (m) => { if (m.type() === 'error') problems.push(`[tablet] console: ${m.text()}`); });
  tpage.on('pageerror', (e) => problems.push(`[tablet] pageerror: ${e.message}`));
  tpage.on('console', (m) => { if (/procedural mannequin|body asset unavailable/i.test(m.text())) problems.push(`[tablet] viewer fell back to the procedural body: ${m.text()}`); });
  await tpage.goto(`${base}/#/`);
  await tpage.locator('.dash-grid .card').first().waitFor();
  await shot(tpage, '30-tablet-dashboard');
  if (sessionUrl) {
    await tpage.goto(`${base}/${sessionUrl}`);
    await tpage.locator('.scan-bar').waitFor(); await waitViewer(tpage);
    await shot(tpage, '31-tablet-scan');
    await tpage.getByRole('button', { name: 'Protocol runner' }).first().click();
    await shot(tpage, '32-tablet-scan-protocol');
  }
  await tpage.goto(`${base}/#/patients`);
  await tpage.locator('tbody tr').first().waitFor();
  await shot(tpage, '33-tablet-patients');

  await browser.close();
  if (child) child.kill();
  const filtered = problems.filter((p) => !/favicon/.test(p));
  console.log(filtered.length ? `\n${filtered.length} problem(s):\n${filtered.join('\n')}` : '\nNo console errors, page errors or CSP violations.');
  process.exit(filtered.length ? 1 : 0);
}

const problems_ = [];
main().catch(async (e) => { console.error(e); try { console.error('URL:', globalThis.__page.url()); await globalThis.__page.screenshot({ path: path.join(ART, 'zz-failure.png') }); } catch { /* ignore */ } console.error(problems_.join('\n')); process.exit(2); });
