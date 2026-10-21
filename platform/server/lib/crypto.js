// Cryptographic primitives (ADR-003, CONTRACT §7). node:crypto only.
//
//  * Master key (32 bytes) -> HKDF-SHA256 subkeys: enc, bidx (blind index), backup, audit, keyid.
//  * Field encryption: AES-256-GCM, 96-bit random IV, optional AAD binding the ciphertext to
//    "<table>.<column>:<rowId>" so ciphertexts cannot be swapped between rows/columns.
//    Format: v1:<keyId>:<iv b64>:<tag b64>:<ct b64>
//  * Blind index: HMAC-SHA256(bidxKey, "<kind>|" + normalized value), hex.
//  * Passwords: scrypt N=2^15 r=8 p=1, 32-byte salt, 32-byte output; params encoded in the hash.

import crypto from 'node:crypto';

const SALT = Buffer.from('youheal-clinical/v1', 'utf8');

export function hkdf(master, info, len = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', master, SALT, Buffer.from(info, 'utf8'), len));
}

export function deriveKeySet(master) {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('master key must be exactly 32 bytes');
  const keyId = crypto.createHash('sha256').update(hkdf(master, 'youheal:key-id')).digest('hex').slice(0, 16);
  return Object.freeze({
    keyId,
    master,
    enc: hkdf(master, 'youheal:field-enc:v1'),
    bidx: hkdf(master, 'youheal:blind-index:v1'),
    backup: hkdf(master, 'youheal:backup:v1'),
    audit: hkdf(master, 'youheal:audit-anchor:v1'),
  });
}

/** Holds the current key set (used for all new encryption) plus retired ones (decrypt only). */
export class Keyring {
  constructor(currentMaster, retiredMasters = []) {
    this.current = deriveKeySet(currentMaster);
    this.sets = new Map([[this.current.keyId, this.current]]);
    for (const m of retiredMasters) {
      const s = deriveKeySet(m);
      if (!this.sets.has(s.keyId)) this.sets.set(s.keyId, s);
    }
  }
  get keyId() { return this.current.keyId; }
  get(keyId) { return this.sets.get(keyId) || null; }
  has(keyId) { return this.sets.has(keyId); }
}

export function parseMasterKey(text) {
  const s = String(text || '').trim();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(s)) throw new Error('master key must be base64');
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length !== 32) throw new Error(`master key must decode to 32 bytes (got ${buf.length})`);
  return buf;
}

export function generateMasterKey() { return crypto.randomBytes(32); }

// ---------------------------------------------------------------- field encryption

export class DecryptError extends Error {
  constructor(msg) { super(msg); this.code = 'DECRYPT_FAILED'; }
}

export function encryptField(keyring, plaintext, aad = '') {
  if (plaintext === null || plaintext === undefined) return null;
  const ks = keyring.current;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ks.enc, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(String(plaintext), 'utf8')), c.final()]);
  return `v1:${ks.keyId}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptField(keyring, value, aad = '') {
  if (value === null || value === undefined) return null;
  const parts = String(value).split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new DecryptError('unsupported ciphertext format');
  const ks = keyring.get(parts[1]);
  if (!ks) throw new DecryptError(`unknown key id ${parts[1]}`);
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new DecryptError('malformed ciphertext');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', ks.enc, iv, { authTagLength: 16 });
    if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(parts[4], 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new DecryptError('ciphertext authentication failed');
  }
}

export const encryptJson = (kr, obj, aad) => (obj === null || obj === undefined ? null : encryptField(kr, JSON.stringify(obj), aad));
export const decryptJson = (kr, v, aad) => { const s = decryptField(kr, v, aad); return s === null ? null : JSON.parse(s); };

export function ciphertextKeyId(value) {
  const parts = String(value || '').split(':');
  return parts.length === 5 && parts[0] === 'v1' ? parts[1] : null;
}

// ---------------------------------------------------------------- blind index

export function normalizeText(v) {
  return String(v ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
export const normalizeMrn = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function blindIndex(keyring, kind, value, keySet = keyring.current) {
  const norm = kind === 'mrn' ? normalizeMrn(value) : normalizeText(value);
  if (!norm) return null;
  return crypto.createHmac('sha256', keySet.bidx).update(`${kind}|${norm}`, 'utf8').digest('hex');
}

// ---------------------------------------------------------------- hashing / tokens

export const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const hmacHex = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const uuid = () => crypto.randomUUID();

/** Constant-time string comparison (lengths are hidden by hashing first). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Canonical JSON: object keys sorted recursively, undefined dropped, no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- passwords (scrypt)

export const SCRYPT_DEFAULTS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, saltLen: 32, keyLen: 32 });

function scryptAsync(pw, salt, keyLen, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, keyLen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password, params = SCRYPT_DEFAULTS) {
  const salt = crypto.randomBytes(params.saltLen);
  const key = await scryptAsync(String(password).normalize('NFKC'), salt, params.keyLen, params);
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function parsePasswordHash(stored) {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
  if (!m) return null;
  const N = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  return { N, r, p, salt: Buffer.from(m[4], 'base64'), key: Buffer.from(m[5], 'base64') };
}

export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const key = await scryptAsync(String(password).normalize('NFKC'), parsed.salt, parsed.key.length, parsed);
  return key.length === parsed.key.length && crypto.timingSafeEqual(key, parsed.key);
}

export function passwordNeedsRehash(stored, params = SCRYPT_DEFAULTS) {
  const p = parsePasswordHash(stored);
  return !p || p.N < params.N || p.r !== params.r || p.p !== params.p || p.salt.length < params.saltLen;
}

// A fixed dummy hash used to equalize timing when the account does not exist.
let dummyHashPromise = null;
export function dummyPasswordHash() {
  dummyHashPromise ||= hashPassword(randomToken(16));
  return dummyHashPromise;
}
