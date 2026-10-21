// YOU HEAL Clinical — SPA bootstrap.
import { el, mount, clear } from './ui/dom.js';
import { icon, brandMark } from './ui/icons.js';
import { api, on as onApi, setCsrf, startIdleWatch, stopIdleWatch, AuthError } from './api.js';
import { initI18n, setLocale, getLocale, detectLocale, t, onLocaleChange } from './i18n.js';
import { route, setNotFound, setHooks, startRouter, navigate, reload, currentPath } from './router.js';
import { state, can, clearCatalogCache, polarity } from './state.js';
import { toast } from './ui/toast.js';
import { segmented } from './ui/components.js';
import { applyTheme, getTheme, focusTitle, rememberRoute, lastRoute, initials } from './views/common.js';

const app = document.getElementById('app');
let setupStatus = null;
let shellEls = null;
let pendingNotice = null;

// ---------------- session ----------------
export async function refreshMe() {
  try {
    const me = await api.get('/auth/me', null, { auth: false });
    state.user = me.user; state.org = me.org || null;
    if (me.csrfToken) setCsrf(me.csrfToken);
    return true;
  } catch (err) {
    if (err instanceof AuthError) { state.user = null; return false; }
    throw err;
  }
}

export async function afterLogin() {
  await refreshMe();
  if (state.user && state.user.locale && state.user.locale !== getLocale()) await setLocale(state.user.locale);
  if (state.user && state.user.theme) applyTheme(state.user.theme);
  applyPolarityVars();
  startIdleWatch(onIdleExpired);
  shellEls = null;
}

export async function signOut({ expired = false } = {}) {
  try { await api.post('/auth/logout', {}, { auth: false }); } catch { /* ignore */ }
  state.user = null; state.org = null; setCsrf(null); stopIdleWatch(); clearCatalogCache();
  shellEls = null;
  pendingNotice = expired ? t('auth.sessionExpired') : t('auth.signedOut');
  navigate('/login');
}
export function takeNotice() { const n = pendingNotice; pendingNotice = null; return n; }

export function applyPolarityVars() {
  const p = polarity();
  document.documentElement.style.setProperty('--pol-neg', p.negative);
  document.documentElement.style.setProperty('--pol-pos', p.positive);
}

function onIdleExpired() { signOut({ expired: true }); }

onApi('unauthorized', () => {
  if (!state.user) return;
  state.user = null; stopIdleWatch(); shellEls = null;
  pendingNotice = t('auth.sessionExpired');
  rememberRoute(currentPath());
  navigate('/login');
});

// ---------------- shell ----------------
const NAV = [
  { id: 'dashboard', href: '#/', icon: 'home', label: 'nav.dashboard', show: () => true },
  { id: 'patients', href: '#/patients', icon: 'users', label: 'nav.patients', show: () => can.patients() || can.reports() },
  { id: 'catalog', href: '#/catalog', icon: 'book', label: 'nav.catalog', show: () => true },
  { id: 'settings', href: '#/settings', icon: 'settings', label: 'nav.settings', show: () => true },
];

function themeIcon(th) { return th === 'dark' ? 'moon' : th === 'light' ? 'sun' : 'monitor'; }

