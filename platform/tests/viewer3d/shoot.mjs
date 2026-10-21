// Visual check of the body viewer: serves web/ and screenshots views into tests/artifacts/.
// Requires Playwright + Chromium (not a repo dependency). Usage:
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/viewer3d/shoot.mjs [name=query ...]
// Set PLAYWRIGHT_MODULE to the playwright entry if it is not resolvable.
// PREVIEW_DIR=docs/previews/3d additionally writes <name>.jpg (quality 82) for committed previews.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'artifacts');
const pwPath = process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(pwPath).catch(() => import('playwright'));
const port = 8800 + Math.floor(Math.random() * 100);
const server = spawn(process.execPath, [join(here, 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));

const DEFAULT_SHOTS = {
  front: 'view=anterior',
  back: 'view=posterior',
  left: 'view=left',
  'legs-back': 'view=posterior&zoom=legs-back&points=0',
};
const args = process.argv.slice(2);
const shots = args.length ? Object.fromEntries(args.map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; })) : DEFAULT_SHOTS;

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [];
try {
  for (const [name, query] of Object.entries(shots)) {
    const page = await browser.newPage({ viewport: process.env.PREVIEW_DIR ? { width: 1520, height: 1180 } : { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${name}] ${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/viewer-demo.html?${query}`);
    await page.waitForFunction(() => ['1', 'error'].includes(document.documentElement.dataset.viewerReady), null, { timeout: 120000 });
    await page.waitForTimeout(1200);
    const file = join(out, `viewer-${name}.png`);
    await page.locator('#viewer').screenshot({ path: file });
    if (process.env.PREVIEW_DIR) {
      await mkdir(process.env.PREVIEW_DIR, { recursive: true });
      await page.locator('#viewer').screenshot({ path: join(process.env.PREVIEW_DIR, `${name}.jpg`), type: 'jpeg', quality: 82 });
    }
    console.log(`${name}: ${file} (${Date.now() - t0} ms)`);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (problems.length) { console.log('Console problems:'); for (const p of problems) console.log('  ' + p); }
