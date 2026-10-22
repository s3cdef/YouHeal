// YOU HEAL Clinical — SPA bootstrap.
import { el, mount, clear, mark } from './ui/dom.js';
import { icon, brandMark } from './ui/icons.js';
import { api, on as onApi, setCsrf, startIdleWatch, stopIdleWatch, setIdleTimeout, AuthError } from './api.js';
import { initI18n, setLocale, getLocale, t, onLocaleChange, ensureLocale } from './i18n.js';
import { route, setNotFound, setHooks, startRouter, navigate, reload, currentPath } from './router.js';
import { state, can, clearCatalogCache, polarity, loadCore } from './state.js';
import { toast } from './ui/toast.js';
import { languagePicker } from './ui/components.js';
import { applyTheme, getTheme, focusTitle, rememberRoute, lastRoute, initials } from './views/common.js';

const app = document.getElementById('app');
let setupStatus = null;
let shellEls = null;
let pendingNotice = null;

// ---------------- session ----------------
export async function refreshMe() {
  try {
    const me = await api.get('/auth/me', null, { auth: false });
    applyMe(me);
    return true;
  } catch (err) {
    if (err instanceof AuthError) { state.user = null; return false; }
    throw err;
  }
}

/** Apply a /auth/me (or /auth/login) payload. */
export function applyMe(me) {
  state.user = me.user; state.org = me.org || null;
  if (me.csrfToken) setCsrf(me.csrfToken);
  state.restriction = me.passwordChangeRequired || (me.user && me.user.mustChangePassword) ? 'password'
    : me.mfaEnrollmentRequired ? 'mfa' : null;
  if (me.session && me.session.idleTimeoutSec) setIdleTimeout(me.session.idleTimeoutSec);
  state.recoveryRegen = !!me.recoveryCodesRegenerationRequired;
  renderShellBanner();
}

// ---------------- persistent "regenerate recovery codes" banner (dismissible per page load) ----------------
let bannerDismissed = false;
export function renderShellBanner() {
  const slot = document.getElementById('shell-banner');
  if (!slot) return;
  clear(slot);
  if (!state.user || !state.recoveryRegen || bannerDismissed) { slot.hidden = true; return; }
  slot.hidden = false;
  slot.append(el('div.shell-banner-inner', { role: 'region', aria: { label: t('recovery.bannerLabel') } },
    icon('shield', { size: 20 }),
    el('p.shell-banner-text', t('recovery.banner')),
    el('a.btn.btn-sm.btn-primary', { href: '#/settings/profile?focus=recovery' }, t('recovery.bannerAction')),
    el('button.icon-btn.icon-btn-sm', { type: 'button', aria: { label: t('recovery.bannerDismiss') }, title: t('recovery.bannerDismiss'),
      onClick: () => { bannerDismissed = true; renderShellBanner(); } }, icon('x', { size: 16 }))));
}

/** Step-up failures count toward lockout: on 423 the account is locked — sign out and explain on the login page. */
export function handleLockout(err) {
  if (!err || err.status !== 423) return false;
  signOut({ locked: true, message: err.message });
  return true;
}

export async function afterLogin({ refresh = true } = {}) {
  if (refresh) await refreshMe();
  if (state.user && state.user.locale && state.user.locale !== getLocale()) await setLocale(state.user.locale);
  if (state.user && state.user.theme) applyTheme(state.user.theme);
  applyPolarityVars();
  startIdleWatch(onIdleExpired);
  shellEls = null;
}

export async function signOut({ expired = false, locked = false } = {}) {
  try { await api.post('/auth/logout', {}, { auth: false }); } catch { /* ignore */ }
  state.user = null; state.org = null; state.orgLogo = undefined; setCsrf(null); stopIdleWatch(); clearCatalogCache();
  shellEls = null;
  pendingNotice = locked ? t('errors.codes.ACCOUNT_LOCKED') : expired ? t('auth.sessionExpired') : t('auth.signedOut');
  navigate('/login');
}
export function takeNotice() { const n = pendingNotice; pendingNotice = null; return n; }

export function applyPolarityVars() {
  const p = polarity();
  document.documentElement.style.setProperty('--pol-neg', p.negative);
  document.documentElement.style.setProperty('--pol-pos', p.positive);
}

function onIdleExpired() { signOut({ expired: true }); }

onApi('restricted', async () => {
  await refreshMe().catch(() => {});
  shellEls = null;
  navigate(state.restriction === 'password' ? '/password' : '/mfa');
});

onApi('unauthorized', () => {
  if (!state.user) return;
  state.user = null; stopIdleWatch(); shellEls = null;
  pendingNotice = t('auth.sessionExpired');
  rememberRoute(currentPath());
  navigate('/login');
});

