#!/usr/bin/env node
// YOU HEAL Clinical — iPad / tablet test launcher (TEST DATA ONLY — never point it at real patient data).
//
//   node tools/ipad-test.mjs [--mode lan|tailscale|codespaces] [--port 8443] [--data <dir>] [--no-demo] [--reset]
//
// lan (default): serves HTTPS on this computer's Wi-Fi/LAN address with a private test CA. The iPad installs
//   and trusts the CA once (the launcher serves it at http://<ip>:8099/ for 15 minutes), then browses
//   https://<ip>:<port>. Needs `openssl` (built into macOS/Linux; on Windows it ships with Git for Windows).
// codespaces: for GitHub Codespaces (no computer needed — start it from Safari on iPad/iPhone): binds loopback and
//   trusts GitHub's HTTPS port-forwarding proxy; demo credentials are written to <data>/DEMO-CREDENTIALS.txt.
// tailscale: binds loopback only and publishes through `tailscale serve`, which provides a publicly trusted
//   HTTPS certificate on your private tailnet — nothing to install on the iPad except the Tailscale app.
//
// The launcher uses its own data directory (default ./data-ipad-test), seeds fictitious demo accounts and
// patients, and prints credentials once. It needs no administrator rights; opening a firewall port is done by
// the platform wrappers (deploy/linux/ipad-test.sh, deploy/windows/Start-YouHealIPadTest.ps1) or by hand.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { totp, base32Decode } from '../server/lib/totp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
if (flag('help')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(0); }

const MODE = opt('mode', 'lan');
const PORT = Number(opt('port', MODE === 'lan' ? 8443 : 8080));
const CA_PORT = Number(opt('ca-port', 8099));
const DATA = path.resolve(opt('data', path.join(root, 'data-ipad-test')));
const TLS = path.join(DATA, 'tls');
const log = (...a) => console.log('[ipad-test]', ...a);
const die = (m) => { console.error(`[ipad-test] ERROR: ${m}`); process.exit(1); };
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], ...o }).toString();

if (!['lan', 'tailscale', 'codespaces'].includes(MODE)) die(`unknown --mode ${MODE}`);
if (flag('reset')) { fs.rmSync(DATA, { recursive: true, force: true }); log(`reset ${DATA}`); }
fs.mkdirSync(TLS, { recursive: true, mode: 0o700 });

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^(docker|br-|veth|vmnet|vboxnet|utun|tailscale|zt)/i.test(name)) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/** Private test CA + server certificate acceptable to iOS (SAN, serverAuth EKU, SHA-256, ≤ 397 days). */
function ensureCerts(ips, hostnames) {
  const caKey = path.join(TLS, 'test-ca.key'), caCrt = path.join(TLS, 'youheal-test-ca.crt');
  const key = path.join(TLS, 'key.pem'), crt = path.join(TLS, 'cert.pem'), sanFile = path.join(TLS, 'san.txt');
  const san = [...hostnames.map((h) => `DNS:${h}`), ...ips.map((i) => `IP:${i}`)].join(',');
  try { run('openssl', ['version']); } catch { die('openssl not found. macOS/Linux include it; on Windows install Git for Windows (adds openssl) or use --mode tailscale.'); }
  if (!fs.existsSync(caCrt)) {
    log('creating private test CA (valid 397 days; for this test install only)');
    run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-sha256', '-nodes', '-days', '397',
      '-keyout', caKey, '-out', caCrt, '-subj', `/CN=YOU HEAL Clinical TEST CA (${os.hostname()})`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }
  if (!fs.existsSync(crt) || (fs.existsSync(sanFile) ? fs.readFileSync(sanFile, 'utf8') : '') !== san) {
    log(`issuing server certificate for ${san}`);
    const csr = path.join(TLS, 'server.csr'), ext = path.join(TLS, 'server.ext');
    fs.writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
    run('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${hostnames[0]}`]);
    run('openssl', ['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-sha256', '-days', '397', '-extfile', ext, '-out', crt]);
    fs.writeFileSync(sanFile, san); fs.rmSync(csr, { force: true });
  }
  for (const f of [caKey, key]) fs.chmodSync(f, 0o600);
  return { caCrt, key, crt };
}

/** Serves ONLY the public CA certificate over plain HTTP for a limited time so the iPad can install it. */
function serveCa(caCrt, ip) {
  const body = fs.readFileSync(caCrt);
  const srv = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/youheal-test-ca.crt') {
      res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="youheal-test-ca.crt"', 'cache-control': 'no-store' });
      res.end(body);
    } else { res.writeHead(404); res.end(); }
  });
  srv.listen(CA_PORT, '0.0.0.0', () => log(`test CA available for 15 min at  http://${ip}:${CA_PORT}/`));
  setTimeout(() => { srv.close(); log('test CA download closed'); }, 15 * 60_000).unref();
}

function tailscaleName() {
  let st; try { st = JSON.parse(run('tailscale', ['status', '--json'])); } catch { die('tailscale CLI not found or not logged in (install Tailscale, run `tailscale up`).'); }
  const dns = String(st?.Self?.DNSName || '').replace(/\.$/, '');
  if (!dns) die('could not read this machine\'s Tailscale DNS name (enable MagicDNS + HTTPS certificates in the Tailscale admin console).');
  return dns;
}

