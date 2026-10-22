// First-run setup: creates the clinic (org) and its first admin. Only while the users table is empty,
// only from loopback without any proxy headers (unless YH_ALLOW_REMOTE_SETUP=1), and only with the
// one-time setup token written to <data>/setup-token (0600) at first start (its path is logged; the value is
// printed only for loopback dev binds with NODE_ENV !== 'production').

import fs from 'node:fs';
import { v, check } from '../lib/validate.js';
import { hashPassword, uuid, randomToken, safeEqual } from '../lib/crypto.js';
import { passwordPolicyError } from '../lib/auth.js';
import { isLoopbackIp, HttpError, forbidden } from '../lib/http.js';
import { nowIso, DEFAULT_POLARITY } from './_shared.js';
import { isLoopbackHost } from '../lib/config.js';

const schema = v.object({
  org: v.object({ name: v.string({ min: 1, max: 200 }), defaultLocale: v.enum(['en', 'es']).optional() }),
  admin: v.object({
    email: v.email(),
    name: v.string({ min: 1, max: 200 }),
    password: v.string({ min: 1, max: 256, trim: false }),
    locale: v.enum(['en', 'es']).optional(),
  }),
  setupToken: v.string({ min: 1, max: 200 }).optional(),
});

const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host'];

export const needsSetup = (db) => db.get('SELECT COUNT(*) AS n FROM users').n === 0;

export function readSetupToken(cfg) {
  try { return fs.readFileSync(cfg.setupTokenFile, 'utf8').trim() || null; } catch { return null; }
}

/** Create the one-time setup token if the instance is unconfigured (idempotent). Logs it loudly. */
export function ensureSetupToken(cfg, db, log) {
  if (!needsSetup(db)) { removeSetupToken(cfg); return null; }
  let token = readSetupToken(cfg);
  if (!token) {
    token = randomToken(24);
    fs.writeFileSync(cfg.setupTokenFile, `${token}\n`, { mode: 0o600, flag: 'w' });
    if (process.platform !== 'win32') fs.chmodSync(cfg.setupTokenFile, 0o600);
  }
  log?.loud(`first-run setup token written to ${cfg.setupTokenFile} (0600) — enter it on the setup screen`);
  // Dev convenience only: loopback bind and NODE_ENV !== 'production' also prints the value.
  if (isLoopbackHost(cfg.host) && process.env.NODE_ENV !== 'production') log?.loud(`(dev, loopback only) setup token: ${token}`);
  return token;
}

export function removeSetupToken(cfg) { fs.rmSync(cfg.setupTokenFile, { force: true }); }

export function register(router, { db, log }) {
  router.get('/setup/status', () => ({ needsSetup: needsSetup(db), tokenRequired: true }), { public: true });

  router.post('/setup', async (ctx) => {
    const { cfg } = ctx;
    if (!needsSetup(db)) throw new HttpError(409, 'ALREADY_SETUP', 'Setup has already been completed');
    if (!cfg.allowRemoteSetup) {
      const proxied = PROXY_HEADERS.some((h) => ctx.req.headers[h] !== undefined);
      if (proxied || !(isLoopbackIp(ctx.req.socket.remoteAddress) && isLoopbackIp(ctx.ip))) {
        ctx.audit('setup.denied', { outcome: 'failure', detail: { reason: proxied ? 'proxied' : 'non-loopback' } });
        throw forbidden('Initial setup is only allowed directly on this computer (loopback, no proxy). Set YH_ALLOW_REMOTE_SETUP=1 to override.', 'SETUP_LOCAL_ONLY');
      }
    }
    const body = check(schema, ctx.body);
    const expected = readSetupToken(cfg) || ensureSetupToken(cfg, db, log);
    if (!body.setupToken || !safeEqual(body.setupToken.trim(), expected)) {
      ctx.audit('setup.denied', { outcome: 'failure', detail: { reason: body.setupToken ? 'bad_token' : 'missing_token' } });
      throw forbidden(`A valid setup token is required. It is stored in ${cfg.setupTokenFile} on the server.`, 'SETUP_TOKEN_INVALID');
    }
    const pwErr = passwordPolicyError(body.admin.password, body.admin);
    if (pwErr) throw new HttpError(400, 'VALIDATION', 'Password does not meet policy', { 'admin.password': pwErr });
    const hash = await hashPassword(body.admin.password);
    const ts = nowIso();
    const orgId = uuid(), userId = uuid();
    db.tx(() => {
      if (!needsSetup(db)) throw new HttpError(409, 'ALREADY_SETUP', 'Setup has already been completed');
      const profile = { polarity: DEFAULT_POLARITY, defaultLocale: body.org.defaultLocale || 'en' };
      db.run('INSERT INTO orgs (id, name, profile, created_at, updated_at) VALUES (?,?,?,?,?)', orgId, body.org.name, JSON.stringify(profile), ts, ts);
      db.run(`INSERT INTO users (id, org_id, email, name, role, password_hash, password_changed_at, locale, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, userId, orgId, body.admin.email, body.admin.name, 'admin', hash, ts, body.admin.locale || body.org.defaultLocale || 'en', ts, ts);
      ctx.audit('setup.complete', { orgId, actorId: userId, actorRole: 'admin', targetType: 'org', targetId: orgId });
    });
    removeSetupToken(cfg);
    return { ok: true };
  }, { public: true, rate: 'auth' });
}
