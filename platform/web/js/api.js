// Fetch wrapper for /api/v1 — same-origin credentials, CSRF header on mutations,
// typed errors, 401 → login, idle-timeout warning at 13 min (server idle timeout 15 min).
import { t, fmtDuration } from './i18n.js';
import { el } from './ui/dom.js';
import { openModal } from './ui/modal.js';

const BASE = '/api/v1';
let csrfToken = null;
const listeners = { unauthorized: new Set(), activity: new Set(), restricted: new Set() };

export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError'; this.status = status; this.code = code || 'ERROR'; this.fields = fields || null;
  }
}
export class AuthError extends ApiError { constructor(...a) { super(...a); this.name = 'AuthError'; } }
export class MfaRequiredError extends ApiError { constructor(...a) { super(...a); this.name = 'MfaRequiredError'; } }
export class ForbiddenError extends ApiError { constructor(...a) { super(...a); this.name = 'ForbiddenError'; } }
export class NotFoundError extends ApiError { constructor(...a) { super(...a); this.name = 'NotFoundError'; } }
export class ValidationError extends ApiError { constructor(...a) { super(...a); this.name = 'ValidationError'; } }
export class ConflictError extends ApiError { constructor(...a) { super(...a); this.name = 'ConflictError'; } }
export class RateLimitError extends ApiError { constructor(...a) { super(...a); this.name = 'RateLimitError'; } }
export class LockedError extends ApiError { constructor(...a) { super(...a); this.name = 'LockedError'; } }
export class HostRejectedError extends ApiError { constructor(...a) { super(...a); this.name = 'HostRejectedError'; } }
export class RestrictedError extends ApiError { constructor(...a) { super(...a); this.name = 'RestrictedError'; } }
export class NetworkError extends ApiError { constructor(msg) { super(0, 'NETWORK', msg); this.name = 'NetworkError'; } }

export function setCsrf(token) { csrfToken = token || null; }
export function on(evt, fn) { listeners[evt].add(fn); return () => listeners[evt].delete(fn); }
function emit(evt, arg) { for (const fn of listeners[evt]) { try { fn(arg); } catch (e) { console.warn(e); } } }

function errorFor(status, body) {
  const e = (body && body.error) || {};
  const args = [status, e.code, e.message, e.fields];
  if (status === 401 && e.code === 'MFA_REQUIRED') return new MfaRequiredError(...args);
  if (status === 401) return new AuthError(...args);
  if (status === 403 && (e.code === 'MFA_ENROLLMENT_REQUIRED' || e.code === 'PASSWORD_CHANGE_REQUIRED')) return new RestrictedError(...args);
  if (status === 403) return new ForbiddenError(...args);
  if (status === 423) return new LockedError(...args);
  if (status === 404) return new NotFoundError(...args);
  if (status === 409) return new ConflictError(...args);
  if (status === 429) return new RateLimitError(...args);
  if (status === 421) return new HostRejectedError(...args);
  if (status === 400 || status === 422) return new ValidationError(...args);
  return new ApiError(...args);
}

/**
 * request('GET', '/patients', { query, body, auth:true, timeoutMs })
 * auth:false → a 401 does not trigger the global "go to login" handler (used by login/me probes).
 */
export async function request(method, path, { query, body, auth = true, timeoutMs = 20000 } = {}) {
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString(); if (s) url += `?${s}`;
  }
  const headers = { Accept: 'application/json' };
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const tmr = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal, cache: 'no-store' });
  } catch (err) {
    throw new NetworkError(err && err.name === 'AbortError' ? t('errors.timeout') : t('errors.network'));
  } finally { clearTimeout(tmr); }
  emit('activity', Date.now());
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (res.status !== 204 && ct.includes('application/json')) { try { data = await res.json(); } catch { data = null; } }
  if (!res.ok) {
    const err = errorFor(res.status, data);
    const ra = Number(res.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
    if (err instanceof AuthError && auth) emit('unauthorized', err);
    if (err instanceof RestrictedError) emit('restricted', err);
    throw err;
  }
  if (data && typeof data.csrfToken === 'string') setCsrf(data.csrfToken);
  return data;
}

