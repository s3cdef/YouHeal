// Environment-driven configuration. Pure function of (env, cwd); validates and fails closed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APP_VERSION = '1.0.0';

export class ConfigError extends Error {
  constructor(msg) { super(`Configuration error: ${msg}`); this.code = 'CONFIG'; }
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off', '']);

function bool(env, name, def = false) {
  const v = env[name];
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  throw new ConfigError(`${name} must be a boolean (1/0/true/false), got "${v}"`);
}

function int(env, name, def, min, max) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^\d+$/.test(String(v).trim())) throw new ConfigError(`${name} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

export function isLoopbackHost(h) {
  const s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  return s === 'localhost' || s === '::1' || /^127\./.test(s) || s === '::ffff:127.0.0.1';
}

const LICENSES = ['internal-use', 'licensed', 'public-domain', 'original'];
function parseLicenses(v) {
  if (v === undefined || String(v).trim() === '') return null; // all
  const list = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (const l of list) if (!LICENSES.includes(l)) throw new ConfigError(`YH_CATALOG_LICENSES: unknown license status "${l}"`);
  return list;
}

/** NEW-1: default global connection cap = 75% of the soft open-files limit (Linux /proc), else 1024. */
export function defaultMaxConnections() {
  try {
    const m = /Max open files\s+(\d+|unlimited)/.exec(fs.readFileSync('/proc/self/limits', 'utf8'));
    if (m && m[1] !== 'unlimited') return Math.max(64, Math.floor(Number(m[1]) * 0.75));
  } catch { /* not Linux */ }
  return 1024;
}

export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const resolve = (p, base) => path.resolve(base || cwd, p);

  const dataDir = env.YH_DATA_DIR ? resolve(env.YH_DATA_DIR) : path.join(ROOT_DIR, 'data');
  const host = (env.YH_HOST ?? '127.0.0.1').trim();
  if (!host || !/^[A-Za-z0-9.:_\-[\]]+$/.test(host)) throw new ConfigError('YH_HOST is invalid');

  // TLS: explicit env paths, or auto-detected data/tls/{cert,key}.pem
  let tlsCert = env.YH_TLS_CERT ? resolve(env.YH_TLS_CERT) : null;
  let tlsKey = env.YH_TLS_KEY ? resolve(env.YH_TLS_KEY) : null;
  if (tlsCert || tlsKey) {
    if (!tlsCert || !tlsKey) throw new ConfigError('YH_TLS_CERT and YH_TLS_KEY must be set together');
    for (const f of [tlsCert, tlsKey]) if (!fs.existsSync(f)) throw new ConfigError(`TLS file not found: ${f}`);
  } else {
    const c = path.join(dataDir, 'tls', 'cert.pem'), k = path.join(dataDir, 'tls', 'key.pem');
    if (fs.existsSync(c) && fs.existsSync(k)) { tlsCert = c; tlsKey = k; }
  }
  const tls = Boolean(tlsCert && tlsKey);
  const port = int(env, 'YH_PORT', tls ? 8443 : 8080, 0, 65535);

  let trustProxy = 0;
  if (env.YH_TRUST_PROXY !== undefined) {
    const s = String(env.YH_TRUST_PROXY).trim().toLowerCase();
    if (TRUE.has(s)) trustProxy = 1;
    else if (FALSE.has(s)) trustProxy = 0;
    else if (/^\d+$/.test(s) && Number(s) <= 10) trustProxy = Number(s);
    else throw new ConfigError('YH_TRUST_PROXY must be 0/1/true/false or a hop count (<=10)');
  }

  const logLevel = (env.YH_LOG_LEVEL || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) throw new ConfigError('YH_LOG_LEVEL must be debug|info|warn|error|silent');

  let masterKeyB64 = null;
  if (env.YH_MASTER_KEY !== undefined && env.YH_MASTER_KEY !== '') masterKeyB64 = String(env.YH_MASTER_KEY).trim();
  const keysDir = env.YH_KEYS_DIR ? resolve(env.YH_KEYS_DIR) : path.join(dataDir, 'keys');
  const masterKeyFile = env.YH_MASTER_KEY_FILE ? resolve(env.YH_MASTER_KEY_FILE) : path.join(keysDir, 'master.key');

  let publicOrigin = null;
  if (env.YH_PUBLIC_ORIGIN) {
    try {
      const u = new URL(env.YH_PUBLIC_ORIGIN);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      publicOrigin = u.origin;
    } catch { throw new ConfigError('YH_PUBLIC_ORIGIN must be an absolute http(s) origin'); }
  }
  // Some hosting proxies rewrite the browser's Origin header (GitHub Codespaces forwards it as
  // http://localhost:<port>). Aliases listed here are accepted ONLY from a trusted proxy peer and only when the
  // browser marked the request same-origin (Sec-Fetch-Site) — see checkOrigin().
  const proxyOriginAliases = [];
  for (const raw of String(env.YH_PROXY_ORIGIN_ALIASES || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      proxyOriginAliases.push(u.origin);
    } catch { throw new ConfigError(`YH_PROXY_ORIGIN_ALIASES entry is not an absolute http(s) origin: ${raw}`); }
  }

  const devNoMfa = bool(env, 'YH_DEV_INSECURE_NO_MFA');
  if (devNoMfa && !isLoopbackHost(host)) throw new ConfigError('YH_DEV_INSECURE_NO_MFA=1 is only allowed when YH_HOST is loopback');

  const allowInsecureHttp = bool(env, 'YH_ALLOW_INSECURE_HTTP');
  if (!tls && !isLoopbackHost(host) && trustProxy === 0 && !allowInsecureHttp) {
    throw new ConfigError(`refusing to serve PHI over plain HTTP on non-loopback host ${host}. ` +
      'Provide YH_TLS_CERT/YH_TLS_KEY, run behind a TLS proxy with YH_TRUST_PROXY=1, or set YH_ALLOW_INSECURE_HTTP=1.');
  }

  // F-09: X-Forwarded-* are honored only from these peers (IPs or CIDRs). Default: loopback.
  const warnings = [];
  if (proxyOriginAliases.length && !env.YH_TRUST_PROXY) warnings.push('YH_PROXY_ORIGIN_ALIASES has no effect unless YH_TRUST_PROXY is set');
  // NEW-2: an empty/blank YH_TRUSTED_PROXIES means "unset" (loopback default), never "trust nobody/everybody"
  let trustedProxies = String(env.YH_TRUSTED_PROXIES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!trustedProxies.length) trustedProxies = ['127.0.0.1', '::1'];
  for (const t of trustedProxies) {
    const [ip, bits] = t.split('/');
    if (net.isIP(ip) === 0 || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= (net.isIP(ip) === 4 ? 32 : 128)))) {
      throw new ConfigError(`YH_TRUSTED_PROXIES: invalid address or CIDR "${t}"`);
    }
  }
  if (trustProxy && !trustedProxies.length) throw new ConfigError('YH_TRUST_PROXY is enabled but no trusted proxy addresses are configured');
  for (const t of trustedProxies) {
    if (/^(0\.0\.0\.0\/0|::\/0)$/.test(t)) warnings.push(`YH_TRUSTED_PROXIES contains ${t}: every client can spoof X-Forwarded-For`);
  }
  if (!isLoopbackHost(host) && !env.YH_ALLOWED_HOSTS && !env.YH_PUBLIC_ORIGIN) {
    warnings.push(`listening on ${host} but neither YH_ALLOWED_HOSTS nor YH_PUBLIC_ORIGIN is set: only localhost names, this machine's hostname and its IPs are accepted in the Host header`);
  }
  // F-05: Host header allow-list for /api (localhost names + public origin + YH_ALLOWED_HOSTS + own names when exposed)
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  for (const h of String(env.YH_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (!/^[a-z0-9.:\-[\]]+$/.test(h)) throw new ConfigError(`YH_ALLOWED_HOSTS: invalid host "${h}"`);
    allowedHosts.add(h.replace(/^\[|\]$/g, ''));
  }
  if (publicOrigin) allowedHosts.add(new URL(publicOrigin).hostname.toLowerCase().replace(/^\[|\]$/g, ''));
  if (!isLoopbackHost(host)) {
    const hn = os.hostname().toLowerCase();
    allowedHosts.add(hn);
    allowedHosts.add(hn.split('.')[0]);
    if (host === '0.0.0.0' || host === '::') {
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) allowedHosts.add(a.address.toLowerCase());
    } else allowedHosts.add(host.toLowerCase().replace(/^\[|\]$/g, ''));
  }

  const cfg = {
    version: APP_VERSION,
    rootDir: ROOT_DIR,
    host, port, tls, tlsCert, tlsKey,
    dataDir,
    dbPath: env.YH_DB_PATH ? resolve(env.YH_DB_PATH) : path.join(dataDir, 'db', 'youheal.sqlite'),
    keysDir, masterKeyFile, masterKeyB64,
    backupsDir: path.join(dataDir, 'backups'),
    auditAnchorFile: path.join(dataDir, 'audit-anchor.log'),
    setupTokenFile: path.join(dataDir, 'setup-token'),
    catalogDir: env.YH_CATALOG_DIR ? resolve(env.YH_CATALOG_DIR) : path.join(dataDir, 'catalog'),
    catalogStrict: bool(env, 'YH_CATALOG_STRICT', true),
    // Language packs ship with the app next to the catalog (<app>/data/{catalog,i18n/packs}), so by default they
    // are looked up beside YH_CATALOG_DIR rather than in the runtime data dir (/var/lib/youheal holds no packs).
    i18nDir: env.YH_I18N_DIR ? resolve(env.YH_I18N_DIR)
      : path.join(env.YH_CATALOG_DIR ? path.dirname(resolve(env.YH_CATALOG_DIR)) : dataDir, 'i18n', 'packs'),
    catalogLicenses: parseLicenses(env.YH_CATALOG_LICENSES),
    webDir: env.YH_WEB_DIR ? resolve(env.YH_WEB_DIR) : path.join(ROOT_DIR, 'web'),
    staticMaxAge: int(env, 'YH_STATIC_MAX_AGE', 300, 0, 31536000),
    staticPrecompress: bool(env, 'YH_STATIC_PRECOMPRESS', true),
    trustProxy,
    trustedProxies,
    allowedHosts,
    publicOrigin,
    proxyOriginAliases,
    maxConnections: int(env, 'YH_MAX_CONNECTIONS', defaultMaxConnections(), 1, 1000000),
    maxConnPerIp: int(env, 'YH_MAX_CONN_PER_IP', 64, 1, 100000),
    firstByteMs: int(env, 'YH_FIRST_BYTE_MS', 10000, 50, 600000),
    warnings,
    sessionIdleMin: int(env, 'YH_SESSION_IDLE_MIN', 15, 1, 240),
    sessionAbsHours: int(env, 'YH_SESSION_ABS_HOURS', 12, 1, 72),
    logLevel,
    allowRemoteSetup: bool(env, 'YH_ALLOW_REMOTE_SETUP'),
    devNoMfa,
    allowInsecureHttp,
    rate: {
      authBurst: int(env, 'YH_RATE_AUTH_BURST', 10, 1, 100000),
      authPerMin: int(env, 'YH_RATE_AUTH_PER_MIN', 10, 1, 100000),
      apiBurst: int(env, 'YH_RATE_API_BURST', 300, 1, 1000000),
      apiPerMin: int(env, 'YH_RATE_API_PER_MIN', 600, 1, 1000000),
    },
    lockout: {
      maxAttempts: int(env, 'YH_LOCKOUT_ATTEMPTS', 5, 3, 20),
      windowMin: int(env, 'YH_LOCKOUT_MIN', 15, 1, 1440),
    },
  };
  if (cfg.sessionIdleMin > cfg.sessionAbsHours * 60) throw new ConfigError('YH_SESSION_IDLE_MIN cannot exceed the absolute session lifetime');
  return Object.freeze(cfg);
}
