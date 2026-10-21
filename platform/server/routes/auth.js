// Authentication, MFA (TOTP + recovery codes), password change, preferences.

import { v, check } from '../lib/validate.js';
import {
  verifyPassword, hashPassword, dummyPasswordHash, passwordNeedsRehash, encryptField, decryptField,
} from '../lib/crypto.js';
import {
  passwordPolicyError, generateRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode, consumeRecoveryCode,
} from '../lib/auth.js';
import { verifyTotp, generateSecret, base32Encode, otpauthUrl } from '../lib/totp.js';
import { HttpError, conflict, forbidden } from '../lib/http.js';
import { nowIso, userView, orgView, getOrg, LOCALES, THEMES } from './_shared.js';

const loginSchema = v.object({
  email: v.string({ min: 1, max: 254, lower: true }),
  password: v.string({ min: 1, max: 1024, trim: false }),
  totp: v.string({ min: 1, max: 32 }).optional().nullable(),
});

const mfaAad = (userId) => `users.mfa_secret:${userId}`;
const mfaPendingAad = (userId) => `users.mfa_pending:${userId}`;

export function mePayload(ctx, user, session) {
  const org = getOrg(ctx.db, user.org_id);
  const restriction = user.must_change_password ? 'password'
    : (user.role === 'admin' && !user.mfa_enabled && !ctx.cfg.devNoMfa ? 'mfa' : null);
  return {
    user: userView(user),
    org: orgView(org),
    csrfToken: session.csrf,
    mfaEnrollmentRequired: restriction === 'mfa',
    passwordChangeRequired: restriction === 'password',
    session: {
      expiresAt: session.expires_at,
      idleTimeoutSec: ctx.cfg.sessionIdleMin * 60,
    },
  };
}

/** Verify a TOTP code or recovery code for a user. Returns { ok, step?, recovery? }. */
function checkSecondFactor(ctx, user, code) {
  const secret = Buffer.from(decryptField(ctx.keyring, user.mfa_secret_enc, mfaAad(user.id)), 'base64');
  const step = verifyTotp(secret, code, { lastStep: user.mfa_last_step });
  if (step !== null) return { ok: true, step };
  if (looksLikeRecoveryCode(code)) {
    const r = consumeRecoveryCode(ctx.keyring, user.recovery_codes, code);
    if (r) return { ok: true, recovery: r };
  }
  return { ok: false };
}

