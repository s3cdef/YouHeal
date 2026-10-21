// 2D body map — a stand-in that implements the CONTRACT §6 viewer interface with SVG
// (interactive) and Canvas (snapshot). Used when /js/viewer3d/viewer.js is unavailable.
// Frame (§4.3): meters, feet y=0, vertex ≈1.75, body faces +z, +x = patient's LEFT.
import { svgEl, el, clear } from '../ui/dom.js';
import { locText, t } from '../i18n.js';

// Screen units: X = x*1000 (front), Y = (1.80 - y)*1000.
const SIL_FRONT = [
  // head + neck
  'M0 52C-46 52-80 92-80 160C-80 214-60 252-40 268L-42 322L42 322L40 268C60 252 80 214 80 160C80 92 46 52 0 52Z',
  // torso
  'M-50 318C-110 328-185 335-202 382C-210 432-182 482-170 540C-160 640-135 700-138 760C-142 820-182 860-180 920L-178 1004L178 1004L180 920C182 860 142 820 138 760C135 700 160 640 170 540C182 482 210 432 202 382C185 335 110 328 50 318Z',
  // right arm (screen left)
  'M-198 372C-242 396-252 468-258 540L-292 752C-312 832-330 900-344 960C-366 992-378 1060-352 1082C-330 1096-306 1072-300 1040C-296 1010-300 982-300 962C-282 900-258 830-246 760L-208 566C-198 520-190 480-184 446Z',
  // left arm
  'M198 372C242 396 252 468 258 540L292 752C312 832 330 900 344 960C366 992 378 1060 352 1082C330 1096 306 1072 300 1040C296 1010 300 982 300 962C282 900 258 830 246 760L208 566C198 520 190 480 184 446Z',
  // right leg
  'M-180 900C-188 1050-162 1200-142 1300C-126 1400-136 1560-112 1706L-118 1762C-132 1792-62 1802-46 1782L-40 1704C-34 1600-60 1420-46 1300C-32 1180-20 1060-8 1000L-8 900Z',
  // left leg
  'M180 900C188 1050 162 1200 142 1300C126 1400 136 1560 112 1706L118 1762C132 1792 62 1802 46 1782L40 1704C34 1600 60 1420 46 1300C32 1180 20 1060 8 1000L8 900Z',
];
const DETAIL_FRONT = [
  'M-40 336C-80 344-120 346-160 360', 'M40 336C80 344 120 346 160 360', // clavicles
  'M0 360L0 720', 'M-4 760a4 4 0 1 0 8 0a4 4 0 1 0-8 0', // midline + navel
  'M-95 560C-70 590-30 592 0 580C30 592 70 590 95 560', // pectoral line
  'M-120 880C-80 940-30 980 0 1000C30 980 80 940 120 880', // inguinal
  'M-112 1290C-96 1306-74 1306-62 1290', 'M112 1290C96 1306 74 1306 62 1290', // knees
];
const DETAIL_BACK = [
  'M0 330L0 960', // spine
  'M-150 420C-120 470-110 540-120 590C-90 570-60 520-58 450', 'M150 420C120 470 110 540 120 590C90 570 60 520 58 450', // scapulae
  'M-150 900C-110 940-40 950 0 930C40 950 110 940 150 900', 'M0 930L0 1000', // gluteal
  'M-118 1300C-96 1290-70 1290-56 1300', 'M118 1300C96 1290 70 1290 56 1300', // popliteal creases
];
// Lateral profile (screen X = z*1000 with face toward +X; mirrored per view).
const SIL_SIDE = [
  'M10 52C-50 52-92 98-92 164C-92 214-74 250-56 266L-50 324L42 324L46 280C70 270 86 250 92 230L104 196C108 182 98 176 92 172C92 108 64 52 10 52Z',
  'M-52 318C-108 340-120 420-118 520C-116 620-100 700-104 780C-108 840-128 900-118 960L-96 1004L110 1004C120 960 128 900 116 840C110 760 118 700 120 640C124 560 138 480 120 400C108 350 80 324 42 318Z',
  'M-30 380C-60 420-60 520-50 620L-30 780C-20 860-10 940 0 1000C20 1060 40 1060 40 1030L36 960C30 880 30 800 34 760L40 600C44 500 40 420 20 380Z',
  'M-100 960C-110 1100-96 1220-70 1310C-60 1400-80 1560-70 1706L-76 1766C-80 1792 90 1800 104 1780C110 1764 60 1752 30 1740L20 1700C16 1560 34 1420 40 1310C60 1220 96 1100 100 980Z',
];

const VIEW_ORDER = ['anterior', 'posterior', 'left', 'right'];

