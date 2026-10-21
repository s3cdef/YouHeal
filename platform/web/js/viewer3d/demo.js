/**
 * Demo harness for the body viewer (web/viewer-demo.html). Not used by the app.
 * URL params: view, sex, tone, locale, points=0|1, protocol=0|1, zoom=legs-back, fallback=1
 */
import { createBodyViewer } from './viewer.js';

const qs = new URLSearchParams(location.search);
const $ = (sel) => document.querySelector(sel);
const state = {
  view: qs.get('view') || 'anterior',
  sex: qs.get('sex') || 'neutral',
  tone: qs.get('tone') || 'medium',
  locale: qs.get('locale') || 'en',
  points: qs.get('points') !== '0',
  protocol: qs.get('protocol') !== '0',
  fallback: qs.get('fallback') === '1',
};

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadCatalog() {
  const [anatomy, regions] = await Promise.all([
    getJSON('catalog-data/point-anatomy.json').catch(() => ({})),
    getJSON('catalog-data/regions.json').catch(() => []),
  ]);
  // names + laterality: the Data team's points.json when present, else the demo list
  let meta = await getJSON('catalog-data/points.json').catch(() => null);
  if (!Array.isArray(meta) || !meta.length) meta = await getJSON('js/viewer3d/demo-points.json').catch(() => []);
  const points = meta.filter((p) => anatomy[p.id]).map((p) => ({ ...p, ...anatomy[p.id] }));
  return { points, regions };
}

/** "19. Circulación de Piernas" (reference protocol card). */
const PROTOCOL = [
  { id: 'p1', es: 'Hígado – Hígado', en: 'Liver – Liver', a: ['higado', 'C'], b: ['higado', 'C'], state: 'impacted' },
  { id: 'p2', es: 'Suprarrenal – Suprarrenal', en: 'Adrenal – Adrenal', a: ['suprarrenal', 'R'], b: ['suprarrenal', 'L'], state: 'found' },
  { id: 'p3', es: 'Riñón – Riñón', en: 'Kidney – Kidney', a: ['rinon', 'R'], b: ['rinon', 'L'], state: 'found' },
  { id: 'p4', es: 'Ingle – Ingle', en: 'Groin – Groin', a: ['ingle', 'R'], b: ['ingle', 'L'], state: 'candidate' },
  { id: 'p5', es: 'Ciático – Ciático', en: 'Sciatic – Sciatic', a: ['ciatico', 'R'], b: ['ciatico', 'L'], state: 'impacted' },
  { id: 'p6', es: 'Poplíteo – Poplíteo', en: 'Popliteal – Popliteal', a: ['popliteo', 'R'], b: ['popliteo', 'L'], state: 'cleared' },
  { id: 'p7', es: 'Gastrocnemio – Gastrocnemio', en: 'Gastrocnemius – Gastrocnemius', a: ['gastrocnemio', 'R'], b: ['gastrocnemio', 'L'], state: 'found' },
];

function protocolMagnets(locale) {
  const out = [];
  for (const p of PROTOCOL) {
    out.push({ id: `${p.id}-n`, pointId: p.a[0], side: p.a[1], polarity: 'negative', label: p[locale] || p.es, state: p.state === 'cleared' ? 'done' : 'active' });
    out.push({ id: `${p.id}-p`, pointId: p.b[0], side: p.b[1], polarity: 'positive', state: p.state === 'cleared' ? 'done' : 'active' });
  }
  return out;
}
function protocolPairs() {
  return PROTOCOL.map((p) => ({ id: p.id, a: { pointId: p.a[0], side: p.a[1] }, b: { pointId: p.b[0], side: p.b[1] }, state: p.state }));
}

function renderPairList(locale) {
  const ol = $('#demo-pairs');
  ol.textContent = '';
  for (const p of PROTOCOL) {
    const li = document.createElement('li');
    const [neg, pos] = (p[locale] || p.es).split(' – ');
    const n = document.createElement('span'); n.className = 'demo-neg'; n.textContent = `− ${neg}`;
    const s = document.createElement('span'); s.className = 'demo-pos'; s.textContent = `+ ${pos}`;
    li.append(n, ' → ', s, ` (${p.state})`);
    ol.appendChild(li);
  }
}

let viewer = null;
let catalog = null;

async function mount() {
  document.documentElement.dataset.viewerReady = '0';
  if (viewer) { viewer.dispose(); viewer = null; }
  const el = $('#viewer');
  const log = $('#demo-log');
  viewer = await createBodyViewer(el, {
    points: catalog.points,
    regions: catalog.regions,
    locale: state.locale,
    sex: state.sex,
    skinTone: state.tone,
    forceFallback: state.fallback,
    onPointClick: (e) => { log.textContent = `pointClick\n${JSON.stringify(e, null, 1)}`; viewer.highlight([e.pointId], { pulse: true }); },
    onRegionClick: (e) => { log.textContent = `regionClick\n${JSON.stringify(e, null, 1)}`; },
    onHover: () => {},
  });
  viewer.setShowAllPoints(state.points);
  if (state.protocol) {
    viewer.setMagnets(protocolMagnets(state.locale));
    viewer.setPairs(protocolPairs());
  }
  if (qs.get('highlight')) viewer.highlight(qs.get('highlight').split(','), { pulse: true });
  viewer.setView(state.view);
  const cam = qs.get('cam') ? qs.get('cam').split(',').map(Number) : qs.get('zoom') === 'legs-back' ? [0, 0.68, -2.15, 0, 0.62, 0] : null;
  if (cam && viewer._debug) {
    const { camera, controls } = viewer._debug;
    setTimeout(() => {
      camera.position.set(cam[0], cam[1], cam[2]);
      controls.target.set(cam[3], cam[4], cam[5]);
      controls.update();
      document.documentElement.dataset.viewerReady = '1';
    }, 50);
  } else {
    setTimeout(() => { document.documentElement.dataset.viewerReady = '1'; }, 900);
  }
  renderPairList(state.locale);
}

function wire() {
  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => { state.view = b.dataset.view; viewer?.setView(state.view); });
  $('#demo-sex').value = state.sex;
  $('#demo-tone').value = state.tone;
  $('#demo-locale').value = state.locale;
  $('#demo-points').checked = state.points;
  $('#demo-protocol').checked = state.protocol;
  $('#demo-sex').addEventListener('change', (e) => { state.sex = e.target.value; mount(); });
  $('#demo-tone').addEventListener('change', (e) => { state.tone = e.target.value; mount(); });
  $('#demo-locale').addEventListener('change', (e) => { state.locale = e.target.value; mount(); });
  $('#demo-points').addEventListener('change', (e) => { state.points = e.target.checked; viewer?.setShowAllPoints(state.points); });
  $('#demo-protocol').addEventListener('change', (e) => {
    state.protocol = e.target.checked;
    viewer?.setMagnets(state.protocol ? protocolMagnets(state.locale) : []);
    viewer?.setPairs(state.protocol ? protocolPairs() : []);
  });
  $('#demo-snap').addEventListener('click', async () => {
    const url = await viewer.snapshot({ view: state.view, width: 800, height: 1100 });
    const img = $('#demo-shot');
    img.src = url;
    img.hidden = false;
  });
}

(async () => {
  catalog = await loadCatalog();
  wire();
  await mount();
})().catch((err) => {
  $('#demo-log').textContent = `Error: ${err && err.stack || err}`;
  document.documentElement.dataset.viewerReady = 'error';
});
