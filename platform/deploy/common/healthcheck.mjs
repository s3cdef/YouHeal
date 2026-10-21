#!/usr/bin/env node
// YOU HEAL Clinical — liveness/readiness probe (zero dependencies, Node >= 22).
//
// Used by: Docker HEALTHCHECK, deploy/linux/*.sh, deploy/windows/*.ps1.
// Exit codes: 0 = healthy (HTTP 200 and body.status === "ok"), 1 = unhealthy, 2 = usage error.
//
// Target resolution (first match wins):
//   --url <url>                     explicit URL (e.g. https://127.0.0.1:8443/api/v1/health)
//   YH_HEALTH_URL                   same, from the environment
//   derived from YH_HOST / YH_PORT / YH_TLS_CERT (https when a certificate is configured)
//
// TLS verification: this is a *loopback liveness* probe, not a trust decision. If --ca <file>
// (or YH_HEALTH_CA; the installers pass the self-signed server certificate) is readable it is
// used as the trust anchor and the server name is checked against "localhost"; otherwise
// verification is relaxed ONLY when the target host is a loopback address. Remote targets
// always verify against the system trust store.
//
// Usage: node healthcheck.mjs [--url URL] [--ca FILE] [--timeout MS] [--retries N] [--interval MS] [--quiet]

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const argv = process.argv.slice(2);
const opt = { timeout: 5000, retries: 1, interval: 2000, quiet: false, url: '', ca: '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => { if (i + 1 >= argv.length) usage(`missing value for ${a}`); return argv[++i]; };
  switch (a) {
    case '--url': opt.url = next(); break;
    case '--ca': opt.ca = next(); break;
    case '--timeout': opt.timeout = Number(next()); break;
    case '--retries': opt.retries = Number(next()); break;
    case '--interval': opt.interval = Number(next()); break;
    case '--quiet': case '-q': opt.quiet = true; break;
    case '--help': case '-h':
      process.stdout.write('Usage: node healthcheck.mjs [--url URL] [--ca FILE] [--timeout MS] [--retries N] [--interval MS] [--quiet]\n');
      process.exit(0);
      break;
    default: usage(`unknown argument: ${a}`);
  }
}
function usage(msg) { process.stderr.write(`healthcheck: ${msg}\n`); process.exit(2); }

const env = process.env;
function deriveUrl() {
  if (opt.url) return opt.url;
  if (env.YH_HEALTH_URL) return env.YH_HEALTH_URL;
  const port = env.YH_PORT || '8443';
  let host = env.YH_HOST || '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '' || host === '*') host = '127.0.0.1';
  const tls = Boolean(env.YH_TLS_CERT && env.YH_TLS_KEY) || env.YH_HEALTH_SCHEME === 'https';
  const scheme = env.YH_HEALTH_SCHEME || (tls ? 'https' : 'http');
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${h}:${port}/api/v1/health`;
}

const url = new URL(deriveUrl());
const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i.test(url.hostname);
const caFile = opt.ca || env.YH_HEALTH_CA || '';
let ca;
if (caFile) {
  try { ca = fs.readFileSync(caFile); } catch { ca = undefined; }
}

function probe() {
  return new Promise((resolve) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      timeout: opt.timeout,
      headers: { accept: 'application/json', 'user-agent': 'youheal-healthcheck/1' },
      ...(url.protocol === 'https:' ? {
        ca,
        servername: ca ? 'localhost' : undefined,
        rejectUnauthorized: ca ? true : !loopback,
      } : {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not JSON */ }
        const ok = res.statusCode === 200 && parsed && parsed.status === 'ok';
        resolve({ ok, detail: ok ? `ok version=${parsed.version ?? '?'} catalog=${parsed.catalogVersion ?? '?'}` : `HTTP ${res.statusCode}` });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${opt.timeout} ms`)); });
    req.on('error', (e) => resolve({ ok: false, detail: e.code || e.message }));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = { ok: false, detail: 'not attempted' };
for (let attempt = 1; attempt <= Math.max(1, opt.retries); attempt++) {
  last = await probe();
  if (last.ok) break;
  if (attempt < opt.retries) await sleep(opt.interval);
}
if (!opt.quiet) {
  (last.ok ? process.stdout : process.stderr).write(`healthcheck ${url.href}: ${last.ok ? 'HEALTHY' : 'UNHEALTHY'} (${last.detail})\n`);
}
process.exit(last.ok ? 0 : 1);