function project(view, x, y, z) {
  const Y = (1.80 - y) * 1000;
  switch (view) {
    case 'posterior': return { X: -x * 1000, Y };
    case 'left': return { X: -z * 1000, Y };   // camera at +x (patient's left), face on screen-left
    case 'right': return { X: z * 1000, Y };   // camera at −x, face on screen-right
    default: return { X: x * 1000, Y };
  }
}

/** Instances of a point for a given side: bilateral pos is patient-RIGHT (x<0); left is mirrored. */
function instances(point, side) {
  const p = point.pos || { x: 0, y: 1, z: 0 };
  if (point.laterality !== 'bilateral') return [{ side: 'C', pos: p }];
  const right = { side: 'R', pos: { x: -Math.abs(p.x), y: p.y, z: p.z } };
  const left = { side: 'L', pos: { x: Math.abs(p.x), y: p.y, z: p.z } };
  if (side === 'R') return [right];
  if (side === 'L') return [left];
  return [right, left];
}

function visibleIn(view, point, inst) {
  const v = point.view || 'anterior';
  const z = inst.pos.z;
  if (view === 'anterior') return v === 'anterior' || v === 'internal' || v === 'superior' || (v === 'lateral' && z >= -0.02) || v === 'inferior';
  if (view === 'posterior') return v === 'posterior' || (v === 'lateral' && z <= 0.02) || v === 'inferior';
  if (view === 'left') return inst.side !== 'R';
  if (view === 'right') return inst.side !== 'L';
  return true;
}

function silhouetteFor(view) {
  if (view === 'left' || view === 'right') {
    return { sil: SIL_SIDE, detail: [], flip: view === 'left' };
  }
  return { sil: SIL_FRONT, detail: view === 'posterior' ? DETAIL_BACK : DETAIL_FRONT, flip: false };
}

const STATE_STYLE = {
  candidate: { stroke: '#8A94A0', dash: '10 10', width: 3 },
  found: { stroke: '#B45309', dash: null, width: 4 },
  impacted: { stroke: '#7C3AED', dash: null, width: 4 },
  cleared: { stroke: '#15803D', dash: '2 8', width: 4 },
};

