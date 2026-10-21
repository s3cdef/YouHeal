// HTTP plumbing: errors, security headers, JSON bodies, cookies, client IP, static files.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message || code);
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }
}
export const badRequest = (msg, fields) => new HttpError(400, 'VALIDATION', msg || 'Invalid request', fields);
export const unauthorized = (code = 'UNAUTHENTICATED', msg = 'Authentication required') => new HttpError(401, code, msg);
export const forbidden = (msg = 'You do not have permission to perform this action', code = 'FORBIDDEN') => new HttpError(403, code, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (code, msg) => new HttpError(409, code, msg);

// ---------------------------------------------------------------- security headers (CONTRACT §7)

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function applySecurityHeaders(res, { tls = false, hsts = tls } = {}) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

// ---------------------------------------------------------------- responses

export function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', data.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(res.req?.method === 'HEAD' ? undefined : data);
}

export function sendError(res, err) {
  const status = err.status || 500;
  const body = { error: { code: err.code || 'INTERNAL', message: status >= 500 ? 'Internal server error' : err.message } };
  if (err.fields) body.error.fields = err.fields;
  if (res.req?.id) body.error.requestId = res.req.id;
  if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
  if (err.allow) res.setHeader('Allow', err.allow.join(', '));
  if (res.headersSent) { res.destroy(); return; }
  sendJson(res, status, body);
}

// ---------------------------------------------------------------- request bodies

export async function readJsonBody(req, limit) {
  const len = req.headers['content-length'];
  const hasBody = (len !== undefined && len !== '0') || req.headers['transfer-encoding'] !== undefined;
  if (!hasBody) return undefined;
  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  const [mime, ...paramsArr] = ctype.split(';').map((s) => s.trim());
  if (mime !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  const charset = paramsArr.find((p) => p.startsWith('charset='));
  if (charset && !/^charset="?utf-8"?$/.test(charset)) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'charset must be utf-8');
  if (len !== undefined && Number(len) > limit) {
    req.resume();
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new HttpError(400, 'BAD_JSON', 'Body is not valid UTF-8'); }
  try {
    return JSON.parse(text, (k, val) => (k === '__proto__' ? undefined : val));
  } catch { throw new HttpError(400, 'BAD_JSON', 'Body is not valid JSON'); }
}

// ---------------------------------------------------------------- cookies & client info

/**
 * Parse a Cookie header. Duplicate names are recorded in `out[DUPES]` (a Set) so callers can refuse
 * ambiguous session cookies (cookie tossing) instead of picking one arbitrarily.
 */
export const DUPES = Symbol('duplicate-cookie-names');
export function parseCookies(header) {
  const out = {};
  const dupes = new Set();
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    if (Object.prototype.hasOwnProperty.call(out, k)) { dupes.add(k); continue; }
    let val = part.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    try { out[k] = decodeURIComponent(val); } catch { out[k] = val; }
  }
  Object.defineProperty(out, DUPES, { value: dupes, enumerable: false });
  return out;
}

export function serializeCookie(name, value, { secure, maxAge, httpOnly = true, sameSite = 'Strict', path: p = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  if (maxAge === 0) s += '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  return s;
}

const normIp = (ip) => String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

const blockLists = new WeakMap();
function trustedList(cfg) {
  let bl = blockLists.get(cfg);
  if (!bl) {
    bl = new net.BlockList();
    for (const t of cfg.trustedProxies || []) {
      const [ip, bits] = t.split('/');
      const type = net.isIP(ip) === 6 ? 'ipv6' : 'ipv4';
      if (bits !== undefined) bl.addSubnet(ip, Number(bits), type); else bl.addAddress(ip, type);
    }
    blockLists.set(cfg, bl);
  }
  return bl;
}

/** F-09: forwarding headers count only when trust is enabled AND the TCP peer is a configured proxy. */
export function isTrustedPeer(req, cfg) {
  if (!cfg?.trustProxy) return false;
  return isTrustedAddress(req.socket?.remoteAddress, cfg);
}

/** Is this address in YH_TRUSTED_PROXIES (regardless of YH_TRUST_PROXY)? */
export function isTrustedAddress(addr, cfg) {
  const peer = normIp(addr);
  const fam = net.isIP(peer);
  if (!fam) return false;
  return trustedList(cfg).check(peer, fam === 6 ? 'ipv6' : 'ipv4');
}

export function clientIp(req, cfg = {}) {
  const sock = normIp(req.socket?.remoteAddress);
  if (!isTrustedPeer(req, cfg)) return sock;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!xff.length) return sock;
  // The rightmost `trustProxy` hops are our proxies; the client is the one just before them.
  const idx = Math.max(0, xff.length - cfg.trustProxy);
  const ip = normIp(xff[idx] ?? xff[0]);
  return net.isIP(ip) ? ip : sock;
}

