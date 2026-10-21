// User administration (admin only, scoped to the admin's org).

import { v, check, paging, uuidStr } from '../lib/validate.js';
import { hashPassword, uuid, randomToken } from '../lib/crypto.js';
import { passwordPolicyError } from '../lib/auth.js';
import { HttpError, notFound, conflict } from '../lib/http.js';
import { ROLES, PERM } from '../lib/rbac.js';
import { nowIso, userView, LOCALES } from './_shared.js';

const createSchema = v.object({
  email: v.email(),
  name: v.string({ min: 1, max: 200 }),
  role: v.enum(ROLES),
  password: v.string({ min: 1, max: 256, trim: false }).optional(),
  mustChangePassword: v.bool().optional(),
  locale: v.enum(LOCALES).optional(),
});
const patchSchema = v.object({
  email: v.email().optional(),
  name: v.string({ min: 1, max: 200 }).optional(),
  role: v.enum(ROLES).optional(),
  active: v.bool().optional(),
  password: v.string({ min: 1, max: 256, trim: false }).optional(),
  locale: v.enum(LOCALES).optional(),
  unlock: v.bool().optional(),
  resetMfa: v.bool().optional(),
});

const tempPassword = () => `${randomToken(9)}-${randomToken(6)}`;

export function register(router, { db, sessions }) {
  const opts = { roles: PERM.admin };

  router.get('/users', (ctx) => {
    const { limit, offset } = paging(ctx.query, { defLimit: 100, maxLimit: 500 });
    const total = db.get('SELECT COUNT(*) AS n FROM users WHERE org_id = ?', ctx.user.org_id).n;
    const items = db.all('SELECT * FROM users WHERE org_id = ? ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?', ctx.user.org_id, limit, offset).map(userView);
    return { items, total };
  }, opts);

  router.post('/users', async (ctx) => {
    const body = check(createSchema, ctx.body);
    let password = body.password, generated = false;
    if (password === undefined) { password = tempPassword(); generated = true; }
    const pwErr = passwordPolicyError(password, body);
    if (pwErr) throw new HttpError(400, 'VALIDATION', 'Password does not meet policy', { password: pwErr });
    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', body.email)) throw conflict('EMAIL_TAKEN', 'A user with this email already exists');
    const hash = await hashPassword(password);
    const id = uuid(), ts = nowIso();
    const mustChange = generated || body.mustChangePassword === true;
    db.tx(() => {
      db.run(`INSERT INTO users (id, org_id, email, name, role, password_hash, password_changed_at, must_change_password, locale, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.user.org_id, body.email, body.name, body.role, hash, ts, mustChange, body.locale || 'en', ts, ts);
      ctx.audit('user.create', { targetType: 'user', targetId: id, detail: { role: body.role } });
    });
    ctx.status = 201;
    const out = { user: userView(db.get('SELECT * FROM users WHERE id = ?', id)) };
    if (generated) out.temporaryPassword = password;
    return out;
  }, opts);

  router.patch('/users/:id', async (ctx) => {
    check(uuidStr(), ctx.params.id);
    const body = check(patchSchema, ctx.body ?? {});
    const target = db.get('SELECT * FROM users WHERE id = ? AND org_id = ?', ctx.params.id, ctx.user.org_id);
    if (!target) throw notFound('User not found');

    const demoting = (body.role && body.role !== 'admin') || body.active === false;
    if (target.role === 'admin' && target.active && demoting) {
      const admins = db.get("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'admin' AND active = 1", ctx.user.org_id).n;
      if (admins <= 1) throw conflict('LAST_ADMIN', 'The clinic must keep at least one active administrator');
    }
    if (body.email && body.email !== target.email && db.get('SELECT 1 AS x FROM users WHERE email = ?', body.email)) throw conflict('EMAIL_TAKEN', 'A user with this email already exists');
    let hash = null;
    if (body.password !== undefined) {
      const err = passwordPolicyError(body.password, { email: body.email || target.email, name: body.name || target.name });
      if (err) throw new HttpError(400, 'VALIDATION', 'Password does not meet policy', { password: err });
      hash = await hashPassword(body.password);
    }

    const sets = [], params = [], changed = [];
    const set = (col, val, field) => { sets.push(`${col} = ?`); params.push(val); changed.push(field); };
    if (body.email !== undefined) set('email', body.email, 'email');
    if (body.name !== undefined) set('name', body.name, 'name');
    if (body.role !== undefined) set('role', body.role, 'role');
    if (body.active !== undefined) set('active', body.active, 'active');
    if (body.locale !== undefined) set('locale', body.locale, 'locale');
    if (hash) { set('password_hash', hash, 'password'); sets.push('must_change_password = 1', 'password_changed_at = ?'); params.push(nowIso()); }
    if (body.unlock) { sets.push('failed_attempts = 0', 'locked_until = NULL', 'last_failed_at = NULL'); changed.push('unlock'); }
    if (body.resetMfa) { sets.push('mfa_enabled = 0', 'mfa_secret_enc = NULL', 'mfa_pending_enc = NULL', 'mfa_last_step = NULL', 'recovery_codes = NULL'); changed.push('mfa'); }
    if (!sets.length) return { user: userView(target) };

    db.tx(() => {
      db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), target.id);
      if (hash || body.active === false || (body.role && body.role !== target.role) || body.resetMfa) {
        sessions.destroyForUser(target.id, target.id === ctx.user.id ? ctx.session.id : null);
      }
      ctx.audit('user.update', { targetType: 'user', targetId: target.id, detail: { fields: changed, role: body.role } });
    });
    return { user: userView(db.get('SELECT * FROM users WHERE id = ?', target.id)) };
  }, opts);
}