/** Minimal JSON client for loopback calls; in LAN mode it trusts only the private test CA. */
let LOOP_CA = null;
function request(method, url, body, headers = {}) {
  const u = new URL(url); const lib = u.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const r = lib.request(u, { method, ca: LOOP_CA || undefined, headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let json = {}; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}

/** In proxied modes the server only accepts the public host/origin; loopback calls present them (no X-Forwarded-*
 *  headers, so first-run setup still counts as local). In LAN mode the loopback origin is used as-is. */
let PUBLIC_BASE = null;
function originHeaders(base) {
  return PUBLIC_BASE ? { origin: PUBLIC_BASE, host: new URL(PUBLIC_BASE).host } : { origin: base };
}

async function waitHealthy(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try { if ((await request('GET', `${base}/api/v1/health`)).status === 200) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  die('server did not become healthy within 30 s (see output above)');
}

/** First-run setup + fictitious demo data through the public API, over loopback. */
async function seedDemo(base) {
  const st = (await request('GET', `${base}/api/v1/setup/status`)).json;
  if (!st.needsSetup) { log('existing test instance — keeping its data and accounts'); return null; }
  const pw = () => crypto.randomBytes(9).toString('base64url') + '-Yh7';
  const admin = { email: 'admin@demo.test', name: 'Demo Admin', password: pw() };
  const prac = { email: 'practitioner@demo.test', name: 'Dr. Alex Demo', password: pw() };
  const token = fs.readFileSync(path.join(DATA, 'setup-token'), 'utf8').trim();
  let cookie = '', csrf = '';
  const call = async (m, p, b) => {
    const r = await request(m, base + '/api/v1' + p, b, { cookie, 'x-csrf-token': csrf, ...originHeaders(base) });
    const sc = [].concat(r.headers['set-cookie'] || []); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const j = r.json; if (j.csrfToken) csrf = j.csrfToken;
    if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status} ${JSON.stringify(j.error || j)}`);
    return j;
  };
  await call('POST', '/setup', { setupToken: token, org: { name: 'YOU HEAL — iPad Test Clinic' }, admin });
  await call('POST', '/auth/login', { email: admin.email, password: admin.password });
  // Admins must enroll MFA before anything else (security baseline). Enroll the demo admin here and hand the
  // secret to the tester so the same account works from the iPad with any authenticator app.
  const mfa = await call('POST', '/auth/mfa/setup');
  const en = await call('POST', '/auth/mfa/enable', { code: totp(base32Decode(mfa.secret)) });
  admin.mfaSecret = mfa.secret; admin.recovery = (en.recoveryCodes || []).slice(0, 2);
  await call('POST', '/users', { ...prac, role: 'practitioner' });
  return { admin, prac };
}

/** Fictitious patients with intake consent so the practitioner can start a scan immediately. */
async function seedPatients(base, prac) {
  let cookie = '', csrf = '';
  const call = async (m, p, b) => {
    const r = await request(m, base + '/api/v1' + p, b, { cookie, 'x-csrf-token': csrf, ...originHeaders(base) });
    const sc = [].concat(r.headers['set-cookie'] || []); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    if (r.json.csrfToken) csrf = r.json.csrfToken;
    if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status}`);
    return r.json;
  };
  await call('POST', '/auth/login', { email: prac.email, password: prac.password });
  const demo = [
    { firstName: 'Jane', lastName: 'Sample', dob: '1980-01-01', sex: 'female', preferredLanguage: 'en' },
    { firstName: 'John', lastName: 'Demo', dob: '1964-06-15', sex: 'male', preferredLanguage: 'es' },
    { firstName: 'Mary', lastName: 'Example', dob: '1991-11-30', sex: 'female', preferredLanguage: 'en' },
  ];
  for (const d of demo) {
    const p = await call('POST', '/patients', d);
    await call('POST', `/patients/${p.id}/consents`, { type: 'intake', answers: {}, contraindications: { relative: [], absolute: [] }, signatureName: `${d.firstName} ${d.lastName}`, signedAt: new Date().toISOString() });
  }
  log(`seeded ${demo.length} fictitious patients with intake on file`);
}

// ------------------------------------------------------------------ main
const env = { ...process.env, YH_DATA_DIR: DATA, YH_CATALOG_DIR: path.join(root, 'data', 'catalog'), YH_PORT: String(PORT), NODE_ENV: 'production' };
let publicBase, banner = [];
if (MODE === 'lan') {
  const ips = lanAddresses();
  if (!ips.length) die('no LAN IPv4 address found — connect this computer to the same Wi-Fi as the iPad');
  const host = os.hostname().toLowerCase();
  const names = [...new Set([`${host}.local`, host, 'localhost'])];
  const { caCrt, key, crt } = ensureCerts([...ips, '127.0.0.1'], names);
  Object.assign(env, { YH_HOST: '0.0.0.0', YH_TLS_CERT: crt, YH_TLS_KEY: key, YH_ALLOWED_HOSTS: [...ips, ...names].join(',') });
  publicBase = `https://${ips[0]}:${PORT}`;
  serveCa(caCrt, ips[0]);
  banner = [
    `On the iPad (same Wi-Fi as this computer):`,
    `  1. Safari → http://${ips[0]}:${CA_PORT}/  → Allow → Settings → "Profile Downloaded" → Install`,
    `  2. Settings → General → About → Certificate Trust Settings → enable "YOU HEAL Clinical TEST CA"`,
    `  3. Safari → ${publicBase}   (Share → Add to Home Screen for a full-screen app icon)`,
    ips.length > 1 ? `  (other addresses on this computer: ${ips.slice(1).join(', ')})` : '',
    `If the iPad cannot connect, allow inbound TCP ${PORT} and ${CA_PORT} in this computer's firewall.`,
  ];
} else if (MODE === 'codespaces') {
  const name = process.env.CODESPACE_NAME, domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (!name || !domain) die('not running inside GitHub Codespaces (CODESPACE_NAME / GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN unset)');
  const pub = `${name}-${PORT}.${domain}`;
  // GitHub's forwarding agent connects over loopback and terminates TLS; trust only loopback as the proxy.
  Object.assign(env, { YH_HOST: '127.0.0.1', YH_TRUST_PROXY: '1', YH_TRUSTED_PROXIES: '127.0.0.1,::1', YH_ALLOWED_HOSTS: `${pub},localhost`, YH_PUBLIC_ORIGIN: `https://${pub}`,
    // GitHub's port forwarding rewrites the browser's Origin header to the local port
    YH_PROXY_ORIGIN_ALIASES: `http://localhost:${PORT},https://localhost:${PORT}` });
  publicBase = `https://${pub}`;
  banner = [
    `Open on iPad / iPhone (Safari, signed in to github.com as the codespace owner): ${publicBase}`,
    `Tip: Share → Add to Home Screen. The port is PRIVATE (only you); to let other testers in, run:`,
    `  gh codespace ports visibility ${PORT}:public -c ${name}     (the app's own sign-in still applies)`,
  ];
} else {
  const dns = tailscaleName();
  Object.assign(env, { YH_HOST: '127.0.0.1', YH_TRUST_PROXY: '1', YH_TRUSTED_PROXIES: '127.0.0.1,::1', YH_ALLOWED_HOSTS: `${dns},localhost`, YH_PUBLIC_ORIGIN: `https://${dns}` });
  publicBase = `https://${dns}`;
  try { run('tailscale', ['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`]); } catch (e) { die(`tailscale serve failed: ${e.stderr || e.message}`); }
  banner = [`On the iPad: install the Tailscale app, sign in to the same tailnet, then open ${publicBase}`, `Stop publishing later with: tailscale serve --https=443 off`];
}

log(`starting server (data: ${DATA})`);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server', 'index.js')], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

const loop = MODE === 'lan' ? `https://127.0.0.1:${PORT}` : `http://127.0.0.1:${PORT}`;
if (MODE === 'lan') LOOP_CA = fs.readFileSync(path.join(TLS, 'youheal-test-ca.crt'));
if (MODE !== 'lan') PUBLIC_BASE = publicBase;
await waitHealthy(loop);
const creds = flag('no-demo') ? null : await seedDemo(loop).catch((e) => { log('demo seeding failed:', e.message); return null; });
if (creds) await seedPatients(loop, creds.prac).catch((e) => log('demo patients skipped:', e.message));

console.log('\n' + '='.repeat(78));
console.log(' YOU HEAL Clinical — iPad TEST instance (fictitious data only)');
console.log('='.repeat(78));
for (const l of banner.filter(Boolean)) console.log(' ' + l);
if (creds) {
  // Codespaces runs headless in the background; keep the credentials in the (gitignored) test data folder.
  const credFile = path.join(DATA, 'DEMO-CREDENTIALS.txt');
  fs.writeFileSync(credFile, [`YOU HEAL Clinical — TEST instance (fictitious data only)`, `URL: ${publicBase}`, '',
    `Practitioner  ${creds.prac.email}  ${creds.prac.password}`, `Admin         ${creds.admin.email}  ${creds.admin.password}`,
    `Admin MFA key (authenticator app, manual entry, time-based): ${creds.admin.mfaSecret}`,
    `Admin backup codes: ${creds.admin.recovery.join('  ')}`, ''].join('\n'), { mode: 0o600 });
  console.log(`\n Credentials also saved to ${path.relative(root, credFile)} (gitignored, 0600).`);
  console.log('\n Sign-in accounts (shown once — note them now):');
  console.log(`   Practitioner  ${creds.prac.email}   ${creds.prac.password}   (ready to scan)`);
  console.log(`   Admin         ${creds.admin.email}        ${creds.admin.password}`);
  console.log(`                 MFA: add this key to an authenticator app (manual entry, time-based): ${creds.admin.mfaSecret}`);
  console.log(`                 backup codes: ${creds.admin.recovery.join('  ')}`);
}
console.log('\n Stop with Ctrl+C. Wipe the test instance with --reset.');
console.log('='.repeat(78) + '\n');
