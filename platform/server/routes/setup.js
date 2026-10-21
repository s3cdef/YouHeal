// First-run setup: creates the clinic (org) and its first admin. Only while the users table is empty,
// and only from loopback unless YH_ALLOW_REMOTE_SETUP=1.

import { v, check } from '../lib/validate.js';
import { hashPassword, uuid } from '../lib/crypto.js';
import { passwordPolicyError } from '../lib/auth.js';
import { isLoopbackIp, HttpError, forbidden } from '../lib/http.js';
import { nowIso, DEFAULT_POLARITY } from './_shared.js';

const schema = v.object({
  org: v.object({ name: v.string({ min: 1, max: 200 }), defaultLocale: v.enum(['en', 'es']).optional() }),
  admin: v.object({
    email: v.email(),
    name: v.string({ min: 1, max: 200 }),
    password: v.string({ min: 1, max: 256, trim: false }),
    locale: v.enum(['en', 'es']).optional(),
  }),
});

export const needsSetup = (db) => db.get('SELECT COUNT(*) AS n FROM users').n === 0;

export function register(router, { db }) {
  router.get('/setup/status', () => ({ needsSetup: needsSetup(db) }), { public: true });

  router.post('/setup', async (ctx) => {
    if (!needsSetup(db)) throw new HttpError(409, 'ALREADY_SETUP', 'Setup has already been completed');
    if (!ctx.cfg.allowRemoteSetup && !(isLoopbackIp(ctx.req.socket.remoteAddress) && isLoopbackIp(ctx.ip))) {
      ctx.audit('setup.denied', { outcome: 'failure', detail: { reason: 'non-loopback' } });
      throw forbidden('Initial setup is only allowed from this computer (loopback). Set YH_ALLOW_REMOTE_SETUP=1 to override.', 'SETUP_LOCAL_ONLY');
    }
    const body = check(schema, ctx.body);
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
    return { ok: true };
  }, { public: true, rate: 'auth' });
}
