/**
 * 2D SVG fallback for the body viewer (used when WebGL is unavailable).
 * Implements the same API as createBodyViewer (CONTRACT §6). The silhouettes
 * are computed from the same body as the 3D viewer — the MakeHuman asset, or
 * the procedural SDF if the asset is unavailable (no imagery) — so point
 * positions match the 3D viewer exactly.
 *
 * Views: anterior, posterior (mirror), left, right. 'superior' falls back to
 * anterior. Pulse highlight uses a CSS animation (disabled by
 * prefers-reduced-motion in viewer.css).
 * @module viewer3d/viewer-svg
 */
import { buildBody, snapPoint, sphereTrace } from './body-sdf.js';
import { loadBodyAsset } from './body-asset.js';
import { buildMeshQuery } from './mesh-query.js';
import { regionAt } from './regions.js';
import { buildInstances, localName, sideLabel, uiText, PAIR_COLORS, DEFAULT_POLARITY, resolveInstance } from './viewer-common.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => { const e = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const SKIN = { light: '#efcfb6', medium: '#d9ad90', tan: '#c08a64', deep: '#8a5a3c', clinical: '#c3cad3' };

/** Projection per view: world → (u, v) in metres (v grows downward). */
const PROJ = {
  anterior: { u: (p) => p[0], dir: [0, 0, 1] },
  posterior: { u: (p) => -p[0], dir: [0, 0, -1] },
  left: { u: (p) => -p[2], dir: [1, 0, 0] },
  right: { u: (p) => p[2], dir: [-1, 0, 0] },
};

/** Marching squares on a scalar grid → closed SVG path (level 0). */
function contourPath(grid, nu, nv, u0, v0, h) {
  const val = (i, j) => grid[j * nu + i];
  const pts = new Map(); // edge key -> [u, v]
  const edgePoint = (i, j, horiz) => {
    const key = `${i},${j},${horiz ? 'h' : 'v'}`;
    if (!pts.has(key)) {
      const a = val(i, j), b = horiz ? val(i + 1, j) : val(i, j + 1);
      const t = a / (a - b);
      pts.set(key, horiz ? [u0 + (i + t) * h, v0 + j * h] : [u0 + i * h, v0 + (j + t) * h]);
    }
    return key;
  };
  const next = new Map();
  for (let j = 0; j < nv - 1; j++) for (let i = 0; i < nu - 1; i++) {
    const c = (val(i, j) < 0 ? 1 : 0) | (val(i + 1, j) < 0 ? 2 : 0) | (val(i + 1, j + 1) < 0 ? 4 : 0) | (val(i, j + 1) < 0 ? 8 : 0);
    if (c === 0 || c === 15) continue;
    const T = () => edgePoint(i, j, true), B = () => edgePoint(i, j + 1, true), L = () => edgePoint(i, j, false), R = () => edgePoint(i + 1, j, false);
    const seg = {
      1: [[L, T]], 2: [[T, R]], 3: [[L, R]], 4: [[R, B]], 5: [[L, T], [R, B]], 6: [[T, B]], 7: [[L, B]],
      8: [[B, L]], 9: [[B, T]], 10: [[T, R], [B, L]], 11: [[B, R]], 12: [[R, L]], 13: [[R, T]], 14: [[T, L]],
    }[c];
    for (const [a, b] of seg) next.set(a(), b());
  }
  let d = '';
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    let k = start, n = 0;
    const loop = [];
    while (k && !seen.has(k) && n++ < 1e6) { seen.add(k); loop.push(pts.get(k)); k = next.get(k); }
    if (loop.length < 3) continue;
    d += `M${loop.map(([u, v]) => `${u.toFixed(4)},${v.toFixed(4)}`).join('L')}Z`;
  }
  return d;
}

/** Silhouette of the body seen along `view` (min SDF along the view axis). */
function silhouette(sdf, view, h = 0.005) {
  const lateral = view === 'left' || view === 'right';
  const uMin = lateral ? -0.2 : -0.56, uMax = lateral ? 0.26 : 0.56;
  const vMin = -1.79, vMax = 0.02;
  const nu = Math.ceil((uMax - uMin) / h) + 1, nv = Math.ceil((vMax - vMin) / h) + 1;
  const grid = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    const y = -(vMin + j * h);
    for (let i = 0; i < nu; i++) {
      const u = uMin + i * h;
      // inside/outside along the depth axis (sphere tracing never skips a hit)
      let t = -0.6, inside = false;
      while (t < 0.6) {
        const d = lateral ? sdf(t, y, view === 'left' ? -u : u) : sdf(view === 'posterior' ? -u : u, y, t);
        if (d < 0) { inside = true; break; }
        t += Math.max(d * 0.95, 0.002);
      }
      grid[j * nu + i] = inside ? -1 : 1;
    }
  }
  // two box-blur passes → smooth sub-cell contour of the occupancy
  for (let pass = 0; pass < 2; pass++) {
    const src = grid.slice();
    for (let j = 1; j < nv - 1; j++) for (let i = 1; i < nu - 1; i++) {
      let acc = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) acc += src[(j + dj) * nu + i + di];
      grid[j * nu + i] = acc / 9;
    }
  }
  return contourPath(grid, nu, nv, uMin, vMin, h);
}

