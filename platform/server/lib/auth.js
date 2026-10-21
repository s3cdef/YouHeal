// Authentication primitives: password policy (IA-5), server-side sessions (AC-11/AC-12/SC-23),
// MFA recovery codes, account lockout (AC-7).

import crypto from 'node:crypto';
import { randomToken, sha256hex, safeEqual, uuid, normalizeText } from './crypto.js';

export const SESSION_COOKIE = 'yh_sid';

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
// Recovery codes carry ~50 bits of entropy, so a domain-separated SHA-256 is sufficient and keeps them
// valid across master-key rotation (the keyring argument is kept for API stability).
export const hashRecoveryCode = (_keyring, code) => sha256hex(`youheal-recovery|${normalizeRecoveryCode(code)}`);
export const looksLikeRecoveryCode = (c) => /^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(String(c || '').trim());

export function consumeRecoveryCode(keyring, stored, code) {
  const list = JSON.parse(stored || '[]');
  const h = hashRecoveryCode(keyring, code);
  let hit = -1;
  list.forEach((r, i) => { if (!r.used && safeEqual(r.h, h) && hit < 0) hit = i; });
  if (hit < 0) return null;
  list[hit].used = new Date().toISOString();
  return { updated: JSON.stringify(list), remaining: list.filter((r) => !r.used).length };
}

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

/** Shadow lockout counters for unknown emails, so lockout behavior does not reveal account existence. */
export class GhostLockout {
  constructor({ maxAttempts, windowMin }) { this.max = maxAttempts; this.windowMs = windowMin * 60_000; this.map = new Map(); }
  key(email) { return sha256hex(`ghost|${email}`); }
  isLocked(email) {
    const r = this.map.get(this.key(email));
    return Boolean(r && r.lockedUntil && Date.now() < r.lockedUntil);
  }
  fail(email) {
    const k = this.key(email), now = Date.now();
    let r = this.map.get(k);
    if (!r || now - r.last > this.windowMs) r = { count: 0, last: now, lockedUntil: 0 };
    r.count++; r.last = now;
    if (r.count >= this.max) r.lockedUntil = now + this.windowMs;
    this.map.set(k, r);
    if (this.map.size > 20_000) this.map.clear();
  }
}