function buildShell() {
  const nav = el('nav.side-nav', { aria: { label: t('nav.primary') } },
    el('ul', NAV.filter((n) => n.show()).map((n) => el('li', el('a.nav-link', { href: n.href, data: { nav: n.id } }, icon(n.icon, { size: 20 }), el('span.nav-label', t(n.label)))))));
  const themeBtn = el('button.icon-btn.side-theme', { type: 'button', aria: { label: t('settings.theme') }, title: t(`theme.${getTheme()}`) }, icon(themeIcon(getTheme())));
  themeBtn.addEventListener('click', () => {
    const order = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(getTheme()) + 1) % order.length];
    applyTheme(next);
    api.patch('/auth/prefs', { theme: next }).catch(() => {});
    clear(themeBtn).append(icon(themeIcon(next)));
    themeBtn.title = t(`theme.${next}`);
    toast(t('settings.themeSet', { theme: t(`theme.${next}`) }), { tone: 'info', timeout: 2000 });
  });
  const locSwitch = segmented({
    name: 'locale', label: t('settings.language'), value: getLocale(), size: 'xs',
    options: [{ value: 'en', label: 'EN', title: 'English' }, { value: 'es', label: 'ES', title: 'Español' }],
    onChange: async (v) => {
      await setLocale(v);
      api.patch('/auth/prefs', { locale: v }).catch(() => {});
    },
  });
  const user = state.user || {};
  const side = el('aside.sidebar', { aria: { label: t('nav.sidebar') } },
    el('a.brand', { href: '#/', aria: { label: t('app.homeLabel') } }, brandMark(30),
      el('span.brand-text', el('span.brand-name', 'YOU HEAL'), el('span.brand-sub', t('app.clinical')))),
    nav,
    el('div.side-foot',
      el('div.side-prefs', locSwitch, themeBtn),
      el('div.side-user',
        el('span.avatar.avatar-sm', { aria: { hidden: 'true' } }, initials({ name: user.name })),
        el('div.side-user-text', el('span.side-user-name', user.name || user.email || ''), el('span.side-user-role', user.role ? t(`roles.${user.role}`) : '')),
        el('button.icon-btn', { type: 'button', aria: { label: t('auth.signOut') }, title: t('auth.signOut'), onClick: () => signOut() }, icon('logout')),
      ),
      state.org && state.org.name ? el('p.side-org', state.org.name) : null,
    ),
  );
  const main = el('main#main.main', { tabindex: '-1' });
  const shell = el('div.shell', side, el('div.main-col', main));
  mount(app, shell);
  shellEls = { shell, main, nav };
}