export function register(router, deps) {
  const { db, keyring, sessions, ghost, cfg } = deps;
  const { maxAttempts, windowMin } = cfg.lockout;
  const windowMs = windowMin * 60_000;

  function registerFailure(ctx, user, reason) {
    const now = Date.now();
    const recent = user.last_failed_at && now - Date.parse(user.last_failed_at) < windowMs;
    const attempts = (recent ? user.failed_attempts : 0) + 1;
    const lock = attempts >= maxAttempts ? new Date(now + windowMs).toISOString() : null;
    db.tx(() => {
      db.run('UPDATE users SET failed_attempts = ?, last_failed_at = ?, locked_until = COALESCE(?, locked_until), updated_at = ? WHERE id = ?',
        attempts, new Date(now).toISOString(), lock, nowIso(), user.id);
      ctx.audit('auth.login.failure', { orgId: user.org_id, actorId: user.id, actorRole: user.role, targetType: 'user', targetId: user.id, outcome: 'failure', detail: { reason, attempts } });
      if (lock) ctx.audit('auth.lockout', { orgId: user.org_id, actorId: user.id, actorRole: user.role, targetType: 'user', targetId: user.id, outcome: 'failure', detail: { minutes: windowMin } });
    });
  }

  const invalid = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  const locked = () => new HttpError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${windowMin} minutes or contact your administrator.`);

  router.post('/auth/login', async (ctx) => {
    const body = check(loginSchema, ctx.body);
    const user = db.get('SELECT * FROM users WHERE email = ?', body.email);
    if (!user || !user.active) {
      if (ghost.isLocked(body.email)) throw locked();
      await verifyPassword(body.password, await dummyPasswordHash());
      ghost.fail(body.email);
      ctx.audit('auth.login.failure', { orgId: user?.org_id ?? null, targetType: 'user', targetId: user?.id ?? null, outcome: 'failure', detail: { reason: user ? 'inactive' : 'unknown_account' } });
      throw invalid();
    }
    if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
      ctx.audit('auth.login.blocked', { orgId: user.org_id, actorId: user.id, actorRole: user.role, targetType: 'user', targetId: user.id, outcome: 'failure', detail: { reason: 'locked' } });
      throw locked();
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      registerFailure(ctx, user, 'bad_password');
      throw invalid();
    }
    const updates = {};
    if (user.mfa_enabled) {
      if (!body.totp) {
        ctx.audit('auth.login.mfa_required', { orgId: user.org_id, actorId: user.id, actorRole: user.role, targetType: 'user', targetId: user.id });
        throw new HttpError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
      }
      const r = checkSecondFactor(ctx, user, body.totp);
      if (!r.ok) {
        registerFailure(ctx, user, 'bad_mfa');
        throw new HttpError(401, 'MFA_INVALID', 'Invalid or already used authentication code');
      }
      if (r.step !== undefined) updates.mfa_last_step = r.step;
      if (r.recovery) { updates.recovery_codes = r.recovery.updated; updates.recoveryUsed = r.recovery.remaining; }
    }
    const newHash = passwordNeedsRehash(user.password_hash) ? await hashPassword(body.password) : null;

    // rotate: any session presented with this request is discarded
    if (ctx.session) sessions.destroy(ctx.session.id);
    const ts = nowIso();
    const created = db.tx(() => {
      db.run(`UPDATE users SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL, last_login_at = ?, updated_at = ?,
        mfa_last_step = COALESCE(?, mfa_last_step), recovery_codes = COALESCE(?, recovery_codes), password_hash = COALESCE(?, password_hash) WHERE id = ?`,
      ts, ts, updates.mfa_last_step ?? null, updates.recovery_codes ?? null, newHash, user.id);
      const s = sessions.create(user, { ip: ctx.ip, ua: ctx.req.headers['user-agent'] });
      ctx.audit('auth.login.success', {
        orgId: user.org_id, actorId: user.id, actorRole: user.role, targetType: 'user', targetId: user.id,
        detail: { mfa: Boolean(user.mfa_enabled), recoveryCodeUsed: updates.recovery_codes ? true : undefined },
      });
      return s;
    });
    ctx.setCookie(created.token);
    const fresh = db.get('SELECT * FROM users WHERE id = ?', user.id);
    const session = db.get('SELECT * FROM user_sessions WHERE id = ?', created.id);
    ctx.user = fresh;
    return mePayload(ctx, fresh, session);
  }, { public: true, rate: 'auth' });

  router.post('/auth/logout', (ctx) => {
    if (ctx.session) {
      sessions.destroy(ctx.session.id);
      ctx.audit('auth.logout', { targetType: 'user', targetId: ctx.user.id });
    }
    ctx.setCookie('', 0);
    return { ok: true };
  }, { public: true, csrfIfSession: true });

  router.get('/auth/me', (ctx) => mePayload(ctx, ctx.user, ctx.session), { allowWhen: ['mfa', 'password'] });

  router.post('/auth/password', async (ctx) => {
    const body = check(v.object({ current: v.string({ min: 1, max: 1024, trim: false }), next: v.string({ min: 1, max: 1024, trim: false }) }), ctx.body);
    const user = ctx.user;
    if (!(await verifyPassword(body.current, user.password_hash))) {
      ctx.audit('auth.password.change', { targetType: 'user', targetId: user.id, outcome: 'failure', detail: { reason: 'bad_current' } });
      throw new HttpError(400, 'VALIDATION', 'Current password is incorrect', { current: 'is incorrect' });
    }
    const err = passwordPolicyError(body.next, user);
    if (err) throw new HttpError(400, 'VALIDATION', 'Password does not meet policy', { next: err });
    if (await verifyPassword(body.next, user.password_hash)) throw new HttpError(400, 'VALIDATION', 'New password must differ from the current one', { next: 'must differ from the current password' });
    const hash = await hashPassword(body.next);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hash, nowIso(), nowIso(), user.id);
      sessions.destroyForUser(user.id, ctx.session.id);
      ctx.audit('auth.password.change', { targetType: 'user', targetId: user.id });
    });
    return { ok: true };
  }, { allowWhen: ['password'], rate: 'auth' });

  router.post('/auth/mfa/setup', (ctx) => {
    const user = ctx.user;
    if (user.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled; disable it first to re-enroll');
    const secret = generateSecret(20);
    db.run('UPDATE users SET mfa_pending_enc = ?, updated_at = ? WHERE id = ?', encryptField(keyring, secret.toString('base64'), mfaPendingAad(user.id)), nowIso(), user.id);
    ctx.audit('auth.mfa.setup', { targetType: 'user', targetId: user.id });
    return { secret: base32Encode(secret, { padding: false }), otpauthUrl: otpauthUrl({ secret, account: user.email }) };
  }, { allowWhen: ['mfa'] });

  router.post('/auth/mfa/enable', (ctx) => {
    const body = check(v.object({ code: v.string({ min: 6, max: 10 }) }), ctx.body);
    const user = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (user.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    if (!user.mfa_pending_enc) throw conflict('MFA_SETUP_REQUIRED', 'Call /auth/mfa/setup first');
    const secretB64 = decryptField(keyring, user.mfa_pending_enc, mfaPendingAad(user.id));
    const step = verifyTotp(Buffer.from(secretB64, 'base64'), body.code);
    if (step === null) {
      ctx.audit('auth.mfa.enable', { targetType: 'user', targetId: user.id, outcome: 'failure', detail: { reason: 'bad_code' } });
      throw new HttpError(400, 'MFA_INVALID', 'The code did not match. Check the time on your device and try again.', { code: 'is invalid' });
    }
    const codes = generateRecoveryCodes(10);
    const stored = JSON.stringify(codes.map((c) => ({ h: hashRecoveryCode(keyring, c), used: null })));
    db.tx(() => {
      db.run(`UPDATE users SET mfa_enabled = 1, mfa_secret_enc = ?, mfa_pending_enc = NULL, mfa_last_step = ?, recovery_codes = ?, updated_at = ? WHERE id = ?`,
        encryptField(keyring, secretB64, mfaAad(user.id)), step, stored, nowIso(), user.id);
      sessions.destroyForUser(user.id, ctx.session.id);
      ctx.audit('auth.mfa.enable', { targetType: 'user', targetId: user.id });
    });
    return { ok: true, recoveryCodes: codes };
  }, { allowWhen: ['mfa'], rate: 'auth' });

  router.post('/auth/mfa/disable', async (ctx) => {
    const body = check(v.object({ password: v.string({ min: 1, max: 1024, trim: false }), code: v.string({ min: 6, max: 16 }) }), ctx.body);
    const user = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!user.mfa_enabled) throw conflict('MFA_NOT_ENABLED', 'MFA is not enabled');
    const pwOk = await verifyPassword(body.password, user.password_hash);
    const second = pwOk ? checkSecondFactor(ctx, user, body.code) : { ok: false };
    if (!pwOk || !second.ok) {
      ctx.audit('auth.mfa.disable', { targetType: 'user', targetId: user.id, outcome: 'failure' });
      throw forbidden('Password or authentication code is incorrect', 'REAUTH_FAILED');
    }
    db.tx(() => {
      db.run('UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, mfa_pending_enc = NULL, mfa_last_step = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?', nowIso(), user.id);
      ctx.audit('auth.mfa.disable', { targetType: 'user', targetId: user.id });
    });
    return { ok: true };
  }, { rate: 'auth' });

  router.patch('/auth/prefs', (ctx) => {
    const body = check(v.object({ locale: v.enum(LOCALES).optional(), theme: v.enum(THEMES).optional() }), ctx.body ?? {});
    const sets = [], params = [];
    if (body.locale) { sets.push('locale = ?'); params.push(body.locale); }
    if (body.theme) { sets.push('theme = ?'); params.push(body.theme); }
    if (sets.length) db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), ctx.user.id);
    return { ok: true, user: userView(db.get('SELECT * FROM users WHERE id = ?', ctx.user.id)) };
  });
}

