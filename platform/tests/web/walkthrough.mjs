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
function totp(secret, offset = 0) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(msg).digest(); const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Obviously fictitious demo identities only.
const ADMIN = { org: 'YOU HEAL Demo Clinic', name: 'Dr. Alex Demo', email: 'admin@clinic.test', password: 'Magnets-align-at-528hz' };
const PATIENT = { first: 'Jane', last: 'Sample', dob: '1980-01-01' };

async function main() {
  const { chromium } = await loadPlaywright();
  let base = process.env.BASE_URL;
  let child = null;
  if (!base) {
    const port = 4300 + Math.floor(Math.random() * 500);
    child = spawn(process.execPath, [path.join(__dirname, 'mock-server.mjs'), '--port', String(port), '--latency', '20'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => child.stdout.on('data', (d) => { if (String(d).includes('mock on')) r(); }));
    base = `http://127.0.0.1:${port}`;
  }
  const problems = problems_;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const shot = async (page, name, opts = {}) => { await page.waitForTimeout(opts.wait ?? 250); await page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: !!opts.full }); console.log('  📸', name); };

  async function newPage(viewport, label) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT || 15000));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()} ${m.location() && m.location().url ? '@ ' + m.location().url : ''}`); });
    page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
    return { ctx, page };
  }

  // ================================================================ desktop flow
  console.log('Desktop 1440×900 —', base);
  const { ctx, page } = await newPage({ width: 1440, height: 900 }, 'desktop');
  globalThis.__page = page;
  await page.goto(`${base}/`);

  // 1. setup wizard
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
    const secret = (await page.locator('code.secret').textContent()).replace(/\s/g, '');
    await page.getByLabel('Authentication code').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify and turn on' }).click();
    await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
    await shot(page, '05-mfa-recovery');
    await page.getByLabel('I have saved my recovery codes in a safe place.').check();
    await page.getByRole('button', { name: 'Continue' }).click();
  }

  // 4. dashboard
  await page.locator('.dash-grid .card').first().waitFor();
  await shot(page, '06-dashboard');

  // 5. create patient
  await page.getByRole('link', { name: 'New patient' }).first().click();
  await page.getByLabel('First name').fill(PATIENT.first);
  await page.getByLabel('Last name').fill(PATIENT.last);
  await page.getByLabel('Date of birth').fill(PATIENT.dob);
  await page.getByLabel('Sex').selectOption('female');
  await page.getByLabel('Phone').fill('(718) 555-0199');
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
  await page.waitForTimeout(2500); // let the 3D viewer settle
  await shot(page, '10-scan-workspace');
  await page.locator('.ck-item.is-current').focus();
  await page.keyboard.press('f'); await page.waitForTimeout(200);
  await page.keyboard.press('j'); await page.keyboard.press('n');
  await page.keyboard.press('i'); await page.waitForTimeout(200);
  await page.keyboard.press('j'); await page.keyboard.press('f');
  await page.waitForTimeout(600);
  await shot(page, '11-scan-findings');
  // point via the accessible point list fallback
  await page.getByRole('button', { name: 'Point list' }).click();
  await page.locator('.point-list .pl-btn').filter({ hasText: /Liver|Hígado/ }).first().click();
  await page.locator('.point-drawer .pa-toggle').first().waitFor();
  await page.locator('.point-drawer .pa-panel:not([hidden]) .pair-detail, .point-drawer .pa-toggle').first().waitFor();
  const expanded = await page.locator('.point-drawer .pa-toggle[aria-expanded="true"]').count();
  if (!expanded) await page.locator('.point-drawer .pa-toggle').first().click();
  await page.locator('.point-drawer .pair-detail').first().waitFor();
  await shot(page, '12-point-drawer');
  const markBtn = page.locator('.point-drawer .pa-actions .btn-primary').first();
  if (await markBtn.isEnabled()) await markBtn.click();
  await page.keyboard.press('Escape');
  // directed scan
  await page.getByRole('tab', { name: 'Directed' }).click();
  const symBox = page.getByRole('combobox', { name: 'Reported symptoms' });
  await symBox.fill('cramp'); await page.locator('.directed-panel .combo-option').first().click();
  await symBox.fill('heavy'); await page.locator('.directed-panel .combo-option').first().click().catch(() => {});
  await page.getByRole('button', { name: 'Suggest pairs' }).click();
  await page.locator('.suggest-item').first().waitFor();
  await shot(page, '13-directed-scan');
  // finding details
  await page.locator('.finding-expand').first().click();
  await page.locator('.finding-details .chip-toggle', { hasText: 'Infiltrate' }).click();
  await page.waitForTimeout(800);
  await shot(page, '14-finding-details');

  // 9. finalize & sign
  await page.locator('.scan-bar').getByRole('button', { name: 'Finalize & sign' }).click();
  const fin = page.locator('dialog[open]');
  await fin.locator('#attest').check();
  await fin.getByLabel('Type your full name to sign').fill(ADMIN.name);
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

  // 11. other views (demo data seeded by the mock)
  await page.goto(`${base}/#/patients?q=Gonz%C3%A1lez`);
  await page.locator('tbody tr').first().waitFor();
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
  await page.keyboard.press('Escape');
  await page.goto(`${base}/#/catalog/protocols`);
  await page.locator('.proto-item').first().click();
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
  // dark mode
  await page.goto(`${base}/#/`);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.dash-grid .card').first().waitFor();
  await shot(page, '25-dashboard-dark');
  const sessionUrl = await (async () => { await page.goto(`${base}/#/`); await page.locator('.list-row-link').first().waitFor(); return page.locator('.list-row-link[href^="#/sessions/"]:not([href$="/report"])').first().getAttribute('href'); })();
  if (sessionUrl) { await page.goto(`${base}/${sessionUrl}`); await page.locator('.scan-bar').waitFor(); await page.waitForTimeout(2000); await shot(page, '26-scan-dark'); }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // Spanish
  await page.goto(`${base}/#/catalog/pairs`);
  await page.locator('.side-prefs .seg', { hasText: 'ES' }).click();
  await page.locator('tbody tr').first().waitFor();
  await page.waitForTimeout(400);
  await shot(page, '27-catalog-es');
  await page.locator('.side-prefs .seg', { hasText: 'EN' }).click();
  const storageCookies = await ctx.storageState();

  // ================================================================ tablet 1024×768
  console.log('Tablet 1024×768');
  const tctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, storageState: storageCookies, hasTouch: true });
  const tpage = await tctx.newPage();
  tpage.on('console', (m) => { if (m.type() === 'error') problems.push(`[tablet] console: ${m.text()}`); });
  tpage.on('pageerror', (e) => problems.push(`[tablet] pageerror: ${e.message}`));
  await tpage.goto(`${base}/#/`);
  await tpage.locator('.dash-grid .card').first().waitFor();
  await shot(tpage, '30-tablet-dashboard');
  if (sessionUrl) {
    await tpage.goto(`${base}/${sessionUrl}`);
    await tpage.locator('.scan-bar').waitFor(); await tpage.waitForTimeout(2000);
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
