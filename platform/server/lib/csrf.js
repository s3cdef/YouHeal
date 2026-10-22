// CSRF defenses (CONTRACT §7): per-session token in X-CSRF-Token + SameSite=Strict cookie +
// Origin/Referer (and Sec-Fetch-Site) checks on every state-changing request.

import { forbidden, expectedOrigin, isTrustedPeer } from './http.js';

export const CSRF_HEADER = 'x-csrf-token';

/** Reject cross-site mutations. Requests without Origin/Referer (non-browser clients) still need the CSRF token. */
export function checkOrigin(req, cfg) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw forbidden('Cross-site request blocked', 'BAD_ORIGIN');
  const expected = expectedOrigin(req, cfg);
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === expected) return;
    // Proxy-rewritten Origin (e.g. GitHub Codespaces → http://localhost:<port>): accept a configured alias only from a
    // trusted proxy peer, and only if the browser itself declared the request same-origin.
    const site = req.headers['sec-fetch-site'];
    if (cfg.proxyOriginAliases?.includes(origin) && isTrustedPeer(req, cfg) && (site === 'same-origin' || site === undefined)) return;
    throw forbidden('Request origin not allowed', 'BAD_ORIGIN');
  }
  const ref = req.headers.referer;
  if (ref) {
    let o;
    try { o = new URL(ref).origin; } catch { throw forbidden('Invalid Referer', 'BAD_ORIGIN'); }
    if (o !== expected) throw forbidden('Request origin not allowed', 'BAD_ORIGIN');
  }
}

/** Constant-time comparison of the header token with the session's token. */
export function checkCsrfToken(req, session) {
  const sent = req.headers[CSRF_HEADER];
  if (typeof sent !== 'string' || !session || !constantTimeEqual(sent, session.csrf)) {
    throw forbidden('Missing or invalid CSRF token', 'CSRF');
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