export const api = {
  get: (p, query, o = {}) => request('GET', p, { ...o, query }),
  post: (p, body, o = {}) => request('POST', p, { ...o, body: body ?? {} }),
  patch: (p, body, o = {}) => request('PATCH', p, { ...o, body: body ?? {} }),
  put: (p, body, o = {}) => request('PUT', p, { ...o, body: body ?? {} }),
  del: (p, o = {}) => request('DELETE', p, o),
};

/** Accepts either a bare array or the `{items,total}` list envelope. */
export function items(res) { if (Array.isArray(res)) return res; return (res && res.items) || []; }

/** Friendly message for any error (for toasts / inline alerts). */
export function errorMessage(err) {
  if (!err) return t('errors.generic');
  if (err instanceof NetworkError) return err.message;
  if (err instanceof HostRejectedError) return t('errors.hostRejected');
  if (err instanceof RateLimitError && err.code !== 'ACCOUNT_LOCKED') return err.retryAfter ? t('errors.rateLimitedFor', { s: err.retryAfter }) : t('errors.rateLimited');
  const byCode = err.code && t(`errors.codes.${err.code}`);
  if (byCode && byCode !== `errors.codes.${err.code}`) return byCode;
  if (err instanceof ForbiddenError) return t('errors.forbidden');
  if (err instanceof NotFoundError) return t('errors.notFound');
  if (err instanceof RateLimitError) return err.retryAfter ? t('errors.rateLimitedFor', { s: err.retryAfter }) : t('errors.rateLimited');
  if (err instanceof HostRejectedError) return t('errors.hostRejected');
  return err.message || t('errors.generic');
}

// ---------------- idle timeout ----------------
let IDLE_LIMIT_MS = 15 * 60 * 1000;
let IDLE_WARN_MS = IDLE_LIMIT_MS - 2 * 60 * 1000;
/** Server-reported idle timeout (GET /auth/me → session.idleTimeoutSec); warn 2 minutes before. */
export function setIdleTimeout(sec) {
  if (!Number.isFinite(sec) || sec < 180) return;
  IDLE_LIMIT_MS = sec * 1000; IDLE_WARN_MS = IDLE_LIMIT_MS - 2 * 60 * 1000;
}
let lastRequest = Date.now();
let lastUserActivity = Date.now();
let idleTimer = null;
let idleModal = null;
let onExpired = null;

on('activity', (ts) => { lastRequest = ts; });

function markUser() { lastUserActivity = Date.now(); }

export function startIdleWatch(expiredHandler) {
  onExpired = expiredHandler;
  lastRequest = Date.now();
  if (idleTimer) return;
  for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(evt, markUser, { passive: true, capture: true });
  idleTimer = setInterval(checkIdle, 5000);
}
export function stopIdleWatch() {
  clearInterval(idleTimer); idleTimer = null;
  if (idleModal) { idleModal.close(); idleModal = null; }
}

async function keepAlive() {
  try { await request('GET', '/auth/me'); } catch { /* 401 handled globally */ }
}

function checkIdle() {
  const since = Date.now() - lastRequest;
  if (since >= IDLE_LIMIT_MS) { stopIdleWatch(); if (onExpired) onExpired(); return; }
  if (since < IDLE_WARN_MS || idleModal) return;
  // The practitioner is actively working (e.g. handling magnets, typing notes): silently keep the session alive.
  if (Date.now() - lastUserActivity < 90 * 1000) { keepAlive(); return; }
  const countdown = el('strong.idle-countdown', fmtDuration(IDLE_LIMIT_MS - since));
  const tick = setInterval(() => {
    const left = IDLE_LIMIT_MS - (Date.now() - lastRequest);
    countdown.textContent = fmtDuration(left);
    if (left <= 0) clearInterval(tick);
  }, 1000);
  idleModal = openModal({
    title: t('idle.title'),
    icon: 'clock',
    body: el('p', t('idle.body'), ' ', countdown),
    actions: [
      { label: t('idle.signOut'), variant: 'ghost', value: 'out' },
      { label: t('idle.stay'), variant: 'primary', value: 'stay', autofocus: true },
    ],
    dismissible: false,
  });
  idleModal.result.then(async (v) => {
    clearInterval(tick); idleModal = null;
    if (v === 'stay') { await keepAlive(); return; }
    stopIdleWatch(); if (onExpired) onExpired(true);
  });
}
