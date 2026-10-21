// Browser smoke test of the CONTRACT §6 viewer API (WebGL + SVG fallback).
// Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/viewer3d/api-smoke.mjs
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const pwPath = process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(pwPath).catch(() => import('playwright'));
const port = 8900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [join(here, 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', `${name}: ${e.message}`]); }
};

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  // (the procedural-fallback check intentionally triggers a 404 + console.warn)
  await page.goto(`http://127.0.0.1:${port}/viewer-demo.html?protocol=0`);
  await page.waitForFunction(() => document.documentElement.dataset.viewerReady === '1', null, { timeout: 120000 });
  // Build a second viewer in a fresh container through the public API.
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'test-host';
    host.style.position = 'fixed'; host.style.left = '0'; host.style.top = '0'; host.style.width = '600px'; host.style.height = '800px'; host.style.zIndex = '10';
    document.body.appendChild(host);
    const [anat, meta] = await Promise.all([fetch('catalog-data/point-anatomy.json').then((r) => r.json()), fetch('js/viewer3d/demo-points.json').then((r) => r.json())]);
    const points = meta.filter((p) => anat[p.id]).map((p) => ({ ...p, ...anat[p.id] }));
    const regions = await fetch('catalog-data/regions.json').then((r) => r.json());
    const { createBodyViewer } = await import('/js/viewer3d/viewer.js');
    window.__events = [];
    const t0 = performance.now();
    window.__v = await createBodyViewer(host, {
      points, regions, locale: 'en',
      onPointClick: (e) => window.__events.push(['point', e]),
      onRegionClick: (e) => window.__events.push(['region', e]),
      onHover: (e) => window.__events.push(['hover', e]),
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__firstRenderMs = performance.now() - t0;
    window.__screen = (key) => {
      const v = window.__v, { camera } = v._debug;
      const inst = v._debug.instances().find((i) => i.key === key);
      const p = inst.position.clone().project(camera);
      const r = host.getBoundingClientRect();
      return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
    };
  });
  const wait = (ms) => page.waitForTimeout(ms);

  await check('renderer is webgl with the MakeHuman body', async () => {
    assert.equal(await page.evaluate(() => window.__v.renderer), 'webgl');
    assert.equal(await page.evaluate(() => window.__v._debug.model.kind), 'makehuman');
  });
  await check('first render ≤ 1.5 s (second viewer, fresh worker)', async () => {
    const ms = await page.evaluate(() => window.__firstRenderMs);
    console.log(`     first render: ${ms.toFixed(0)} ms`);
    assert.ok(ms <= 1500, `${ms.toFixed(0)} ms`);
  });
  await check('cold first render ≤ 1.5 s (new page, nothing cached)', async () => {
    const p2 = await browser.newPage({ viewport: { width: 700, height: 800 } });
    await p2.goto(`http://127.0.0.1:${port}/viewer-demo.html?protocol=0&points=0`);
    await p2.waitForFunction(() => document.documentElement.dataset.viewerReady === '1', null, { timeout: 120000 });
    const ms = await p2.evaluate(async () => {
      const host = document.createElement('div');
      host.style.width = '600px'; host.style.height = '700px';
      document.body.appendChild(host);
      const { createBodyViewer } = await import('/js/viewer3d/viewer.js');
      const t0 = performance.now();
      const v = await createBodyViewer(host, { points: [], sex: 'female' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const dt = performance.now() - t0;
      v.dispose();
      return dt;
    });
    console.log(`     cold first render (female preset, uncached): ${ms.toFixed(0)} ms`);
    await p2.close();
    assert.ok(ms <= 1500, `${ms.toFixed(0)} ms`);
  });
  await check('page load → 3D ready (navigation start → viewer ready / first frame, all points)', async () => {
    const runs = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    for (let i = 0; i < 3; i++) { // run 0 = cold HTTP cache; runs 1-2 = warm reload (worker/cache storage as the app would have it)
      const p3 = await ctx.newPage();
      await p3.goto(`http://127.0.0.1:${port}/viewer-demo.html?protocol=1`);
      await p3.waitForFunction(() => document.documentElement.dataset.firstFrameMs, null, { timeout: 120000 });
      runs.push(await p3.evaluate(() => {
        const d = document.documentElement.dataset;
        const res = performance.getEntriesByType('resource');
        const three = res.find((r) => /three\.module/.test(r.name));
        return { ready: +d.viewerReadyMs, frame: +d.firstFrameMs, threeKB: three ? Math.round(three.encodedBodySize / 1024) : null, bytesKB: Math.round(res.reduce((t, r) => t + (r.encodedBodySize || 0), 0) / 1024) };
      }));
      await p3.close();
    }
    await ctx.close();
    for (const [i, r] of runs.entries()) console.log(`     ${i === 0 ? 'cold' : 'warm'} page: 3D ready ${r.ready} ms · first frame ${r.frame} ms · three.module ${r.threeKB} KB · page bytes ${r.bytesKB} KB`);
    assert.ok(runs[0].frame <= 4000);
  });
  await check('procedural fallback when the asset is missing', async () => {
    const kind = await page.evaluate(async () => {
      const host = document.createElement('div');
      host.style.width = '300px'; host.style.height = '400px';
      document.body.appendChild(host);
      const { createBodyViewer } = await import('/js/viewer3d/viewer.js');
      const v = await createBodyViewer(host, { points: [], modelsUrl: '/assets/does-not-exist/' });
      const k = v._debug.model.kind;
      v.dispose(); host.remove();
      return k;
    });
    assert.equal(kind, 'procedural');
  });
  await check('setView posterior moves camera behind', async () => {
    await page.evaluate(() => window.__v.setView('posterior'));
    await wait(1200);
    assert.ok(await page.evaluate(() => window.__v._debug.camera.position.z < -1));
  });
  await check('click on kidney (R) fires onPointClick', async () => {
    const s = await page.evaluate(() => window.__screen('rinon|R'));
    await page.mouse.move(s.x, s.y); await wait(150);
    await page.mouse.click(s.x, s.y); await wait(150);
    const ev = await page.evaluate(() => window.__events.filter((e) => e[0] === 'point').pop());
    assert.ok(ev, 'no point event');
    assert.equal(ev[1].side, 'R');
    assert.ok(['rinon', 'caliz-renal', 'capsula-renal'].includes(ev[1].pointId), ev[1].pointId);
    const hover = await page.evaluate(() => window.__events.filter((e) => e[0] === 'hover' && e[1].pointId).pop());
    assert.ok(hover, 'no hover event');
  });
  await check('click on bare calf skin fires onRegionClick(leg)', async () => {
    await page.evaluate(() => window.__v.setShowAllPoints(false));
    const s = await page.evaluate(() => window.__screen('gastrocnemio|L'));
    await page.mouse.click(s.x, s.y + 40); await wait(150);
    const ev = await page.evaluate(() => window.__events.filter((e) => e[0] === 'region').pop());
    assert.ok(ev, 'no region event');
    assert.equal(ev[1].regionId, 'leg');
    assert.equal(ev[1].side, 'L');
    await page.evaluate(() => window.__v.setShowAllPoints(true));
  });
  await check('keyboard F returns to the front', async () => {
    await page.focus('#test-host canvas');
    await page.keyboard.press('f'); await wait(1200);
    assert.ok(await page.evaluate(() => window.__v._debug.camera.position.z > 1));
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('+'); await wait(500);
  });
  await check('setPointFilter limits the accessible list; Tab reaches it', async () => {
    await page.evaluate(() => window.__v.setPointFilter(['timo', 'rinon']));
    const n = await page.evaluate(() => document.querySelectorAll('#test-host .yh-viewer__a11y button').length);
    assert.equal(n, 3); // timo (C) + rinon R/L
    await page.focus('#test-host canvas');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.dataset?.key);
    assert.ok(focused && /^(timo|rinon)\|/.test(focused), String(focused));
    await page.evaluate(() => window.__v.setPointFilter(null));
  });
  await check('magnets, pairs, highlight, focusPoint', async () => {
    await page.evaluate(() => {
      const v = window.__v;
      v.setMagnets([{ id: 'm1', pointId: 'timo', side: 'C', polarity: 'negative', label: 'Thymus – Rectum' }, { id: 'm2', pointId: 'recto', side: 'C', polarity: 'positive' }]);
      v.setPairs([{ id: 'p1', a: { pointId: 'timo', side: 'C' }, b: { pointId: 'recto', side: 'C' }, state: 'found' }]);
      v.highlight(['higado'], { pulse: true });
      v.focusPoint('higado', 'C');
    });
    await wait(900);
    const counts = await page.evaluate(() => {
      const s = window.__v._debug.scene;
      return { magnets: s.getObjectByName('magnets').children.length, pairs: s.getObjectByName('pairs').children.length };
    });
    assert.equal(counts.magnets, 2);
    assert.ok(counts.pairs >= 1);
  });
  await check('snapshot returns PNG of requested size', async () => {
    const dim = await page.evaluate(async () => {
      const t0 = performance.now();
      const url = await window.__v.snapshot({ view: 'posterior', width: 400, height: 550 });
      window.__snapMs = performance.now() - t0;
      const img = new Image(); img.src = url; await img.decode();
      return { prefix: url.slice(0, 22), w: img.naturalWidth, h: img.naturalHeight };
    });
    assert.equal(dim.prefix, 'data:image/png;base64,');
    assert.equal(dim.w, 400); assert.equal(dim.h, 550);
    const big = await page.evaluate(async () => { const t0 = performance.now(); await window.__v.snapshot({ view: 'anterior', width: 800, height: 1100 }); return performance.now() - t0; });
    console.log(`     snapshot (supersampled): 400×550 ${(await page.evaluate(() => window.__snapMs)).toFixed(0)} ms · 800×1100 ${big.toFixed(0)} ms`);
    assert.ok(big < 3000, `${big} ms`);
  });
  await check('resize + dispose cleans up', async () => {
    const left = await page.evaluate(() => {
      const host = document.getElementById('test-host');
      host.style.width = '500px'; window.__v.resize(); window.__v.dispose();
      return { canvas: host.querySelectorAll('canvas').length, cls: host.classList.contains('yh-viewer') };
    });
    assert.equal(left.canvas, 0); assert.equal(left.cls, false);
  });
  await check('SVG fallback implements the same API', async () => {
    const r = await page.evaluate(async () => {
      const host = document.getElementById('test-host');
      const { createBodyViewer } = await import('/js/viewer3d/viewer.js');
      const anat = await fetch('catalog-data/point-anatomy.json').then((x) => x.json());
      const points = [{ id: 'timo', laterality: 'central', name: { es: 'Timo', en: 'Thymus' }, ...anat.timo }, { id: 'rinon', laterality: 'bilateral', name: { es: 'Riñón', en: 'Kidney' }, ...anat.rinon }];
      const v = await createBodyViewer(host, { points, forceFallback: true });
      const api = ['setView', 'setMagnets', 'setPairs', 'highlight', 'setPointFilter', 'setShowAllPoints', 'focusPoint', 'snapshot', 'resize', 'dispose'].every((k) => typeof v[k] === 'function');
      v.setView('posterior');
      v.setMagnets([{ id: 'a', pointId: 'rinon', side: 'R', polarity: 'negative' }, { id: 'b', pointId: 'rinon', side: 'L', polarity: 'positive' }]);
      v.setPairs([{ id: 'p', a: { pointId: 'rinon', side: 'R' }, b: { pointId: 'rinon', side: 'L' }, state: 'impacted' }]);
      const url = await v.snapshot({ view: 'posterior', width: 300, height: 400 });
      const listN = host.querySelectorAll('.yh-viewer__a11y button').length;
      v.dispose();
      return { renderer: v.renderer, api, png: url.startsWith('data:image/png'), listN };
    });
    assert.equal(r.renderer, 'svg'); assert.ok(r.api); assert.ok(r.png);
  });
  await check('no page errors / CSP violations', async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.kill();
}
for (const [s, n] of results) console.log(`${s.padEnd(4)} ${n}`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
