// Application assembly: request pipeline (security headers, request id, rate limit, session, RBAC,
// CSRF/Origin, JSON body) + route modules + static SPA. Used by server/index.js and the tests.

import { randomUUID } from 'node:crypto';
import { Router } from './lib/router.js';
import {
  HttpError, applySecurityHeaders, sendJson, sendError, readJsonBody, parseCookies, serializeCookie,
  clientIp, requestProto, createStaticHandler, forbidden, unauthorized,
} from './lib/http.js';
import { TokenBucket } from './lib/ratelimit.js';
import { checkOrigin, checkCsrfToken } from './lib/csrf.js';
import { createAudit } from './lib/audit.js';
import { createSessionStore, GhostLockout, SESSION_COOKIE } from './lib/auth.js';
import { ValidationError } from './lib/validate.js';
import { DecryptError } from './lib/crypto.js';
import { createCatalogService } from './routes/catalog.js';

import * as healthRoutes from './routes/health.js';
import * as setupRoutes from './routes/setup.js';
import * as authRoutes from './routes/auth.js';
import * as userRoutes from './routes/users.js';
import * as orgRoutes from './routes/org.js';
import * as catalogRoutes from './routes/catalog.js';
import * as patientRoutes from './routes/patients.js';
import * as sessionRoutes from './routes/sessions.js';
import * as auditRoutes from './routes/audit.js';
import * as adminRoutes from './routes/admin.js';

export const RAW = Symbol('raw-response');
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_BODY_LIMIT = 1024 * 1024;

