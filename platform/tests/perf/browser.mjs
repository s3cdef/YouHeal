// Browser benchmark: login → scan workspace (first visit, SPA navigation) → warm reload (hard reload, HTTP cache warm).
//   BASE_URL=http://127.0.0.1:18621 RUNS=3 node tests/perf/browser.mjs
// Reports per phase (median of RUNS): time to "3D ready" (canvas shown, loading overlay gone), LCP, DOMContentLoaded,
// long-task total (≈TBT), requests/bytes until network idle, 304 revalidations, the app's own yh:* performance marks,
// and the classic "network idle" time. Read-only against a running server; never run against real PHI.
import { pathToFileURL } from 'node:url';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.mjs').href);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18621';
const RUNS = Number(process.env.RUNS || 3);
const EMAIL = process.env.PERF_EMAIL || 'a@p.test';
const PASSWORD = process.env.PERF_PASSWORD || 'Violet-Harbor-Lantern-42';
// NET=wan|lan emulates a remote/clinic network (Chrome DevTools throttling) so request waterfalls and payloads count.
const NETS = { wan: { latency: 60, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 }, lan: { latency: 4, downloadThroughput: (100 * 1024 * 1024) / 8, uploadThroughput: (50 * 1024 * 1024) / 8 } };
const NET = NETS[process.env.NET] || null;

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

async function oneRun() {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    window.__yhLT = 0; window.__yhLCP = 0;
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__yhLT += Math.max(0, e.duration - 50); }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__yhLCP = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* unsupported */ }
  });
  const page = await ctx.newPage();
  if (NET) { const cdp = await ctx.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NET }); }
  let reqs = [];
  page.on('response', (res) => {
    const r = res.request(); const e = { url: r.url().replace(BASE, ''), status: res.status(), bytes: 0, type: r.resourceType() }; reqs.push(e);
    res.finished().then(() => r.sizes()).then((s) => { e.bytes = s.responseBodySize + s.responseHeadersSize; }).catch(() => {});
  });
  const t0 = Date.now();
  await page.goto(BASE + '/#/login'); await page.waitForLoadState('networkidle');
  const loginMs = Date.now() - t0;
  await page.fill('input[type=email]', EMAIL); await page.fill('input[type=password]', PASSWORD); await page.keyboard.press('Enter');
  await page.waitForURL(/#\/(dashboard|today|$)/, { timeout: 15000 }).catch(() => {}); await page.waitForLoadState('networkidle');
  const sid = await page.evaluate(async () => { const r = await (await fetch('/api/v1/sessions?limit=1&status=draft')).json(); return r.items[0].id; });

  // "3D ready": the viewer canvas is on screen and no loading overlay is visible (same rule as the walkthrough)
  const ready3d = () => page.waitForFunction(() => {
    const c = document.querySelector('.viewer-host canvas, .yh-viewer canvas');
    const loading = document.querySelector('.viewer-loading') || [...document.querySelectorAll('.yh-viewer__loading')].some((n) => n.offsetParent !== null && !n.hidden);
    return c && c.offsetParent !== null && !loading && document.querySelector('.ck-item, .scan-bar');
  }, null, { timeout: 60000, polling: 'raf' });
  const marks = () => page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('yh:')).map((m) => [m.name, Math.round(m.startTime)])));
  const summarize = (list) => ({ requests: list.length, kb: Math.round(list.reduce((a, r) => a + r.bytes, 0) / 1024), revalidated: list.filter((r) => r.status === 304).length, api: list.filter((r) => r.url.startsWith('/api')).length });

  // ---- first visit (SPA navigation after login) ----
  reqs = [];
  const t1 = await page.evaluate(() => performance.now());
  await page.evaluate((id) => { location.hash = `#/sessions/${id}`; }, sid);
  await ready3d();
  const first3d = Math.round((await page.evaluate(() => performance.now())) - t1);
  const firstMarks = await marks();
  await page.waitForLoadState('networkidle');
  const firstIdle = Math.round((await page.evaluate(() => performance.now())) - t1) - 500;
  const first = { ready3d: first3d, idle: firstIdle, ...summarize(reqs), marks: Object.fromEntries(Object.entries(firstMarks).filter(([, v]) => v >= t1).map(([k, v]) => [k, Math.round(v - t1)])) };
  const repeated = {}; for (const r of reqs) if (r.url.startsWith('/api')) repeated[r.url] = (repeated[r.url] || 0) + 1;
  first.repeated = Object.entries(repeated).filter(([, n]) => n > 1).map(([u, n]) => `${u}×${n}`);
  first.largest = [...reqs].sort((x, y) => y.bytes - x.bytes).slice(0, 6).map((r) => `${Math.round(r.bytes / 1024)}KB ${r.url.slice(0, 60)}`);

  // ---- warm reload ----
  reqs = [];
  const t2 = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await ready3d();
  const warm3d = await page.evaluate(() => Math.round(performance.now()));
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) }; });
  const warmMarks = await marks();
  await page.waitForLoadState('networkidle');
  const warmIdle = Date.now() - t2 - 500;
  await page.waitForTimeout(300);
  const vit = await page.evaluate(() => ({ lcp: Math.round(window.__yhLCP), tbt: Math.round(window.__yhLT) }));
  const warm = { ready3d: warm3d, idle: warmIdle, ...nav, ...vit, ...summarize(reqs), marks: warmMarks };
  await ctx.close();
  return { loginMs, first, warm };
}

const runs = [];
for (let i = 0; i < RUNS; i++) runs.push(await oneRun());
await b.close();

const m = (sel) => median(runs.map(sel));
const markNames = (k) => [...new Set(runs.flatMap((r) => Object.keys(r[k].marks)))].sort((x, y) => m((r) => r[k].marks[x] ?? NaN) - m((r) => r[k].marks[y] ?? NaN));
console.log(`browser benchmark — ${BASE} — median of ${RUNS} run(s)${NET ? ` — network ${process.env.NET} (${NET.latency} ms RTT)` : ' — loopback'}`);
console.log(`login page ready: ${m((r) => r.loginMs)} ms`);
for (const k of ['first', 'warm']) {
  const label = k === 'first' ? 'scan workspace, first visit (SPA nav after login)' : 'scan workspace, warm reload';
  console.log(`\n${label}`);
  console.log(`  3D ready: ${m((r) => r[k].ready3d)} ms · network idle: ${m((r) => r[k].idle)} ms`);
  if (k === 'warm') console.log(`  LCP: ${m((r) => r.warm.lcp)} ms · DOMContentLoaded: ${m((r) => r.warm.dcl)} ms (includes tearing down the previous WebGL page) · long tasks (TBT≈): ${m((r) => r.warm.tbt)} ms`);
  console.log(`  ${m((r) => r[k].requests)} requests (${m((r) => r[k].api)} API, ${m((r) => r[k].revalidated)} × 304) · ${m((r) => r[k].kb)} KB transferred`);
  const names = markNames(k);
  if (names.length) console.log(`  app marks: ${names.map((n) => `${n.replace('yh:', '')} ${m((r) => r[k].marks[n] ?? NaN)}`).join(' · ')}`);
}
console.log(`\nfirst visit largest: ${runs[0].first.largest.join(' | ')}`);
console.log(`first visit repeated API calls: ${runs[0].first.repeated.join(', ') || 'none'}`);
