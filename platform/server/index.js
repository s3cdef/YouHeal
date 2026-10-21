// YOU HEAL Clinical — server bootstrap (HTTP/HTTPS, graceful shutdown, housekeeping timers).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError, isLoopbackHost } from './lib/config.js';
import { ipBucketKey, isTrustedAddress } from './lib/http.js';
import { ensureSetupToken } from './routes/setup.js';
import { createLogger } from './lib/log.js';
import { loadKeyring, ensureDir } from './lib/keys.js';
import { openDb, migrate } from './lib/db.js';
import { loadCatalog, CatalogError } from './catalog/load.js';
import { createApp } from './app.js';

export function pidFile(cfg) { return path.join(path.dirname(cfg.dbPath), 'server.pid'); }

export function isServerRunning(cfg) {
  try {
    const pid = Number(fs.readFileSync(pidFile(cfg), 'utf8').trim());
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return pid;
  } catch { return false; }
}

/** Open DB, migrate, load catalog. Shared by the server and CLIs. */
export function bootstrap(cfg, log, { loadCatalogFiles = true } = {}) {
  ensureDir(cfg.dataDir);
  ensureDir(path.dirname(cfg.dbPath));
  ensureDir(cfg.backupsDir);
  const { keyring, source } = loadKeyring(cfg, log);
  const db = openDb(cfg.dbPath, { log });
  migrate(db, { log });
  if (loadCatalogFiles) {
    if (fs.existsSync(path.join(cfg.catalogDir, 'pairs.json'))) {
      try {
        loadCatalog(db, { dir: cfg.catalogDir, log, strict: cfg.catalogStrict });
      } catch (e) {
        if (!(e instanceof CatalogError)) throw e;
        log.error('catalog load FAILED — keeping the previously loaded catalog', { errors: e.errors.slice(0, 25), count: e.errors.length });
      }
    } else {
      log.warn('no catalog found (pairs.json missing); catalog endpoints will be empty', { file: cfg.catalogDir });
    }
  }
  return { db, keyring, keySource: source };
}

const OVER_CAP_RESPONSE = 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nContent-Type: text/plain\r\nContent-Length: 19\r\nConnection: close\r\n\r\nService Unavailable';

/**
 * F-20 / NEW-1: connection hygiene.
 *  - first-byte timeout: a socket must deliver a complete request head within YH_FIRST_BYTE_MS, else it is
 *    destroyed (idle zero-byte sockets can no longer pin the caps); cleared on its first 'request'
 *  - global cap (YH_MAX_CONNECTIONS) and per-client cap (YH_MAX_CONN_PER_IP, IPv6 per /64); trusted proxy
 *    peers (YH_TRUSTED_PROXIES, when YH_TRUST_PROXY is on) are exempt from the per-client cap
 *  - over cap: plain-HTTP clients get a minimal 503 + Retry-After (TLS sockets are closed)
 */
export function limitConnections(server, cfg, log) {
  server.maxConnections = cfg.maxConnections + 64; // hard backstop above our own (polite) cap
  const perIp = new Map();
  const pending = new Map(); // "addr|port" -> first-byte timer
  let total = 0;
  const reject = (socket, why, key) => {
    log.warn('connection cap reached; refusing connection', { ip: key, event: why });
    if (cfg.tls) { socket.destroy(); return; }
    socket.end(OVER_CAP_RESPONSE);
    setTimeout(() => socket.destroy(), 1000).unref();
  };
  server.on('connection', (socket) => {
    const key = ipBucketKey(socket.remoteAddress);
    if (total >= cfg.maxConnections) return reject(socket, 'global', key);
    const exempt = Boolean(cfg.trustProxy) && isTrustedAddress(socket.remoteAddress, cfg);
    const n = (perIp.get(key) || 0) + 1;
    if (!exempt && n > cfg.maxConnPerIp) return reject(socket, 'per-ip', key);
    total++;
    perIp.set(key, n);
    const id = `${socket.remoteAddress}|${socket.remotePort}`;
    const timer = setTimeout(() => { pending.delete(id); socket.destroy(); }, cfg.firstByteMs);
    timer.unref();
    pending.set(id, timer);
    socket.once('close', () => {
      total--;
      const t = pending.get(id); if (t) { clearTimeout(t); pending.delete(id); }
      const m = (perIp.get(key) || 1) - 1; if (m <= 0) perIp.delete(key); else perIp.set(key, m);
    });
  });
  server.on('request', (req) => {
    const id = `${req.socket.remoteAddress}|${req.socket.remotePort}`;
    const t = pending.get(id);
    if (t) { clearTimeout(t); pending.delete(id); }
  });
  return { perIp, pending, get total() { return total; } };
}

