// Authentication primitives: password policy (IA-5), server-side sessions (AC-11/AC-12/SC-23),
// MFA recovery codes, account lockout (AC-7).

import crypto from 'node:crypto';
import { randomToken, sha256hex, hmacHex, uuid, normalizeText } from './crypto.js';

export const SESSION_COOKIE = 'yh_sid';
/** Key of the per-account login token bucket (F-01). */
export const accountBucketKey = (email) => `acct:${sha256hex(String(email).toLowerCase())}`;
/** F-17: over TLS the cookie uses the __Host- prefix (Secure, Path=/, no Domain → cannot be tossed by subdomains). */
export const SECURE_SESSION_COOKIE = '__Host-yh_sid';
export const sessionCookieName = (secure) => (secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE);

// ---------------------------------------------------------------- password policy

const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'administrator', 'monkey',
  'dragon', 'football', 'baseball', 'master', 'sunshine', 'princess', 'shadow', 'superman', 'trustno1', 'abc123',
  'changeme', 'youheal', 'biomagnetismo', 'biomagnetism', 'contrasena', 'secret', 'login', 'clinic', 'doctor'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

export function passwordPolicyError(pw, { email, name } = {}) {
  if (typeof pw !== 'string') return 'must be a string';
  if (pw.length < 12) return 'must be at least 12 characters';
  if (pw.length > 256) return 'must be at most 256 characters';
  if (new Set(pw).size < 5) return 'must contain at least 5 different characters';
  const lower = pw.toLowerCase();
  const deleet = [...lower].map((c) => LEET[c] ?? c).join('');
  const core = deleet.replace(/[^a-z]/g, '');
  for (const w of COMMON) {
    if (!core) break;
    if (core === w || (core.length <= w.length + 3 && core.includes(w)) || core === w.repeat(Math.ceil(core.length / w.length)).slice(0, core.length)) {
      return 'is too common or based on a common password';
    }
  }
  if (/^(.{1,4})\1+$/.test(lower)) return 'must not be a repeated pattern';
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf|zxcv){2,}/.test(lower) || /^[0-9]+$/.test(pw)) return 'must not be a simple sequence';
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'must not contain your email address';
  for (const part of normalizeText(name).split(' ')) if (part.length >= 4 && normalizeText(pw).includes(part)) return 'must not contain your name';
  return null;
}

// ---------------------------------------------------------------- MFA recovery codes

