// Hash router: '#/patients/:id/:tab?' patterns, query string support, per-view cleanup.
const routes = [];
let notFound = null;
let current = null; // { route, params, cleanup }
let beforeEach = null;
let afterEach = null;
let guardLeave = null;

function compile(pattern) {
  const keys = [];
  // single left-to-right pass so capture groups and keys stay in the same order
  const re = pattern.replace(/\/:(\w+)(\?)?/g, (_, k, opt) => { keys.push(k); return opt ? '(?:/([^/]+))?' : '/([^/]+)'; });
  return { re: new RegExp(`^${re}/?$`), keys };
}

/** route('/patients/:id', { view: async (ctx) => cleanupFn?, public, shell, title }) */
export function route(pattern, def) { routes.push({ pattern, ...compile(pattern), ...def }); }
export function setNotFound(def) { notFound = def; }
export function setHooks({ before, after }) { beforeEach = before; afterEach = after; }

/** A view can register a leave guard (e.g. unsaved edits). Return false to stay. */
export function setLeaveGuard(fn) { guardLeave = fn; }

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) { resolve(); return; }
  if (replace) { history.replaceState(null, '', target); resolve(); } else location.hash = target;
}

export function currentPath() { return parseHash().path; }

let resolving = Promise.resolve();
let lastHash = null;

async function resolve() {
  const { path, query } = parseHash();
  if (guardLeave && lastHash !== null && location.hash !== lastHash) {
    const ok = await guardLeave();
    if (ok === false) { history.replaceState(null, '', lastHash); return; }
  }
  guardLeave = null;
  let match = null; let params = {};
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) { match = r; r.keys.forEach((k, i) => { params[k] = m[i + 1] ? decodeURIComponent(m[i + 1]) : undefined; }); break; }
  }
  if (!match) { match = notFound; params = {}; }
  const ctx = { path, query, params, route: match };
  if (beforeEach) {
    const redirect = await beforeEach(ctx);
    if (redirect && redirect !== path) { navigate(redirect, { replace: true }); return; }
  }
  if (current && typeof current.cleanup === 'function') { try { current.cleanup(); } catch (e) { console.warn(e); } }
  current = { route: match, params, cleanup: null };
  lastHash = location.hash || '#/';
  const cleanup = await match.view(ctx);
  if (current && current.route === match) current.cleanup = cleanup;
  if (afterEach) afterEach(ctx);
}

export function reload() { resolving = resolving.then(resolve, resolve); return resolving; }

export function startRouter() {
  window.addEventListener('hashchange', () => { resolving = resolving.then(resolve, resolve); });
  return reload();
}