/** Rate-limit / connection-cap key: IPv4 address, or the /64 prefix of an IPv6 address. */
export function ipBucketKey(ip) {
  const s = normIp(ip);
  if (net.isIP(s) !== 6) return s;
  let [head, tail] = s.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export function isLoopbackIp(ip) {
  const s = normIp(ip);
  return s === '::1' || /^127\./.test(s);
}

export function requestProto(req, cfg) {
  if (cfg.tls) return 'https';
  if (isTrustedPeer(req, cfg)) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (xfp === 'https' || xfp === 'http') return xfp;
  }
  return 'http';
}

export function expectedOrigin(req, cfg) {
  if (cfg.publicOrigin) return cfg.publicOrigin;
  let host = req.headers.host;
  if (isTrustedPeer(req, cfg) && req.headers['x-forwarded-host']) host = String(req.headers['x-forwarded-host']).split(',')[0].trim();
  return `${requestProto(req, cfg)}://${host}`;
}

/** Hostname part of a Host header value ("[::1]:8080" -> "::1"), lower-cased; null if malformed. */
export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return null;
  const m = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(h) || /^([a-z0-9.-]+)(?::\d{1,5})?$/.exec(h);
  return m ? m[1] : null;
}

/** F-05: DNS-rebinding defense — the Host (and trusted X-Forwarded-Host) must be an allowed name. */
export function hostAllowed(req, cfg) {
  const allowed = cfg.allowedHosts;
  if (!allowed) return true;
  const hn = hostnameOf(req.headers.host);
  if (!hn || !allowed.has(hn)) return false;
  if (isTrustedPeer(req, cfg) && req.headers['x-forwarded-host']) {
    const fh = hostnameOf(String(req.headers['x-forwarded-host']).split(',')[0]);
    if (!fh || !allowed.has(fh)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- static files

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

export function createStaticHandler({ webDir, maxAge = 300, log }) {
  let root = null;
  const getRoot = () => {
    if (root) return root;
    try { root = fs.realpathSync(webDir); } catch { return null; }
    return root;
  };

  const notFoundText = (res, status = 404, msg = 'Not found') => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(msg);
  };

  async function serveFile(req, res, file, st) {
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.setHeader('Cache-Control', ext === '.html' || ext === '.htm' ? 'no-cache' : `public, max-age=${maxAge}, must-revalidate`);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) { res.statusCode = 304; res.end(); return; }
    res.statusCode = 200;
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') { res.end(); return; }
    await new Promise((resolve) => {
      const s = fs.createReadStream(file);
      s.on('error', (e) => { log?.warn('static read error', { err: e }); res.destroy(); resolve(); });
      s.on('end', resolve);
      s.pipe(res);
    });
  }

  return async function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return notFoundText(res, 405, 'Method not allowed');
    }
    const base = getRoot();
    if (!base) return notFoundText(res);
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return notFoundText(res, 400, 'Bad request'); }
    if (decoded.includes('\0') || decoded.includes('\\')) return notFoundText(res, 400, 'Bad request');
    const segs = decoded.split('/').filter(Boolean);
    if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return notFoundText(res, 404);
    let file = path.join(base, ...segs);
    if (decoded.endsWith('/') || segs.length === 0) file = path.join(file, 'index.html');

    const inside = (p) => { const rel = path.relative(base, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    if (!inside(file)) return notFoundText(res, 404);

    let st = null, real = null;
    try {
      real = await fs.promises.realpath(file);
      if (!inside(real)) return notFoundText(res, 404);
      st = await fs.promises.stat(real);
      if (st.isDirectory()) {
        real = path.join(real, 'index.html');
        st = await fs.promises.stat(real);
      }
    } catch { st = null; }

    if (st && st.isFile()) return serveFile(req, res, real, st);

    // SPA fallback: extension-less navigations that accept HTML get index.html
    const accept = String(req.headers.accept || '');
    if (!path.extname(segs.at(-1) || '') && accept.includes('text/html')) {
      const idx = path.join(base, 'index.html');
      try {
        const ist = await fs.promises.stat(idx);
        if (ist.isFile()) return serveFile(req, res, idx, ist);
      } catch { /* fall through */ }
    }
    return notFoundText(res, 404);
  };
}