function setActiveNav(id) {
  if (!shellEls) return;
  for (const a of shellEls.nav.querySelectorAll('.nav-link')) {
    const on = a.dataset.nav === id;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function layoutFor(r, layout) {
  if (layout === 'auth') {
    shellEls = null;
    const main = el('main#main.auth-main', { tabindex: '-1' });
    mount(app, el('div.auth-layout',
      el('div.auth-art', { aria: { hidden: 'true' } }, fieldArt(), el('div.auth-art-text', brandMark(44), el('p.auth-art-name', 'YOU HEAL'), el('p.auth-art-sub', t('app.clinical')), el('p.auth-art-tag', t('auth.tagline')))),
      main));
    return main;
  }
  if (!shellEls || !shellEls.shell.isConnected) buildShell();
  shellEls.shell.classList.toggle('is-compact', !!r.compact);
  setActiveNav(r.nav);
  clear(shellEls.main);
  return shellEls.main;
}

function fieldArt() {
  // decorative field lines, drawn with SVG (no images)
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 400 600'); svg.setAttribute('class', 'field-art'); svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  for (let i = 1; i <= 9; i++) {
    const p = document.createElementNS(ns, 'path');
    const k = i * 22;
    p.setAttribute('d', `M120 300C120 ${300 - k * 1.6} 280 ${300 - k * 1.6} 280 300C280 ${300 + k * 1.6} 120 ${300 + k * 1.6} 120 300`);
    p.setAttribute('class', 'field-line'); p.style.opacity = String(0.55 - i * 0.045);
    svg.append(p);
  }
  for (const [cx, cls] of [[120, 'field-neg'], [280, 'field-pos']]) {
    const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', 300); c.setAttribute('r', 7); c.setAttribute('class', cls); svg.append(c);
  }
  return svg;
}

// ---------------- routes ----------------
function view(loader, fnName, opts = {}) {
  return {
    ...opts,
    async view(ctx) {
      const main = layoutFor(opts, opts.layout || 'app');
      document.title = t('app.title');
      let mod;
      try { mod = await loader(); } catch (err) {
        console.error(err);
        main.append(el('p.page-error', t('errors.viewLoad')));
        return null;
      }
      const cleanup = await mod[fnName]({ ...ctx, main });
      requestAnimationFrame(() => focusTitle(main));
      return cleanup;
    },
  };
}

route('/setup', view(() => import('./views/auth.js'), 'renderSetup', { public: true, layout: 'auth' }));
route('/login', view(() => import('./views/auth.js'), 'renderLogin', { public: true, layout: 'auth' }));
route('/mfa', view(() => import('./views/auth.js'), 'renderMfaEnroll', { layout: 'auth', allowWithoutMfa: true }));
route('/', view(() => import('./views/dashboard.js'), 'renderDashboard', { nav: 'dashboard' }));
route('/patients', view(() => import('./views/patients.js'), 'renderPatientList', { nav: 'patients' }));
route('/patients/new', view(() => import('./views/patients.js'), 'renderPatientForm', { nav: 'patients' }));
route('/patients/:id/edit', view(() => import('./views/patients.js'), 'renderPatientForm', { nav: 'patients' }));
route('/patients/:id/:tab?', view(() => import('./views/chart.js'), 'renderChart', { nav: 'patients' }));
route('/sessions/:id', view(() => import('./views/scan.js'), 'renderScan', { nav: 'patients', compact: true }));
route('/sessions/:id/report', view(() => import('./views/report.js'), 'renderReport', { nav: 'patients' }));
route('/catalog/protocols/:id/card', view(() => import('./views/catalog.js'), 'renderProtocolCard', { nav: 'catalog' }));
route('/catalog/:tab?', view(() => import('./views/catalog.js'), 'renderCatalog', { nav: 'catalog' }));
route('/settings/:tab?', view(() => import('./views/settings.js'), 'renderSettings', { nav: 'settings' }));
setNotFound(view(() => import('./views/dashboard.js'), 'renderNotFound', {}));

setHooks({
  async before(ctx) {
    const r = ctx.route || {};
    if (setupStatus && setupStatus.needsSetup) {
      // re-check in case setup just completed
      if (ctx.path !== '/setup') {
        try { setupStatus = await api.get('/setup/status', null, { auth: false }); } catch { /* keep */ }
        if (setupStatus.needsSetup) return '/setup';
      }
      return null;
    }
    if (ctx.path === '/setup') return state.user ? '/' : '/login';
    if (r.public) return state.user && ctx.path === '/login' ? '/' : null;
    if (!state.user) { rememberRoute(ctx.path); return '/login'; }
    // CONTRACT §7: admins MUST enroll MFA.
    if (state.user.role === 'admin' && !state.user.mfaEnabled && !r.allowWithoutMfa) return '/mfa';
    return null;
  },
  after(ctx) {
    if (!ctx.route || !ctx.route.public) rememberRoute(ctx.path);
    window.scrollTo(0, 0);
  },
});

onLocaleChange(() => { shellEls = null; reload(); });

// skip link (hash routing: intercept and focus <main>)
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.skip-link');
  if (!a) return;
  e.preventDefault();
  const m = document.getElementById('main');
  if (m) m.focus();
});

window.addEventListener('unhandledrejection', (e) => { console.error('Unhandled', e.reason); });

async function boot() {
  applyTheme(getTheme());
  await initI18n(detectLocale());
  try {
    setupStatus = await api.get('/setup/status', null, { auth: false });
  } catch (err) {
    mount(app, el('div.boot-error', el('h1', t('errors.serverUnreachable')), el('p', t('errors.serverUnreachableBody')),
      el('button.btn.btn-primary', { type: 'button', onClick: () => location.reload() }, t('common.retry'))));
    return;
  }
  if (!setupStatus.needsSetup) {
    const ok = await refreshMe().catch(() => false);
    if (ok) await afterLogin();
  }
  if (!location.hash) {
    const lr = state.user ? lastRoute() : null;
    history.replaceState(null, '', `#${lr || '/'}`);
  }
  await startRouter();
}

export function goAfterLogin() {
  const lr = lastRoute();
  navigate(lr && lr !== '/login' ? lr : '/');
}

boot();