export async function startServer(cfg, { log = createLogger({ level: cfg.logLevel }), handleSignals = false, writePid = false } = {}) {
  const { db, keyring } = bootstrap(cfg, log);
  for (const w of cfg.warnings || []) log.warn(`configuration: ${w}`);
  ensureSetupToken(cfg, db, log); // F-04: one-time token while unconfigured (no-op otherwise)
  if (cfg.trustProxy && !isLoopbackHost(cfg.host)) {
    log.loud(`YH_TRUST_PROXY is set while listening on ${cfg.host}: X-Forwarded-* is honored ONLY from ${cfg.trustedProxies.join(', ')} ` +
      '(YH_TRUSTED_PROXIES). Make sure clients cannot reach this port directly.');
  }
  const app = createApp({ cfg, db, keyring, log });

  const server = cfg.tls
    ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey), minVersion: 'TLSv1.2' }, app.handler)
    : http.createServer(app.handler);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  limitConnections(server, cfg, log);
  server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
  });
  const addr = server.address();
  const hostForUrl = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  const url = `${cfg.tls ? 'https' : 'http'}://${hostForUrl}:${addr.port}`;
  log.info('YOU HEAL Clinical listening', { url, tls: cfg.tls, version: cfg.version, dataDir: cfg.dataDir });
  if (!cfg.tls) log.warn('serving plain HTTP — use TLS (YH_TLS_CERT/YH_TLS_KEY) or a TLS-terminating proxy for any non-local access');
  if (writePid) fs.writeFileSync(pidFile(cfg), String(process.pid), { mode: 0o600 });

  const timers = [
    setInterval(() => { try { const n = app.purge(); if (n) log.debug('expired sessions purged', { count: n }); } catch (e) { log.warn('purge failed', { err: e }); } }, 60_000),
    setInterval(() => db.checkpoint('PASSIVE'), 5 * 60_000),
  ];
  timers.forEach((t) => t.unref());

  let closing = null;
  function close(signal) {
    if (closing) return closing;
    closing = (async () => {
      if (signal) log.info('shutting down', { signal });
      timers.forEach(clearInterval);
      const force = setTimeout(() => server.closeAllConnections?.(), 10_000);
      force.unref();
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      clearTimeout(force);
      try { app.audit.writeHead(); } catch (e) { log.warn('audit anchor export failed', { err: e.message }); }
      db.checkpoint('TRUNCATE');
      db.close();
      if (writePid) fs.rmSync(pidFile(cfg), { force: true });
      log.info('shutdown complete');
    })();
    return closing;
  }

  if (handleSignals) {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => { close(sig).then(() => process.exit(0), () => process.exit(1)); });
    }
  }
  return { server, app, db, keyring, cfg, url, close, log };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.umask(0o077);
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
  const log = createLogger({ level: cfg.logLevel });
  const running = isServerRunning(cfg);
  if (running) { log.error('another server instance appears to be running', { count: running }); process.exit(1); }
  startServer(cfg, { log, handleSignals: true, writePid: true }).catch((e) => {
    log.error('startup failed', { err: e.message, errCode: e.code });
    process.exit(1);
  });
}
