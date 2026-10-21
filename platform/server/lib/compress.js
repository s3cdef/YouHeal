// HTTP compression with node:zlib only (Brotli preferred, gzip fallback).
//
// SECURITY — BREACH/CRIME: compressing a response that contains a secret (CSRF token, session-bound value)
// together with attacker-influenced content lets an attacker recover the secret byte-by-byte from compressed
// sizes. Therefore API responses are compressed ONLY for public, non-secret, non-reflective reference data
// (GET /catalog/*, /i18n/* and /health — see COMPRESSIBLE_API in app.js). Never compress /auth/* (carries
// csrfToken), PHI (/patients*, /sessions*, reports, /audit*), or anything else. Static assets are public.

import zlib from 'node:zlib';

export const MIN_COMPRESS_BYTES = 1024;
const COMPRESSIBLE_TYPE = /^(text\/|application\/(json|javascript|manifest\+json|wasm|xml)|image\/svg\+xml|model\/gltf)/;

export const isCompressibleType = (type) => COMPRESSIBLE_TYPE.test(String(type || ''));

/** Pick 'br' | 'gzip' | null from an Accept-Encoding header (honors q=0). */
export function negotiate(acceptEncoding) {
  const prefs = new Map();
  for (const part of String(acceptEncoding || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)).find(Boolean);
    prefs.set(name, q ? Number(q[1]) : 1);
  }
  const ok = (n) => (prefs.has(n) ? prefs.get(n) > 0 : prefs.has('*') && prefs.get('*') > 0);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

export function compressSync(buf, enc, { quality = 5 } = {}) {
  if (enc === 'br') {
    return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
  }
  return zlib.gzipSync(buf, { level: quality >= 9 ? 9 : 6 });
}

export function compressAsync(buf, enc, { quality = 11 } = {}) {
  return new Promise((resolve, reject) => {
    const cb = (err, out) => (err ? reject(err) : resolve(out));
    if (enc === 'br') {
      zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, cb);
    } else zlib.gzip(buf, { level: 9 }, cb);
  });
}

/** Byte-bounded LRU (Map insertion order). */
export class ByteLru {
  constructor(maxBytes) { this.max = maxBytes; this.bytes = 0; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, buf) {
    if (buf.length > this.max / 4) return; // never let one entry dominate
    if (this.map.has(k)) { this.bytes -= this.map.get(k).length; this.map.delete(k); }
    this.map.set(k, buf); this.bytes += buf.length;
    for (const [key, val] of this.map) {
      if (this.bytes <= this.max) break;
      this.map.delete(key); this.bytes -= val.length;
    }
  }
}