// ---------------- shell ----------------
const NAV = [
  { id: 'dashboard', href: '#/', icon: 'home', label: 'nav.dashboard', show: () => can.patients() },
  { id: 'patients', href: '#/patients', icon: 'users', label: 'nav.patients', show: () => can.patients() },
  { id: 'audit', href: '#/settings/audit', icon: 'shield', label: 'nav.audit', show: () => can.audit() && !can.patients() },
  { id: 'catalog', href: '#/catalog', icon: 'book', label: 'nav.catalog', show: () => can.patients() || can.reports() },
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
  const locSwitch = languagePicker({
    label: t('settings.language'), value: getLocale(), size: 'xs',
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
      state.org && state.org.name ? el('div.side-org', el('span.side-org-logo', { hidden: true }), el('span.side-org-name', state.org.name)) : null,
    ),
  );
  const main = el('main#main.main', { tabindex: '-1' });
  const shell = el('div.shell', side, el('div.main-col', el('div#shell-banner.shell-banner', { hidden: true, aria: { live: 'polite' } }), main));
  mount(app, shell);
  showSidebarLogo();
  renderShellBanner();
  shellEls = { shell, main, nav };
}

/** Clinic logo in the sidebar: /auth/me only says hasLogo, so fetch GET /org once. */
export async function showSidebarLogo(force = false) {
  const slot = document.querySelector('.side-org-logo');
  if (!slot) return;
  if (force) state.orgLogo = undefined;
  if (state.orgLogo === undefined) {
    state.orgLogo = null;
    if (state.org && state.org.hasLogo) { try { state.orgLogo = (await api.get('/org')).logo || null; } catch { state.orgLogo = null; } }
  }
  clear(slot);
  if (state.orgLogo) slot.append(el('img', { src: state.orgLogo, alt: '' }));
  slot.hidden = !state.orgLogo;
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
    document.body.classList.add('is-auth');
    shellEls = null;
    const main = el('main#main.auth-main', { tabindex: '-1' });
    const langMenu = el('div.auth-lang', languagePicker({ label: t('settings.language'), value: getLocale(), size: 'xs', names: true, onChange: (v) => setLocale(v) }));
    mount(app, el('div.auth-layout', langMenu,
      el('div.auth-art', { aria: { hidden: 'true' } }, fieldArt(), el('div.auth-art-text', brandMark(44), el('p.auth-art-name', 'YOU HEAL'), el('p.auth-art-sub', t('app.clinical')), el('p.auth-art-tag', t('auth.tagline')))),
      main));
    return main;
  }
  document.body.classList.remove('is-auth');
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
// Static dependencies of the heavier views, requested in parallel as soon as the route is known instead of
// being discovered module by module (CSP-safe: <link rel="modulepreload"> to same-origin scripts).
const VIEW_DEPS = {
  scan: ['/js/views/scan.js', '/js/bodymap/host.js', '/js/bodymap/map2d.js', '/js/views/pair-detail.js', '/js/views/start-scan.js', '/js/ui/combobox.js',
    '/js/viewer3d/viewer.js', '/vendor/three/three.module.js'],
  report: ['/js/views/report.js', '/js/bodymap/host.js', '/js/bodymap/map2d.js'],
  catalog: ['/js/views/catalog.js', '/js/views/pair-detail.js', '/js/views/start-scan.js', '/js/ui/combobox.js'],
  card: ['/js/views/catalog.js', '/js/views/pair-detail.js', '/js/views/start-scan.js', '/js/ui/combobox.js', '/js/bodymap/host.js', '/js/bodymap/map2d.js', '/js/viewer3d/viewer.js', '/vendor/three/three.module.js'],
  chart: ['/js/views/chart.js', '/js/views/start-scan.js', '/js/ui/combobox.js'],
  dashboard: ['/js/views/dashboard.js', '/js/ui/combobox.js'],
};
const preloaded = new Set();
function preloadModules(list = []) {
  for (const href of list) {
    if (preloaded.has(href)) continue;
    preloaded.add(href);
    document.head.append(el('link', { rel: 'modulepreload', href }));
  }
}

function view(loader, fnName, opts = {}) {
  return {
    ...opts,
    async view(ctx) {
      const main = layoutFor(opts, opts.layout || 'app');
      document.title = t('app.title');
      if (opts.deps) preloadModules(VIEW_DEPS[opts.deps]);
      let mod;
      try { mod = await loader(); } catch (err) {
        console.error(err);
        main.append(el('p.page-error', t('errors.viewLoad')));
        return null;
      }
      const cleanup = await mod[fnName]({ ...ctx, main });
      mark(`view:${fnName}`);
      requestAnimationFrame(() => focusTitle(main));
      return cleanup;
    },
  };
}