export function generateRecoveryCodes(n = 10) {
  // 10 chars from a 32-symbol alphabet = 50 bits each; displayed as xxxxx-xxxxx
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(10);
    const s = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const normalizeRecoveryCode = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const looksLikeRecoveryCode = (c) => /^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(String(c || '').trim());

// F-10: recovery codes are MACed with a dedicated HKDF subkey; each row stores the key id it was MACed
// with, so codes stay valid after `rotate-key` (re-MAC is impossible without the plaintext) as long as
// the retired key stays in data/keys/retired/. key_id NULL = legacy domain-separated SHA-256 rows.
export const hashRecoveryCode = (keySet, code) => hmacHex(keySet.recovery, `recovery|${normalizeRecoveryCode(code)}`);
const legacyRecoveryHash = (code) => sha256hex(`youheal-recovery|${normalizeRecoveryCode(code)}`);

export function storeRecoveryCodes(db, keyring, userId, codes) {
  const ts = new Date().toISOString();
  db.run('DELETE FROM user_recovery_codes WHERE user_id = ?', userId);
  for (const c of codes) {
    db.run('INSERT INTO user_recovery_codes (user_id, code_hash, key_id, used_at, created_at) VALUES (?,?,?,NULL,?)',
      userId, hashRecoveryCode(keyring.current, c), keyring.keyId, ts);
  }
}

/**
 * F-02: consume a recovery code atomically. Each candidate hash (current key, retired keys, legacy) is tried
 * with a guarded UPDATE that only succeeds while used_at IS NULL — exactly one row must change.
 */
export function consumeRecoveryCode(db, keyring, userId, code) {
  const now = new Date().toISOString();
  const candidates = [...keyring.sets.values()].map((ks) => [hashRecoveryCode(ks, code), ks.keyId]);
  candidates.push([legacyRecoveryHash(code), null]);
  for (const [h, kid] of candidates) {
    const r = kid === null
      ? db.run('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND key_id IS NULL AND used_at IS NULL', now, userId, h)
      : db.run('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND key_id = ? AND used_at IS NULL', now, userId, h, kid);
    if (r.changes === 1) return { remaining: recoveryCodesRemaining(db, userId) };
  }
  return null;
}

export const recoveryCodesRemaining = (db, userId) =>
  db.get('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).n;

// ---------------------------------------------------------------- sessions

export function createSessionStore(db, cfg) {
  const idleMs = cfg.sessionIdleMin * 60_000;
  const absMs = cfg.sessionAbsHours * 3_600_000;
  const TOUCH_MS = 15_000;

  return {
    idleMs, absMs,
    create(user, { ip, ua }) {
      const token = randomToken(32);
      const csrf = randomToken(32);
      const now = new Date();
      const id = uuid();
      db.run(`INSERT INTO user_sessions (id, token_hash, user_id, org_id, csrf, created_at, last_seen_at, expires_at, ip, ua)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, id, sha256hex(token), user.id, user.org_id, csrf, now.toISOString(), now.toISOString(),
      new Date(now.getTime() + absMs).toISOString(), ip || null, String(ua || '').slice(0, 256));
      return { id, token, csrf };
    },
    /** Resolve a cookie token. Returns { session, user } or { expired: true } or null. */
    lookup(token) {
      if (!token || typeof token !== 'string' || token.length > 100) return null;
      const s = db.get('SELECT * FROM user_sessions WHERE token_hash = ?', sha256hex(token));
      if (!s) return null;
      const now = Date.now();
      if (now >= Date.parse(s.expires_at) || now - Date.parse(s.last_seen_at) >= idleMs) {
        db.run('DELETE FROM user_sessions WHERE id = ?', s.id);
        return { expired: true, session: s };
      }
      const user = db.get('SELECT * FROM users WHERE id = ?', s.user_id);
      if (!user || !user.active) { db.run('DELETE FROM user_sessions WHERE id = ?', s.id); return null; }
      if (now - Date.parse(s.last_seen_at) > TOUCH_MS) db.run('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?', new Date(now).toISOString(), s.id);
      return { session: s, user };
    },
    destroy(id) { db.run('DELETE FROM user_sessions WHERE id = ?', id); },
    destroyForUser(userId, exceptId = null) {
      if (exceptId) db.run('DELETE FROM user_sessions WHERE user_id = ? AND id <> ?', userId, exceptId);
      else db.run('DELETE FROM user_sessions WHERE user_id = ?', userId);
    },
    purgeExpired() {
      const now = new Date();
      return db.run('DELETE FROM user_sessions WHERE expires_at <= ? OR last_seen_at <= ?', now.toISOString(),
        new Date(now.getTime() - idleMs).toISOString()).changes;
    },
  };
}

// ---------------------------------------------------------------- lockout bookkeeping

/**
 * Atomic failure bookkeeping (F-01): one UPDATE … RETURNING increments within the window and sets the lock,
 * so concurrent failures can never overwrite each other with a stale count.
 */
export function recordUserFailure(db, userId, { maxAttempts, windowMs }) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const windowStart = new Date(now - windowMs).toISOString();
  const lockUntil = new Date(now + windowMs).toISOString();
  return db.get(`UPDATE users SET
      failed_attempts = CASE WHEN last_failed_at IS NOT NULL AND last_failed_at > ? THEN failed_attempts + 1 ELSE 1 END,
      locked_until = CASE WHEN (CASE WHEN last_failed_at IS NOT NULL AND last_failed_at > ? THEN failed_attempts + 1 ELSE 1 END) >= ?
                          THEN ? ELSE locked_until END,
      last_failed_at = ?, updated_at = ?
    WHERE id = ? RETURNING failed_attempts AS attempts, locked_until AS lockedUntil`,
  windowStart, windowStart, maxAttempts, lockUntil, nowIso, nowIso, userId);
}

/**
 * Shadow lockout counters for unknown emails (F-19: persisted, keyed by an HMAC of the email, with expiry),
 * so lockout behavior does not reveal account existence and survives restarts.
 */
export class GhostLockout {
  constructor(db, keyring, { maxAttempts, windowMin }) {
    this.db = db; this.keyring = keyring; this.max = maxAttempts; this.windowMs = windowMin * 60_000;
  }
  key(email) { return hmacHex(this.keyring.current.bidx, `ghost-lockout|${String(email).toLowerCase()}`); }
  isLocked(email) {
    const r = this.db.get('SELECT locked_until FROM auth_ghost_lockouts WHERE key_hash = ?', this.key(email));
    return Boolean(r?.locked_until && Date.parse(r.locked_until) > Date.now());
  }
  fail(email) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const windowStart = new Date(now - this.windowMs).toISOString();
    const lockUntil = new Date(now + this.windowMs).toISOString();
    return this.db.get(`INSERT INTO auth_ghost_lockouts (key_hash, attempts, last_failed_at, locked_until) VALUES (?, 1, ?, NULL)
      ON CONFLICT(key_hash) DO UPDATE SET
        attempts = CASE WHEN last_failed_at > ? THEN attempts + 1 ELSE 1 END,
        locked_until = CASE WHEN (CASE WHEN last_failed_at > ? THEN attempts + 1 ELSE 1 END) >= ? THEN ? ELSE locked_until END,
        last_failed_at = excluded.last_failed_at
      RETURNING attempts, locked_until AS lockedUntil`, this.key(email), nowIso, windowStart, windowStart, this.max, lockUntil);
  }
  purge() {
    const cutoff = new Date(Date.now() - this.windowMs).toISOString();
    return this.db.run('DELETE FROM auth_ghost_lockouts WHERE last_failed_at < ? AND (locked_until IS NULL OR locked_until < ?)', cutoff, new Date().toISOString()).changes;
  }
}
