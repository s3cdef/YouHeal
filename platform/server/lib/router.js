// Tiny router: method + path with `:params`. Routes carry their policy (auth, roles, body limits).

export class Router {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const full = this.prefix + pattern;
    const keys = [];
    const re = new RegExp('^' + full.split('/').map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/') + '/?$');
    this.routes.push({ method: method.toUpperCase(), pattern: full, re, keys, handler, opts });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** Returns {route, params} | {allowed:[methods]} (405) | null (404). */
  match(method, pathname) {
    const allowed = new Set();
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed.add(r.method); continue; }
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch { return null; }
      return { route: r, params };
    }
    return allowed.size ? { allowed: [...allowed] } : null;
  }

  list() { return this.routes.map((r) => `${r.method} ${r.pattern}`); }
}