route('/setup', view(() => import('./views/auth.js'), 'renderSetup', { public: true, layout: 'auth' }));
route('/login', view(() => import('./views/auth.js'), 'renderLogin', { public: true, layout: 'auth' }));
route('/mfa', view(() => import('./views/auth.js'), 'renderMfaEnroll', { layout: 'auth', allow: 'mfa' }));
route('/password', view(() => import('./views/auth.js'), 'renderPasswordChange', { layout: 'auth', allow: 'password' }));
route('/', view(() => import('./views/dashboard.js'), 'renderDashboard', { nav: 'dashboard', deps: 'dashboard' }));
route('/patients', view(() => import('./views/patients.js'), 'renderPatientList', { nav: 'patients' }));
route('/patients/new', view(() => import('./views/patients.js'), 'renderPatientForm', { nav: 'patients' }));
route('/patients/:id/edit', view(() => import('./views/patients.js'), 'renderPatientForm', { nav: 'patients' }));
route('/patients/:id/:tab?', view(() => import('./views/chart.js'), 'renderChart', { nav: 'patients', deps: 'chart' }));
route('/sessions/:id', view(() => import('./views/scan.js'), 'renderScan', { nav: 'patients', compact: true, deps: 'scan' }));
route('/sessions/:id/report', view(() => import('./views/report.js'), 'renderReport', { nav: 'patients', deps: 'report' }));
route('/catalog/protocols/:id/card', view(() => import('./views/catalog.js'), 'renderProtocolCard', { nav: 'catalog', deps: 'card' }));
route('/catalog/:tab?', view(() => import('./views/catalog.js'), 'renderCatalog', { nav: 'catalog', deps: 'catalog' }));
route('/settings/audit', view(() => import('./views/settings.js'), 'renderSettings', { nav: 'audit', tab: 'audit' }));
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
    // Server restrictions: admins MUST enroll MFA; admin-created users must change their password first.
    if (state.restriction === 'password' && r.allow !== 'password') return '/password';
    if (state.restriction === 'mfa' && r.allow !== 'mfa') return '/mfa';
    if (!state.restriction && (r.allow === 'password')) return '/';
    // Role landing: the auditor has no patient directory.
    if (!can.patients() && (ctx.path === '/' || ctx.path.startsWith('/patients'))) return can.audit() ? '/settings/audit' : '/catalog';
    return null;
  },
  after(ctx) {
    if (!ctx.route || !ctx.route.public) rememberRoute(ctx.path);
    window.scrollTo(0, 0);
  },
});

/** Static shell text from index.html (skip link, document title) follows the UI language. */
function localizeStatic() {
  const skip = document.querySelector('.skip-link'); if (skip) skip.textContent = t('app.skipLink');
  document.title = t('app.title');
}
onLocaleChange(() => { localizeStatic(); shellEls = null; reload(); });

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
  mark('boot');
  applyTheme(getTheme());
  // Language pack, setup status and the session probe are independent: one round trip instead of four.
  // A browser that never had a signed-in route (e.g. the very first setup) probes the session afterwards.
  const probe = () => refreshMe().then((ok) => {
    // the signed-in user's language pack starts downloading as soon as their preference is known
    if (ok && state.user && state.user.locale) ensureLocale(state.user.locale);
    // views that need the catalog core start it now, in parallel with the rest of the bootstrap
    if (ok && !state.restriction && /^#\/(sessions|catalog)\//.test(location.hash) && (can.patients() || can.reports())) loadCore().catch(() => {});
    return ok;
  }).catch(() => false);
  const early = lastRoute() ? probe() : null;
  const [, status] = await Promise.all([
    initI18n().catch((err) => console.warn('[i18n]', err)),
    api.get('/setup/status', null, { auth: false }).catch(() => null),
  ]);
  const signedIn = status && !status.needsSetup ? await (early || probe()) : false;
  localizeStatic();
  mark('i18n');
  setupStatus = status;
  if (!setupStatus) {
    mount(app, el('div.boot-error', el('h1', t('errors.serverUnreachable')), el('p', t('errors.serverUnreachableBody')),
      el('button.btn.btn-primary', { type: 'button', onClick: () => location.reload() }, t('common.retry'))));
    return;
  }
  if (setupStatus.needsSetup) state.user = null;
  else if (signedIn) await afterLogin({ refresh: false });
  mark('session');
  if (!location.hash) {
    const lr = state.user ? lastRoute() : null;
    history.replaceState(null, '', `#${lr || '/'}`);
  }
  await startRouter();
}

export function goAfterLogin() {
  if (state.restriction === 'password') { navigate('/password'); return; }
  if (state.restriction === 'mfa') { navigate('/mfa'); return; }
  const lr = lastRoute();
  navigate(lr && !/^\/(login|setup|mfa|password)/.test(lr) ? lr : '/');
}

boot();
