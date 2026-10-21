// NEW-3: step-up re-authentication (finalize, password change, MFA enable/disable, recovery-code
// regeneration) shares the login defenses: the per-account token bucket, the atomic failure counter and
// the lockout. A locked account cannot re-authenticate (423) even while an older session is still valid.

import { verifyPassword } from '../lib/crypto.js';
import { recordUserFailure, accountBucketKey } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';

export function createReauth({ db, cfg, limits }) {
  const { maxAttempts, windowMin } = cfg.lockout;
  const windowMs = windowMin * 60_000;

  /** Lockout + per-account bucket gate. Returns the fresh user row. */
  function guard(ctx) {
    const user = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
      ctx.audit('auth.reauth.blocked', { targetType: 'user', targetId: user.id, outcome: 'failure', detail: { reason: 'locked' } });
      throw new HttpError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${windowMin} minutes or contact your administrator.`);
    }
    const t = limits.account.take(accountBucketKey(user.email));
    if (!t.ok) throw Object.assign(new HttpError(429, 'RATE_LIMITED', 'Too many attempts for this account; slow down'), { retryAfter: t.retryAfter });
    return user;
  }

  function fail(ctx, user, reason) {
    db.tx(() => {
      const r = recordUserFailure(db, user.id, { maxAttempts, windowMs });
      ctx.audit('auth.reauth.failure', { targetType: 'user', targetId: user.id, outcome: 'failure', detail: { reason, attempts: r.attempts, route: ctx.req.route } });
      if (r.attempts === maxAttempts) ctx.audit('auth.lockout', { targetType: 'user', targetId: user.id, outcome: 'failure', detail: { minutes: windowMin } });
    });
  }

  /** Refund the bucket token. The failure counter is NOT reset here (a correct password followed by a wrong
   *  second factor must keep counting); only a full successful login resets it. */
  function succeed(user) {
    limits.account.refund(accountBucketKey(user.email));
  }

  /** guard + verify the current password; records a failure and returns false when wrong. */
  async function password(ctx, pw, reason = 'bad_password') {
    const user = guard(ctx);
    if (!(await verifyPassword(pw, user.password_hash))) { fail(ctx, user, reason); return false; }
    succeed(user);
    return true;
  }

  return { guard, fail, succeed, password };
}
