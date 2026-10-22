// RFC 4648 base32 + RFC 4226 HOTP + RFC 6238 TOTP (SHA-1, 30 s, 6 digits by default).

import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf, { padding = true } = {}) {
  const bytes = Buffer.from(buf);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  if (padding) while (out.length % 8) out += '=';
  return out;
}

export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(secret, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm, secret).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (nowMs = Date.now(), period = 30) => Math.floor(nowMs / 1000 / period);

export function totp(secret, { time = Date.now(), period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  return hotp(secret, timeStep(time, period), { digits, algorithm });
}

/**
 * Verify a TOTP code within ±window steps. Returns the matched step (number) or null.
 * Replay protection: any step <= lastStep is rejected (caller persists the returned step).
 */
export function verifyTotp(secret, code, { time = Date.now(), window = 1, lastStep = null, period = 30, digits = 6 } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(c)) return null;
  const now = timeStep(time, period);
  let matched = null;
  for (let w = -window; w <= window; w++) {
    const step = now + w;
    if (step < 0) continue;
    const cand = hotp(secret, step, { digits });
    // constant-time compare per candidate; keep looping to avoid early-exit timing differences
    if (crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(c)) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (lastStep !== null && lastStep !== undefined && matched <= Number(lastStep)) return null;
  return matched;
}

export const generateSecret = (bytes = 20) => crypto.randomBytes(bytes);

export function otpauthUrl({ secret, account, issuer = 'YOU HEAL Clinical' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: base32Encode(secret, { padding: false }), issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, '%20')}`;
}
