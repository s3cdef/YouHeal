// Test helpers: temp dirs, ephemeral server, cookie/CSRF-aware JSON client.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/lib/config.js';
import { createLogger } from '../../server/lib/log.js';
import { startServer } from '../../server/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'data', 'catalog', 'fixtures');
export const silent = createLogger({ level: 'silent' });

export function tmpDir(prefix = 'yh-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyFixtures(dest = tmpDir('yh-cat-')) {
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(dest, f));
  return dest;
}

/** A tiny web root so static tests do not depend on the frontend team's files. */
export function makeWebDir() {
  const dir = tmpDir('yh-web-');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>YOU HEAL</title><script type="module" src="/js/app.js"></script>');
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(dir, 'js', 'mod.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(dir, 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  fs.writeFileSync(path.join(dir, 'body.glb'), Buffer.from('glTF'));
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  return dir;
}

export async function startTestServer(overrides = {}) {
  const dataDir = tmpDir('yh-data-');
  const env = {
    YH_DATA_DIR: dataDir,
    YH_CATALOG_DIR: FIXTURES,
    YH_WEB_DIR: makeWebDir(),
    YH_HOST: '127.0.0.1',
    YH_PORT: '0',
    YH_LOG_LEVEL: 'silent',
    YH_RATE_AUTH_BURST: '1000',
    YH_RATE_AUTH_PER_MIN: '1000',
    YH_RATE_API_BURST: '100000',
    YH_RATE_API_PER_MIN: '100000',
    ...overrides,
  };
  const cfg = loadConfig(env);
  const srv = await startServer(cfg, { log: silent });
  return { ...srv, dataDir, env };
}

/** The one-time first-run token (F-04) the server wrote to <data>/setup-token. */
export const setupToken = (srv) => fs.readFileSync(path.join(srv.dataDir, 'setup-token'), 'utf8').trim();

export class Client {
  constructor(base) { this.base = base; this.cookie = null; this.csrf = null; }

  async req(method, p, { body, headers = {}, csrf = true, rawBody } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (csrf && this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    let payload = rawBody;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + p, { method, headers: h, body: payload, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const m = /^((?:__Host-)?yh_sid)=([^;]*)/.exec(c);
      if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* ignore */ } }
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: res.status, headers: res.headers, json, buf, setCookies };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, body, o = {}) { return this.req('POST', p, { ...o, body }); }
  patch(p, body, o = {}) { return this.req('PATCH', p, { ...o, body }); }
  put(p, body, o = {}) { return this.req('PUT', p, { ...o, body }); }
  del(p, o) { return this.req('DELETE', p, o); }
}