/** Occupancy silhouette of a triangle mesh projected along `view` (triangle rasterisation). */
function meshSilhouette(P, I, triCount, view, h = 0.004) {
  const lateral = view === 'left' || view === 'right';
  const uMin = lateral ? -0.45 : -0.66, uMax = lateral ? 0.45 : 0.66;
  const vMin = -1.79, vMax = 0.02;
  const nu = Math.ceil((uMax - uMin) / h) + 1, nv = Math.ceil((vMax - vMin) / h) + 1;
  const grid = new Float32Array(nu * nv).fill(1);
  const U = (i) => (lateral ? (view === 'left' ? -P[i * 3 + 2] : P[i * 3 + 2]) : view === 'posterior' ? -P[i * 3] : P[i * 3]);
  const V = (i) => -P[i * 3 + 1];
  for (let t = 0; t < triCount; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ax = (U(a) - uMin) / h, ay = (V(a) - vMin) / h, bx = (U(b) - uMin) / h, by = (V(b) - vMin) / h, cx = (U(c) - uMin) / h, cy = (V(c) - vMin) / h;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(nu - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(nv - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
      const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
      if (w0 >= -1e-6 && w1 >= -1e-6 && w0 + w1 <= 1 + 1e-6) grid[y * nu + x] = -1;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = grid.slice();
    for (let j = 1; j < nv - 1; j++) for (let i = 1; i < nu - 1; i++) {
      let acc = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) acc += src[(j + dj) * nu + i + di];
      grid[j * nu + i] = acc / 9;
    }
  }
  return contourPath(grid, nu, nv, uMin, vMin, h);
}

/** Body source for the fallback: MakeHuman mesh if loadable, else the procedural SDF. */
async function svgBodySource(opts) {
  if (opts.bodySource !== 'procedural') {
    try {
      const a = await loadBodyAsset({ sex: opts.sex, baseUrl: opts.modelsUrl });
      const triCount = a.groups.skin.count;
      const q = buildMeshQuery(a.positions, a.indices, a.normals, { triCount });
      return {
        skeleton: a.skeleton,
        silhouette: (view) => meshSilhouette(a.positions, a.indices, triCount, view),
        snap: (p, view) => q.snap(p, view),
        hit: (o, d) => { const r = q.raycast(o, d, 3); return r ? r.point : null; },
      };
    } catch { /* fall through to the procedural body */ }
  }
  const body = await svgBodySource(opts);
  return {
    skeleton: body.skeleton,
    silhouette: (view) => silhouette(body.sdf, view),
    snap: (p, view) => snapPoint(body.sdf, p, view),
    hit: (o, d) => { const t = sphereTrace(body.sdf, o, d, 3); return t < 0 ? null : [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]; },
  };
}

/**
 * @param {HTMLElement} container
 * @param {import('./viewer.js').ViewerOptions} opts
 * @returns {Promise<import('./viewer.js').BodyViewer>}
 */
export async function createSvgViewer(container, opts = {}) {
  const locale = opts.locale || 'en';
  const T = uiText(locale);
  const polarity = { ...DEFAULT_POLARITY, ...(opts.polarity || {}) };
  const pairColors = { ...PAIR_COLORS, ...(opts.pairColors || {}) };
  const body = await svgBodySource(opts);
  const skin = SKIN[opts.skinTone] || opts.skinTone || SKIN.medium;
  const silCache = new Map();
  const getSil = (view) => { if (!silCache.has(view)) silCache.set(view, body.silhouette(view)); return silCache.get(view); };

  container.classList.add('yh-viewer');
  const svg = el('svg', { class: 'yh-viewer__svg', role: 'application', 'aria-label': T.canvasLabel, 'aria-roledescription': T.roleDescription, tabindex: 0, preserveAspectRatio: 'xMidYMid meet' });
  const defs = el('defs');
  const grad = el('linearGradient', { id: `yh-skin-${Math.random().toString(36).slice(2)}`, x1: 0, x2: 1, y1: 0, y2: 0 });
  grad.append(el('stop', { offset: '0', 'stop-color': skin, 'stop-opacity': 0.82 }), el('stop', { offset: '0.5', 'stop-color': skin }), el('stop', { offset: '1', 'stop-color': skin, 'stop-opacity': 0.82 }));
  defs.appendChild(grad);
  const shadow = el('ellipse', { cx: 0, cy: 0.005, rx: 0.32, ry: 0.035, fill: '#1e293b', 'fill-opacity': 0.12 });
  const figure = el('g');
  const bodyPath = el('path', { fill: `url(#${grad.id})`, stroke: '#a77b5f', 'stroke-width': 0.0035, 'stroke-linejoin': 'round' });
  const gPairs = el('g'), gPoints = el('g'), gMagnets = el('g'), gLabels = el('g');
  figure.append(bodyPath, gPairs, gPoints, gMagnets, gLabels);
  svg.append(defs, shadow, figure);
  const tooltip = document.createElement('div');
  tooltip.className = 'yh-viewer__tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  const overlay = document.createElement('div');
  overlay.className = 'yh-viewer__overlay';
  overlay.appendChild(tooltip);
  const note = document.createElement('div');
  note.className = 'yh-viewer__note';
  note.textContent = T.fallbackNote;
  const list = document.createElement('ul');
  list.className = 'yh-viewer__a11y';
  list.setAttribute('aria-label', T.listLabel);
  const live = document.createElement('div');
  live.className = 'yh-viewer__live';
  live.setAttribute('aria-live', 'polite');
  container.append(svg, overlay, note, list, live);

  // instances snapped with the same SDF as the 3D viewer
  let instances = [];
  const byKey = new Map();
  function setPoints(points) {
    instances = buildInstances(points || []);
    byKey.clear();
    for (const inst of instances) {
      const r = body.snap([inst.pos.x, inst.pos.y, inst.pos.z], inst.view);
      inst.p = r.pos; inst.n = r.normal; inst.internal = r.internal;
      byKey.set(inst.key, inst);
    }
  }
  setPoints(opts.points);

  let view = 'anterior', zoom = 1, center = [0, -0.9];
  let filter = null, showAll = true, highlighted = new Set(), pulse = false, hovered = null;
  let magnets = [], pairs = [];
  const P = () => PROJ[view];
  const uv = (p) => [P().u(p), -p[1]];
  const facing = (inst) => inst.internal || (inst.n[0] * P().dir[0] + inst.n[1] * P().dir[1] + inst.n[2] * P().dir[2]) > 0.15;
  const magnetKeys = () => new Set(magnets.map((m) => resolveInstance(byKey, m.pointId, m.side)?.key).filter(Boolean));
  const visible = (inst, mk) => !mk.has(inst.key) && (!filter || filter.has(inst.id)) && (showAll || highlighted.has(inst.id) || !!filter) && facing(inst);

  function setViewBox() {
    const h = 1.86 / zoom, w = (view === 'left' || view === 'right' ? 0.8 : 1.3) / zoom;
    svg.setAttribute('viewBox', `${(center[0] - w / 2).toFixed(4)} ${(center[1] - h / 2).toFixed(4)} ${w.toFixed(4)} ${h.toFixed(4)}`);
  }

  function render() {
    bodyPath.setAttribute('d', getSil(view));
    setViewBox();
    const mk = magnetKeys();
    gPoints.textContent = '';
    for (const inst of instances) {
      inst.visible = visible(inst, mk);
      if (!inst.visible) continue;
      const [u, v] = uv(inst.p);
      const hl = highlighted.has(inst.id), hov = hovered === inst;
      const c = el('circle', {
        cx: u.toFixed(4), cy: v.toFixed(4), r: (hov ? 0.012 : 0.0085),
        fill: inst.internal ? 'none' : hov ? '#0ea5e9' : hl ? '#f59e0b' : '#1e3a5f',
        stroke: inst.internal ? '#7c3aed' : '#ffffff', 'stroke-width': inst.internal ? 0.004 : 0.0028,
        class: `yh-pt${hl && pulse ? ' is-pulse' : ''}`, 'data-key': inst.key,
      });
      gPoints.appendChild(c);
    }
    // magnets: side by side per point+side
    gMagnets.textContent = ''; gLabels.textContent = '';
    const groups = new Map();
    for (const m of magnets) {
      const inst = resolveInstance(byKey, m.pointId, m.side);
      if (!inst || !facing(inst)) continue;
      if (!groups.has(inst.key)) groups.set(inst.key, { inst, items: [] });
      groups.get(inst.key).items.push(m);
    }
    const tilePos = new Map();
    for (const { inst, items } of groups.values()) {
      const [u, v] = uv(inst.p);
      items.forEach((m, i) => {
        const cu = u + (i - (items.length - 1) / 2) * 0.033;
        tilePos.set(m.id, [cu, v]);
        const done = m.state === 'done';
        const g = el('g', { opacity: done ? 0.55 : 1 });
        g.append(el('rect', { x: cu - 0.015, y: v - 0.015, width: 0.03, height: 0.03, rx: 0.003, fill: polarity[m.polarity] || '#666', stroke: '#0f172a', 'stroke-opacity': 0.35, 'stroke-width': 0.0015 }));
        g.append(el('line', { x1: cu - 0.008, y1: v, x2: cu + 0.008, y2: v, stroke: '#fff', 'stroke-width': 0.004 }));
        if (m.polarity === 'positive') g.append(el('line', { x1: cu, y1: v - 0.008, x2: cu, y2: v + 0.008, stroke: '#fff', 'stroke-width': 0.004 }));
        gMagnets.appendChild(g);
      });
      const labels = [...new Set(items.map((m) => m.label).filter(Boolean))];
      if (labels.length) {
        const left = u < center[0];
        const t = el('text', { x: u + (left ? -1 : 1) * (0.022 + items.length * 0.016), y: v + 0.006, 'font-size': 0.022, 'font-family': 'system-ui, sans-serif', 'font-weight': 600, fill: '#0f172a', stroke: '#ffffff', 'stroke-width': 0.006, 'paint-order': 'stroke', 'text-anchor': left ? 'end' : 'start' });
        t.textContent = labels.join(' · ');
        gLabels.appendChild(t);
      }
    }
    // pairs
    gPairs.textContent = '';
    for (const pr of pairs) {
      const A = resolveInstance(byKey, pr.a.pointId, pr.a.side), B = resolveInstance(byKey, pr.b.pointId, pr.b.side);
      if (!A || !B) continue;
      const both = facing(A) && facing(B);
      let [au, av] = uv(A.p), [bu, bv] = uv(B.p);
      if (A === B) { au -= 0.017; bu += 0.017; }
      const mu = (au + bu) / 2, mv = (av + bv) / 2, du = bu - au, dv = bv - av, len = Math.hypot(du, dv) || 1;
      let nu = -dv / len, nv = du / len;
      if (nv > 0) { nu = -nu; nv = -nv; } // bow upward
      const lift = 0.02 + 0.25 * len;
      gPairs.appendChild(el('path', {
        d: `M${au},${av}Q${mu + nu * lift},${mv + nv * lift} ${bu},${bv}`, fill: 'none',
        stroke: pairColors[pr.state] || pairColors.candidate, 'stroke-width': 0.004, 'stroke-linecap': 'round',
        'stroke-dasharray': both ? 'none' : '0.01 0.008', opacity: both ? 1 : 0.6,
      }));
    }
    rebuildList();
  }

  function rebuildList() {
    list.textContent = '';
    for (const inst of instances.filter((i) => i.visible).sort((a, b) => b.p[1] - a.p[1])) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.key = inst.key;
      btn.textContent = `${localName(inst.point, locale)}${inst.side !== 'C' ? ` — ${sideLabel(inst.side, locale)}` : ''}`;
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function screenOf(inst) {
    const ctm = svg.getScreenCTM();
    const [u, v] = uv(inst.p);
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint(); pt.x = u; pt.y = v;
    const s = pt.matrixTransform(ctm);
    return { x: s.x, y: s.y };
  }
  function showTooltip(inst) {
    hovered = inst;
    if (!inst) { tooltip.hidden = true; render(); opts.onHover?.({ pointId: null, side: null }); return; }
    tooltip.textContent = `${localName(inst.point, locale)}${inst.side !== 'C' ? ` · ${sideLabel(inst.side, locale)}` : ''}`;
    const r = container.getBoundingClientRect(), s = screenOf(inst);
    tooltip.style.transform = `translate(${Math.round(s.x - r.left)}px, ${Math.round(s.y - r.top - 14)}px) translate(-50%, -100%)`;
    tooltip.hidden = false;
    render();
    opts.onHover?.({ pointId: inst.id, side: inst.side });
  }

  function setView(v) {
    view = PROJ[v] ? v : 'anterior';
    zoom = 1; center = [0, -0.9];
    live.textContent = T.views[view] || view;
    render();
  }

  // events
  const onMove = (ev) => {
    const k = ev.target?.getAttribute?.('data-key');
    const inst = k ? byKey.get(k) : null;
    if (inst !== hovered) showTooltip(inst);
  };
  const onClick = (ev) => {
    const k = ev.target?.getAttribute?.('data-key');
    if (k) { const inst = byKey.get(k); opts.onPointClick?.({ pointId: inst.id, side: inst.side, clientX: ev.clientX, clientY: ev.clientY }); return; }
    if (ev.target !== bodyPath) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const q = pt.matrixTransform(ctm.inverse());
    const y = -q.y;
    let o, d;
    if (view === 'anterior') { o = [q.x, y, 1]; d = [0, 0, -1]; }
    else if (view === 'posterior') { o = [-q.x, y, -1]; d = [0, 0, 1]; }
    else if (view === 'left') { o = [1, y, -q.x]; d = [-1, 0, 0]; }
    else { o = [-1, y, q.x]; d = [1, 0, 0]; }
    const hp = body.hit(o, d);
    if (!hp) return;
    const r = regionAt(hp, body.skeleton);
    opts.onRegionClick?.({ regionId: r.regionId, side: r.side, clientX: ev.clientX, clientY: ev.clientY });
  };
  const ORDER = ['anterior', 'right', 'posterior', 'left'];
  const onKey = (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const k = ev.key;
    let handled = true;
    if (k === 'ArrowLeft' || k === 'ArrowRight') setView(ORDER[(ORDER.indexOf(view) + (k === 'ArrowRight' ? 1 : 3)) % 4]);
    else if (k === 'f' || k === 'F') setView('anterior');
    else if (k === 'b' || k === 'B') setView('posterior');
    else if (k === '+' || k === '=') { zoom = Math.min(zoom * 1.25, 6); setViewBox(); }
    else if (k === '-' || k === '_') { zoom = Math.max(zoom / 1.25, 1); setViewBox(); }
    else handled = false;
    if (handled) ev.preventDefault();
  };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('click', onClick);
  svg.addEventListener('keydown', onKey);
  svg.addEventListener('pointerleave', () => showTooltip(null));
  list.addEventListener('focusin', (ev) => { const inst = byKey.get(ev.target?.dataset?.key); if (inst) showTooltip(inst); });
  list.addEventListener('focusout', () => showTooltip(null));
  list.addEventListener('click', (ev) => {
    const inst = byKey.get(ev.target?.dataset?.key);
    if (!inst) return;
    const s = screenOf(inst);
    opts.onPointClick?.({ pointId: inst.id, side: inst.side, clientX: s.x, clientY: s.y });
  });

  setView('anterior');

  return {
    renderer: 'svg',
    setView,
    setMagnets(l) { magnets = (l || []).filter((m) => m && m.pointId); render(); },
    setPairs(l) { pairs = (l || []).filter((p) => p && p.a && p.b); render(); },
    highlight(ids, o = {}) { highlighted = new Set(ids || []); pulse = !!o.pulse; render(); },
    setPointFilter(ids) { filter = ids ? new Set(ids) : null; render(); },
    setShowAllPoints(b) { showAll = !!b; render(); },
    focusPoint(pointId, side) {
      const inst = resolveInstance(byKey, pointId, side);
      if (!inst) return;
      const n = inst.n;
      const v = inst.internal ? view : Math.abs(n[0]) > Math.abs(n[2]) + 0.2 ? (n[0] > 0 ? 'left' : 'right') : n[2] >= 0 ? 'anterior' : 'posterior';
      if (v !== view) setView(v);
      const [u, vv] = uv(inst.p);
      zoom = 2.5; center = [u, vv];
      showTooltip(inst);
    },
    async snapshot(o = {}) {
      const width = Math.round(o.width || 800), height = Math.round(o.height || 1100);
      const prev = { view, zoom, center, showAll, hovered };
      hovered = null;
      if (!o.includePoints) showAll = false;
      view = PROJ[o.view] ? o.view : 'anterior'; zoom = 1; center = [0, -0.9];
      render();
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', NS);
      clone.setAttribute('width', width); clone.setAttribute('height', height);
      if (!o.transparent) clone.insertBefore(el('rect', { x: -10, y: -10, width: 20, height: 20, fill: '#ffffff' }), clone.firstChild);
      const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        return c.toDataURL('image/png');
      } finally {
        URL.revokeObjectURL(url);
        ({ view, zoom, center, showAll, hovered } = prev);
        render();
      }
    },
    resize() { render(); },
    dispose() {
      svg.remove(); overlay.remove(); note.remove(); list.remove(); live.remove();
      container.classList.remove('yh-viewer');
    },
  };
}