export function createApp({ cfg, db, keyring, log }) {
  const audit = createAudit(db, keyring, log);
  const sessions = createSessionStore(db, cfg);
  const ghost = new GhostLockout(cfg.lockout);
  const limits = {
    api: new TokenBucket({ capacity: cfg.rate.apiBurst, refillPerMin: cfg.rate.apiPerMin }),
    auth: new TokenBucket({ capacity: cfg.rate.authBurst, refillPerMin: cfg.rate.authPerMin }),
  };
  const catalog = createCatalogService(db, { allowedLicenses: cfg.catalogLicenses ? new Set(cfg.catalogLicenses) : null });
  const router = new Router('/api/v1');
  const deps = { cfg, db, keyring, log, audit, sessions, ghost, catalog, RAW };

  for (const mod of [healthRoutes, setupRoutes, authRoutes, userRoutes, orgRoutes, catalogRoutes, patientRoutes, sessionRoutes, auditRoutes, adminRoutes]) {
    mod.register(router, deps);
  }
  const serveStatic = createStaticHandler({ webDir: cfg.webDir, maxAge: cfg.staticMaxAge, log });

  if (cfg.devNoMfa) log.loud('YH_DEV_INSECURE_NO_MFA=1 — admin MFA enforcement is DISABLED (loopback dev only). Never use with real PHI.');

  function restrictionOf(user) {
    if (user.must_change_password) return 'password';
    if (user.role === 'admin' && !user.mfa_enabled && !cfg.devNoMfa) return 'mfa';
    return null;
  }

  async function handleApi(req, res, pathname, search) {
    const ip = req.ip;
    const rl = limits.api.take(ip);
    if (!rl.ok) throw Object.assign(new HttpError(429, 'RATE_LIMITED', 'Too many requests'), { retryAfter: rl.retryAfter });

    const m = router.match(req.method, pathname);
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'Unknown API endpoint');
    if (m.allowed) throw Object.assign(new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'), { allow: m.allowed });
    const { route, params } = m;
    const o = route.opts;
    req.route = route.pattern;

    if (o.rate === 'auth') {
      const r = limits.auth.take(ip);
      if (!r.ok) throw Object.assign(new HttpError(429, 'RATE_LIMITED', 'Too many attempts; slow down'), { retryAfter: r.retryAfter });
    }

    const secure = requestProto(req, cfg) === 'https';
    const ctx = {
      req, res, cfg, db, keyring, params, ip, reqId: req.id, secure,
      query: new URLSearchParams(search || ''),
      user: null, session: null, status: 200, restriction: null,
      setCookie(value, maxAge) {
        res.appendHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, value, { secure, maxAge }));
      },
      audit(action, a = {}) {
        return audit.append({
          orgId: a.orgId ?? ctx.user?.org_id ?? null, actorId: a.actorId ?? ctx.user?.id ?? null,
          actorRole: a.actorRole ?? ctx.user?.role ?? null, action, targetType: a.targetType, targetId: a.targetId,
          outcome: a.outcome, ip, requestId: req.id, detail: a.detail,
        });
      },
    };

    // session
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const found = sessions.lookup(token);
      if (found?.user) {
        ctx.user = found.user; ctx.session = found.session;
        ctx.restriction = restrictionOf(found.user);
      } else {
        if (found?.expired) {
          audit.append({ orgId: found.session.org_id, actorId: found.session.user_id, action: 'auth.session.expired', targetType: 'user', targetId: found.session.user_id, ip, requestId: req.id });
        }
        ctx.setCookie('', 0);
        ctx.staleSession = true;
      }
    }

    if (!o.public) {
      if (!ctx.user) throw unauthorized(ctx.staleSession ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED', ctx.staleSession ? 'Your session has expired' : 'Authentication required');
      if (ctx.restriction && !(o.allowWhen || []).includes(ctx.restriction)) {
        throw ctx.restriction === 'mfa'
          ? forbidden('Administrators must enroll in multi-factor authentication before continuing', 'MFA_ENROLLMENT_REQUIRED')
          : forbidden('You must change your password before continuing', 'PASSWORD_CHANGE_REQUIRED');
      }
      if (o.roles && !o.roles.includes(ctx.user.role)) throw forbidden();
    }

    if (MUTATING.has(req.method)) {
      checkOrigin(req, cfg);
      const needCsrf = o.public ? Boolean(o.csrfIfSession && ctx.session) : o.csrf !== false;
      if (needCsrf) checkCsrfToken(req, ctx.session);
      ctx.body = await readJsonBody(req, o.bodyLimit || DEFAULT_BODY_LIMIT);
    } else if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
      req.resume();
    }

    const result = await route.handler(ctx);
    if (result === RAW) return;
    sendJson(res, ctx.status, result ?? { ok: true });
  }

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    req.id = randomUUID();
    req.ip = clientIp(req, cfg.trustProxy);
    res.req = req;
    res.setHeader('X-Request-Id', req.id);
    applySecurityHeaders(res, { hsts: cfg.tls || (cfg.trustProxy > 0 && requestProto(req, cfg) === 'https') });

    const rawUrl = String(req.url || '/');
    const q = rawUrl.indexOf('?');
    const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    const search = q >= 0 ? rawUrl.slice(q + 1) : '';

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // no query string (may carry search terms), only the route pattern for API calls
      log.info('access', {
        reqId: req.id, method: req.method, path: req.route || (pathname.startsWith('/api/') ? '/api/?' : pathname.slice(0, 200)),
        status: res.statusCode, ms: Math.round(ms * 10) / 10, ip: req.ip,
      });
    });

    try {
      if (!pathname.startsWith('/')) throw new HttpError(400, 'BAD_REQUEST', 'Bad request');
      if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname, search);
      else await serveStatic(req, res, pathname);
    } catch (err) {
      handleError(err, req, res);
    }
  }

  function handleError(err, req, res) {
    let e = err;
    if (err instanceof ValidationError) e = new HttpError(400, 'VALIDATION', err.message, err.fields);
    else if (err instanceof DecryptError) {
      log.error('decryption failure (wrong/missing key or tampered ciphertext)', { reqId: req.id, err: err.message });
      e = new HttpError(500, 'DECRYPT_FAILED', 'Stored data could not be decrypted');
    } else if (!(err instanceof HttpError)) {
      const msg = String(err?.message || '');
      if (/session is finalized and immutable/.test(msg)) e = new HttpError(409, 'SESSION_LOCKED', 'Session is finalized and cannot be modified');
      else {
        log.error('unhandled error', { reqId: req.id, err: msg, stack: err?.stack?.split('\n').slice(0, 6).join(' | ') });
        e = new HttpError(500, 'INTERNAL', 'Internal server error');
      }
    }
    if (e.status === 401 || e.status === 403) res.setHeader('Cache-Control', 'no-store');
    sendError(res, e);
  }

  function purge() {
    const n = sessions.purgeExpired();
    limits.api.prune(); limits.auth.prune();
    return n;
  }

  return { handler, router, audit, sessions, catalog, purge, deps };
}