export async function createBodyMap2D(container, opts = {}) {
  const points = new Map((opts.points || []).map((p) => [p.id, p]));
  let polarity = { negative: '#2563EB', positive: '#DC2626', ...(opts.polarity || {}) };
  let view = 'anterior';
  let magnets = [];
  let pairs = [];
  let highlighted = new Set();
  let filter = null;
  let showAll = true;
  let focused = null;

  const svg = svgEl('svg', { class: 'bm2d-svg', viewBox: '-520 20 1040 1800', role: 'group', 'aria-label': t('viewer.bodyMap'), preserveAspectRatio: 'xMidYMid meet' });
  const root = el('div.bm2d', svg);
  container.append(root);

  function draw() {
    clear(svg);
    const { sil, detail, flip } = silhouetteFor(view);
    const g = svgEl('g', { transform: flip ? 'scale(-1,1)' : null });
    for (const d of sil) g.append(svgEl('path', { d, class: 'bm2d-body' }));
    for (const d of detail) g.append(svgEl('path', { d, class: 'bm2d-detail' }));
    svg.append(g);
    svg.append(svgEl('text', { x: -500, y: 70, class: 'bm2d-viewlabel' }, t(`viewer.views.${view}`)));
    if (view === 'anterior' || view === 'posterior') {
      // orientation hint: which side of the screen is patient's R/L
      const rightOnScreenLeft = view === 'anterior';
      svg.append(svgEl('text', { x: -500, y: 1790, class: 'bm2d-side' }, rightOnScreenLeft ? t('side.Rshort') : t('side.Lshort')));
      svg.append(svgEl('text', { x: 500, y: 1790, class: 'bm2d-side', 'text-anchor': 'end' }, rightOnScreenLeft ? t('side.Lshort') : t('side.Rshort')));
    }

    // pairs (field lines)
    const pairLayer = svgEl('g', { class: 'bm2d-pairs' });
    for (const pr of pairs) {
      const a = locate(pr.a); const b = locate(pr.b);
      if (!a || !b) continue;
      const st = STATE_STYLE[pr.state] || STATE_STYLE.candidate;
      const mx = (a.X + b.X) / 2; const my = (a.Y + b.Y) / 2;
      const dx = b.X - a.X; const dy = b.Y - a.Y; const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(120, len * 0.25) + (a.X === b.X && a.Y === b.Y ? 60 : 0);
      const cx = mx - (dy / len) * bow; const cy = my + (dx / len) * bow;
      pairLayer.append(svgEl('path', { d: `M${a.X} ${a.Y}Q${cx} ${cy} ${b.X} ${b.Y}`, fill: 'none', stroke: st.stroke, 'stroke-width': st.width, 'stroke-dasharray': st.dash, 'stroke-linecap': 'round', opacity: 0.85 }));
    }
    svg.append(pairLayer);

    // points
    const ptLayer = svgEl('g', { class: 'bm2d-points' });
    for (const p of points.values()) {
      const visibleByFilter = filter ? filter.has(p.id) : true;
      const shown = (showAll && visibleByFilter) || highlighted.has(p.id) || (filter && filter.has(p.id));
      if (!shown) continue;
      for (const inst of instances(p)) {
        if (!visibleIn(view, p, inst)) continue;
        const { X, Y } = project(view, inst.pos.x, inst.pos.y, inst.pos.z);
        const hl = highlighted.has(p.id);
        const isFocus = focused && focused.pointId === p.id && (focused.side === inst.side || !focused.side || focused.side === 'C');
        const name = locText(p.name);
        const node = svgEl('g', {
          class: `bm2d-point${hl ? ' is-hl' : ''}${isFocus ? ' is-focus' : ''}${p.view === 'internal' ? ' is-internal' : ''}`,
          transform: `translate(${X} ${Y})`, tabindex: 0, role: 'button',
          'aria-label': inst.side === 'C' ? name : `${name} (${t(`side.${inst.side}`)})`,
          'data-point': p.id, 'data-side': inst.side,
        },
        hl ? svgEl('circle', { r: 30, class: 'bm2d-pulse' }) : null,
        svgEl('circle', { r: 22, class: 'bm2d-hit' }),
        svgEl('circle', { r: hl || isFocus ? 11 : 8, class: 'bm2d-dot' }),
        svgEl('title', {}, name));
        const fire = (e) => {
          const r = node.getBoundingClientRect();
          opts.onPointClick && opts.onPointClick({ pointId: p.id, side: inst.side, clientX: e.clientX || r.left + r.width / 2, clientY: e.clientY || r.top + r.height / 2 });
        };
        node.addEventListener('click', fire);
        node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(e); } });
        node.addEventListener('pointerenter', () => opts.onHover && opts.onHover({ pointId: p.id, side: inst.side }));
        node.addEventListener('pointerleave', () => opts.onHover && opts.onHover({ pointId: null, side: null }));
        ptLayer.append(node);
      }
    }
    svg.append(ptLayer);

    // magnets
    const magLayer = svgEl('g', { class: 'bm2d-magnets' });
    for (const m of layoutMagnets(view)) {
      const col = m.polarity === 'negative' ? polarity.negative : polarity.positive;
      const g2 = svgEl('g', { transform: `translate(${m.X} ${m.Y})`, class: `bm2d-magnet${m.state === 'done' ? ' is-done' : ''}` },
        svgEl('rect', { x: -21, y: -21, width: 42, height: 42, rx: 6, fill: col, stroke: '#ffffff', 'stroke-width': 4 }),
        svgEl('text', { x: 0, y: 12, 'text-anchor': 'middle', class: 'bm2d-glyph' }, m.polarity === 'negative' ? '−' : '+'),
        m.label ? svgEl('text', { x: 0, y: -30, 'text-anchor': 'middle', class: 'bm2d-mlabel' }, m.label) : null);
      magLayer.append(g2);
    }
    svg.append(magLayer);
  }

  function locate(ref) {
    const p = points.get(ref.pointId); if (!p) return null;
    const inst = instances(p, ref.side === 'RL' ? 'R' : ref.side)[0];
    if (!inst || !visibleIn(view, p, inst)) return null;
    return project(view, inst.pos.x, inst.pos.y, inst.pos.z);
  }

  function layoutMagnets(v) {
    const groups = new Map();
    for (const m of magnets) {
      const p = points.get(m.pointId); if (!p) continue;
      for (const inst of instances(p, m.side === 'RL' ? null : m.side)) {
        if (!visibleIn(v, p, inst)) continue;
        const { X, Y } = project(v, inst.pos.x, inst.pos.y, inst.pos.z);
        const key = `${Math.round(X)}:${Math.round(Y)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...m, X, Y });
      }
    }
    const out = [];
    for (const list of groups.values()) {
      list.sort((a, b) => (a.polarity === b.polarity ? 0 : a.polarity === 'negative' ? -1 : 1));
      const n = list.length;
      list.forEach((m, i) => out.push({ ...m, X: m.X + (i - (n - 1) / 2) * 46 }));
    }
    return out;
  }

  draw();

  const api = {
    kind: '2d',
    setView(v) { if (VIEW_ORDER.includes(v)) { view = v; draw(); } else if (v === 'superior') { view = 'anterior'; draw(); } },
    getView() { return view; },
    setMagnets(list) { magnets = list || []; draw(); },
    setPairs(list) { pairs = list || []; draw(); },
    highlight(ids) { highlighted = new Set(ids || []); draw(); },
    setPointFilter(ids) { filter = ids ? new Set(ids) : null; draw(); },
    setShowAllPoints(b) { showAll = !!b; draw(); },
    setPolarity(p) { polarity = { ...polarity, ...p }; draw(); },
    focusPoint(pointId, side) {
      const p = points.get(pointId); if (!p) return;
      focused = { pointId, side };
      const pv = p.view === 'posterior' ? 'posterior' : 'anterior';
      if ((view === 'anterior' || view === 'posterior') && view !== pv) view = pv;
      draw();
      const n = svg.querySelector(`.bm2d-point[data-point="${CSS.escape(pointId)}"]`);
      if (n) n.focus({ preventScroll: true });
    },
    async snapshot({ view: v = 'anterior', width = 800, height = 1100, transparent = false } = {}) {
      return snapshot2D({ points, magnets, pairs, polarity, view: v, width, height, transparent, layoutMagnets, project, instances, visibleIn });
    },
    resize() {},
    dispose() { root.remove(); },
  };
  return api;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function snapshot2D({ magnets, pairs, polarity, view, width, height, transparent, layoutMagnets, project: proj, instances: inst, visibleIn: vis, points }) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); }
  // viewBox -520 20 1040 1800 → fit
  const vbW = 1040; const vbH = 1800;
  const s = Math.min(width / vbW, height / vbH);
  const ox = (width - vbW * s) / 2 + 520 * s; const oy = (height - vbH * s) / 2 - 20 * s;
  ctx.save();
  ctx.translate(ox, oy); ctx.scale(s, s);
  const { sil, detail, flip } = silhouetteFor(view);
  ctx.save();
  if (flip) ctx.scale(-1, 1);
  const grad = ctx.createLinearGradient(0, 40, 0, 1800);
  grad.addColorStop(0, '#E9E1D3'); grad.addColorStop(1, '#D9CDB8');
  ctx.fillStyle = grad;
  for (const d of sil) ctx.fill(new Path2D(d));
  ctx.strokeStyle = 'rgba(120,100,70,0.35)'; ctx.lineWidth = 3;
  for (const d of detail) ctx.stroke(new Path2D(d));
  ctx.restore();
  // pair lines
  for (const pr of pairs) {
    const loc = (ref) => {
      const p = points.get(ref.pointId); if (!p) return null;
      const i = inst(p, ref.side === 'RL' ? 'R' : ref.side)[0];
      if (!i || !vis(view, p, i)) return null;
      return proj(view, i.pos.x, i.pos.y, i.pos.z);
    };
    const a = loc(pr.a); const b = loc(pr.b); if (!a || !b) continue;
    const st = STATE_STYLE[pr.state] || STATE_STYLE.candidate;
    ctx.strokeStyle = st.stroke; ctx.globalAlpha = 0.7; ctx.lineWidth = st.width;
    ctx.setLineDash(st.dash ? st.dash.split(' ').map(Number) : []);
    const mx = (a.X + b.X) / 2; const my = (a.Y + b.Y) / 2; const dx = b.X - a.X; const dy = b.Y - a.Y; const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(120, len * 0.25) + (len < 2 ? 60 : 0);
    ctx.beginPath(); ctx.moveTo(a.X, a.Y); ctx.quadraticCurveTo(mx - (dy / len) * bow, my + (dx / len) * bow, b.X, b.Y); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  // magnets
  for (const m of layoutMagnets(view)) {
    ctx.fillStyle = m.polarity === 'negative' ? polarity.negative : polarity.positive;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5;
    const r = 24;
    ctx.beginPath(); ctx.roundRect(m.X - r, m.Y - r, r * 2, r * 2, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = `700 40px ${cssVar('--font-ui', 'system-ui, sans-serif')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(m.polarity === 'negative' ? '−' : '+', m.X, m.Y + 2);
    if (m.label) {
      ctx.font = `700 30px ${cssVar('--font-ui', 'system-ui, sans-serif')}`; ctx.fillStyle = '#1C2329';
      ctx.fillText(m.label, m.X, m.Y - r - 20);
    }
  }
  ctx.restore();
  // caption
  ctx.fillStyle = '#5B6670'; ctx.font = `600 ${Math.round(height * 0.022)}px ${cssVar('--font-ui', 'system-ui, sans-serif')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(t(`viewer.views.${view}`).toUpperCase(), Math.round(width * 0.04), Math.round(height * 0.02));
  return Promise.resolve(canvas.toDataURL('image/png'));
}
