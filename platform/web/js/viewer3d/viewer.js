/**
 * YOU HEAL Clinical — 3D body viewer (CONTRACT §6).
 *
 * Host page requirements:
 *  - link the stylesheet `/js/viewer3d/viewer.css` (no styles are injected;
 *    strict CSP `style-src 'self'`);
 *  - give the container a size (the viewer fills it and tracks resizes).
 *
 * @example
 *   import { createBodyViewer } from '/js/viewer3d/viewer.js';
 *   const viewer = await createBodyViewer(el, { points, regions, locale: 'en' });
 *
 * @module viewer3d/viewer
 */
import * as THREE from '../../vendor/three/three.module.js';
import { OrbitControls } from '../../vendor/three/OrbitControls.js';
import { RoundedBoxGeometry } from '../../vendor/three/RoundedBoxGeometry.js';
import { createBodyModel } from './body-model.js';
import { buildInstances, localName, sideLabel, uiText, PAIR_COLORS, DEFAULT_POLARITY, resolveInstance } from './viewer-common.js';

/**
 * @typedef {object} CatalogPoint
 * @property {string} id
 * @property {{es:string, en?:string}} [name]
 * @property {'central'|'bilateral'} [laterality]
 * @property {string} [region]
 * @property {'anterior'|'posterior'|'lateral'|'superior'|'inferior'|'internal'} view
 * @property {{x:number,y:number,z:number}} pos
 */

/**
 * @typedef {object} ViewerOptions
 * @property {CatalogPoint[]} [points]   from GET /catalog/points
 * @property {object[]} [regions]        from GET /catalog/regions
 * @property {string} [locale='en']      'en' | 'es'
 * @property {{negative:string, positive:string}} [polarity]
 * @property {'female'|'male'|'neutral'} [sex='neutral']
 * @property {string} [skinTone]         SKIN_TONES key ('light','medium','tan','deep','clinical') or hex
 * @property {(e:{pointId:string, side:'R'|'L'|'C', clientX:number, clientY:number})=>void} [onPointClick]
 * @property {(e:{regionId:string, side:'R'|'L'|'C', clientX:number, clientY:number})=>void} [onRegionClick]
 * @property {(e:{pointId:string|null, side:'R'|'L'|'C'|null})=>void} [onHover]
 * @property {object} [model]            a BodyModel (see body-model.js) to use instead of the procedural mannequin
 * @property {boolean} [forceFallback]   render the 2D SVG fallback even if WebGL works
 * @property {'auto'|'procedural'} [bodySource] 'auto' (default): MakeHuman asset, procedural fallback
 * @property {string} [modelsUrl]        base URL of the body assets (default: /assets/models/ next to this module tree)
 * @property {Record<string,string>} [pairColors] colours per pair state
 */

/**
 * The viewer API (identical for the WebGL viewer and the SVG fallback).
 * @typedef {object} BodyViewer
 * @property {(view:'anterior'|'posterior'|'left'|'right'|'superior')=>void} setView
 * @property {(magnets:{id:string, pointId:string, side:'R'|'L'|'C', polarity:'negative'|'positive', label?:string, state?:'active'|'done'}[])=>void} setMagnets
 * @property {(pairs:{id:string, a:{pointId:string, side:string}, b:{pointId:string, side:string}, state:'candidate'|'found'|'impacted'|'cleared'}[])=>void} setPairs
 * @property {(pointIds:string[], opts?:{pulse?:boolean})=>void} highlight
 * @property {(pointIds:string[]|null)=>void} setPointFilter
 * @property {(show:boolean)=>void} setShowAllPoints
 * @property {(pointId:string, side?:'R'|'L'|'C')=>void} focusPoint
 * @property {(o?:{view?:string, width?:number, height?:number, transparent?:boolean, includePoints?:boolean})=>Promise<string>} snapshot
 * @property {()=>void} resize
 * @property {()=>void} dispose
 * @property {'webgl'|'svg'} renderer
 */

/** True when a WebGL context can be created. */
export function webglAvailable() {
  return probeWebGL().available;
}

let probeCache = null;
/**
 * Probe WebGL once: availability and whether the rasteriser is software
 * (SwiftShader / llvmpipe / Microsoft Basic Render — common on clinic VMs and
 * remote desktops), where MSAA and high pixel ratios cost hundreds of ms per frame.
 * @returns {{available:boolean, software:boolean, renderer:string}}
 */
export function probeWebGL() {
  if (probeCache) return probeCache;
  let res = { available: false, software: false, renderer: '' };
  try {
    const c = document.createElement('canvas');
    const gl = window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'));
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
      res = { available: true, software: /swiftshader|llvmpipe|softpipe|basic render|software/i.test(name), renderer: name };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL */ }
  probeCache = res;
  return res;
}

const VIEW_DIRS = {
  anterior: new THREE.Vector3(0, 0, 1),
  posterior: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(1, 0, 0),   // patient's left (+x)
  right: new THREE.Vector3(-1, 0, 0),
  superior: new THREE.Vector3(0, 1, 0.12).normalize(),
};
const BODY_CENTER = new THREE.Vector3(0, 0.885, 0.0);
const TARGET_BOX = new THREE.Box3(new THREE.Vector3(-0.5, 0.0, -0.25), new THREE.Vector3(0.5, 1.8, 0.25));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Create the body viewer inside `container`.
 * @param {HTMLElement} container
 * @param {ViewerOptions} [opts]
 * @returns {Promise<BodyViewer>}
 */
export async function createBodyViewer(container, opts = {}) {
  if (opts.forceFallback || !webglAvailable()) {
    const { createSvgViewer } = await import('./viewer-svg.js');
    return createSvgViewer(container, opts);
  }
  let renderer;
  try {
    // software rasterisers: no MSAA (≈3x cheaper frames); smooth edges still come from the 1:1 pixel ratio cap below
    renderer = new THREE.WebGLRenderer({ antialias: !probeWebGL().software, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  } catch {
    const { createSvgViewer } = await import('./viewer-svg.js');
    return createSvgViewer(container, opts);
  }

  const locale = opts.locale || 'en';
  const T = uiText(locale);
  const polarity = { ...DEFAULT_POLARITY, ...(opts.polarity || {}) };
  const pairColors = { ...PAIR_COLORS, ...(opts.pairColors || {}) };
  const reduceMotionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(reduceMotionMQ && reduceMotionMQ.matches);

  // ---------------------------------------------------------------- DOM
  container.classList.add('yh-viewer');
  const canvas = renderer.domElement;
  canvas.classList.add('yh-viewer__canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', T.canvasLabel);
  canvas.setAttribute('aria-roledescription', T.roleDescription);
  const overlay = document.createElement('div');
  overlay.className = 'yh-viewer__overlay';
  const tooltip = document.createElement('div');
  tooltip.className = 'yh-viewer__tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.id = `yh-tt-${Math.random().toString(36).slice(2)}`;
  tooltip.hidden = true;
  overlay.appendChild(tooltip);
  const loading = document.createElement('div');
  loading.className = 'yh-viewer__loading';
  loading.textContent = T.loading;
  const list = document.createElement('ul');
  list.className = 'yh-viewer__a11y';
  list.setAttribute('aria-label', T.listLabel);
  const live = document.createElement('div');
  live.className = 'yh-viewer__live';
  live.setAttribute('aria-live', 'polite');
  container.append(canvas, overlay, loading, list, live);

  // ---------------------------------------------------------------- renderer / scene
  renderer.setPixelRatio(probeWebGL().software ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  // start loading the body (worker) before any GPU work so both overlap
  const modelP = opts.model ? Promise.resolve(opts.model) : createBodyModel({ sex: opts.sex || 'neutral', tone: opts.skinTone || 'medium', source: opts.bodySource, modelsUrl: opts.modelsUrl });

  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 30);
  scene.add(camera);
  // studio rig attached to the camera: consistent modelling from any angle
  // (no PMREM environment map: on software GL it cost ~0.8 s of GPU time and forced a full shader
  //  recompile; a slightly stronger sky light + a soft frontal fill give an equivalent look)
  scene.add(new THREE.HemisphereLight(0xfdfbf7, 0x9c8f86, 1.05));
  const front = new THREE.DirectionalLight(0xfff8f2, 0.35);
  front.position.set(0, 0.3, 3);
  const key = new THREE.DirectionalLight(0xfff2e6, 2.6);
  key.position.set(-2.6, 2.8, 2.6);
  const fill = new THREE.DirectionalLight(0xe8eeff, 0.55);
  fill.position.set(2.6, 0.6, 2.0);
  const rimL = new THREE.DirectionalLight(0xdfe8ff, 1.5);
  rimL.position.set(-3, 1.6, -2.5);
  const rimR = new THREE.DirectionalLight(0xfff1e6, 1.2);
  rimR.position.set(3, 1.2, -2.5);
  for (const l of [key, fill, rimL, rimR, front]) { camera.add(l); camera.add(l.target); l.target.position.set(0, 0, -3); }

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = !reduceMotion();
  controls.dampingFactor = 0.09;
  controls.minDistance = 0.35;
  controls.maxDistance = 6.5;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  controls.target.copy(BODY_CENTER);

  // ---------------------------------------------------------------- model
  const model = await modelP;
  scene.add(model.object3d);
  loading.remove();

  // ---------------------------------------------------------------- points
  /** @type {ReturnType<typeof buildInstances>} */
  let instances = [];
  const byKey = new Map();
  const RIM_R = 0.0085, CORE_R = 0.0058;
  const rimGeo = new THREE.CircleGeometry(RIM_R, 24);
  const coreGeo = new THREE.CircleGeometry(CORE_R, 24);
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, toneMapped: false });
  const ringTex = makeRingTexture();
  let rims = null, cores = null;
  const internalGroup = new THREE.Group();
  scene.add(internalGroup);
  const COLOR_POINT = new THREE.Color('#1e3a5f');
  const COLOR_HOVER = new THREE.Color('#0ea5e9');
  const COLOR_HL = new THREE.Color('#f59e0b');
  const COLOR_INTERNAL = new THREE.Color('#7c3aed');

  let filter = null;        // Set<string> | null
  let showAll = true;
  let highlighted = new Set();
  let pulse = false;
  let hovered = null;       // instance
  let magnetKeys = new Set();

  function setPoints(points) {
    instances = buildInstances(points || []);
    byKey.clear();
    for (const inst of instances) {
      const s = model.snap(inst.pos, inst.view);
      inst.position = s.position;
      inst.normal = s.normal.normalize();
      inst.internal = s.internal;
      byKey.set(inst.key, inst);
    }
    rebuildPointMeshes();
  }

  function rebuildPointMeshes() {
    if (rims) { scene.remove(rims, cores); rims.dispose(); cores.dispose(); }
    internalGroup.children.slice().forEach((s) => { internalGroup.remove(s); s.material.dispose(); });
    const surf = instances.filter((i) => !i.internal);
    rims = new THREE.InstancedMesh(rimGeo, rimMat, Math.max(surf.length, 1));
    cores = new THREE.InstancedMesh(coreGeo, coreMat, Math.max(surf.length, 1));
    rims.name = 'point-rims'; cores.name = 'point-cores';
    rims.count = cores.count = surf.length;
    surf.forEach((inst, i) => { inst.slot = i; });
    for (const inst of instances.filter((i) => i.internal)) {
      const m = new THREE.SpriteMaterial({ map: ringTex, color: COLOR_INTERNAL, depthTest: false, transparent: true, opacity: 0.55, toneMapped: false });
      const sp = new THREE.Sprite(m);
      sp.position.copy(inst.position);
      sp.scale.setScalar(0.026);
      sp.renderOrder = 5;
      sp.userData.inst = inst;
      inst.sprite = sp;
      internalGroup.add(sp);
    }
    scene.add(rims, cores);
    updatePointMatrices(performance.now());
  }

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  const _z = new THREE.Vector3(0, 0, 1);
  function isVisible(inst) {
    if (magnetKeys.has(inst.key)) return false;
    if (filter && !filter.has(inst.id)) return false;
    if (!showAll && !highlighted.has(inst.id) && !filter) return false;
    return true;
  }
  function updatePointMatrices(now) {
    if (!rims) return;
    const pulseScale = pulse && !reduceMotion() ? 1 + 0.32 * (0.5 + 0.5 * Math.sin(now / 260)) : 1.25;
    for (const inst of instances) {
      const vis = isVisible(inst);
      inst.visible = vis;
      const hl = highlighted.has(inst.id);
      const hov = hovered === inst;
      if (inst.internal) {
        inst.sprite.visible = vis;
        inst.sprite.material.color.copy(hov ? COLOR_HOVER : hl ? COLOR_HL : COLOR_INTERNAL);
        inst.sprite.scale.setScalar(0.026 * (hov ? 1.5 : hl ? pulseScale : 1));
        continue;
      }
      const sc = vis ? (hov ? 1.7 : hl ? pulseScale : 1) : 0;
      _q.setFromUnitVectors(_z, inst.normal);
      _p.copy(inst.position).addScaledVector(inst.normal, 0.0012);
      _s.set(sc, sc, sc);
      _m.compose(_p, _q, _s);
      rims.setMatrixAt(inst.slot, _m);
      _p.addScaledVector(inst.normal, 0.0004);
      _m.compose(_p, _q, _s);
      cores.setMatrixAt(inst.slot, _m);
      cores.setColorAt(inst.slot, hov ? COLOR_HOVER : hl ? COLOR_HL : COLOR_POINT);
    }
    rims.instanceMatrix.needsUpdate = true;
    cores.instanceMatrix.needsUpdate = true;
    if (cores.instanceColor) cores.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- magnets
  const magnetGroup = new THREE.Group();
  magnetGroup.name = 'magnets';
  scene.add(magnetGroup);
  const TILE = 0.03, TILE_H = 0.0075;
  const tileGeo = new RoundedBoxGeometry(TILE, TILE, TILE_H, 3, 0.0022);
  const magnetMats = new Map();
  const labelEls = [];
  function magnetMaterials(pol, state) {
    const k = `${pol}:${state}`;
    if (magnetMats.has(k)) return magnetMats.get(k);
    const color = polarity[pol] || '#666';
    const done = state === 'done';
    const tex = makeMagnetTexture(color, pol === 'negative' ? '−' : '+', done);
    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.05, transparent: done, opacity: done ? 0.55 : 1 });
    const sideC = new THREE.Color(color).multiplyScalar(0.62);
    const side = new THREE.MeshStandardMaterial({ color: sideC, roughness: 0.5, metalness: 0.05, transparent: done, opacity: done ? 0.55 : 1 });
    const mats = [side, side, side, side, top, side];
    magnetMats.set(k, mats);
    return mats;
  }
  let magnets = [];
  function tangentFrame(n) {
    const up = Math.abs(n.y) > 0.92 ? new THREE.Vector3(0, 0, n.y > 0 ? -1 : 1) : new THREE.Vector3(0, 1, 0);
    const y = up.clone().addScaledVector(n, -up.dot(n)).normalize();
    const x = new THREE.Vector3().crossVectors(y, n).normalize();
    return { x, y };
  }
  function placeOnSkin(p, n) {
    const o = p.clone().addScaledVector(n, 0.05);
    const h = model.raycast(o, n.clone().negate(), 0.1);
    return h ? { p: h.point, n: h.normal.normalize() } : { p, n };
  }
  /** Placement of magnet tiles: magnets on the same point+side sit side by side. */
  function magnetPlacements() {
    const groups = new Map();
    for (const m of magnets) {
      const inst = resolveInstance(byKey, m.pointId, m.side);
      if (!inst) continue;
      const k = inst.key;
      if (!groups.has(k)) groups.set(k, { inst, items: [] });
      groups.get(k).items.push(m);
    }
    const out = [];
    for (const { inst, items } of groups.values()) {
      const { x } = tangentFrame(inst.normal);
      items.forEach((m, i) => {
        const off = (i - (items.length - 1) / 2) * (TILE + 0.003);
        let p = inst.position.clone(), n = inst.normal.clone();
        if (off !== 0 && !inst.internal) ({ p, n } = placeOnSkin(p.clone().addScaledVector(x, off), n));
        else if (off !== 0) p.addScaledVector(x, off);
        out.push({ m, inst, p, n, groupSize: items.length, index: i });
      });
    }
    return out;
  }
  function rebuildMagnets() {
    magnetGroup.children.slice().forEach((c) => magnetGroup.remove(c));
    labelEls.splice(0).forEach((l) => l.el.remove());
    magnetKeys = new Set();
    const placed = magnetPlacements();
    const labelGroups = new Map();
    for (const pl of placed) {
      const mesh = new THREE.Mesh(tileGeo, magnetMaterials(pl.m.polarity, pl.m.state || 'active'));
      const { x, y } = tangentFrame(pl.n);
      _m.makeBasis(x, y, pl.n);
      mesh.quaternion.setFromRotationMatrix(_m);
      mesh.position.copy(pl.p).addScaledVector(pl.n, TILE_H / 2 + 0.0015);
      mesh.userData.magnet = pl.m;
      mesh.renderOrder = 2;
      magnetGroup.add(mesh);
      pl.mesh = mesh;
      magnetKeys.add(pl.inst.key);
      if (pl.m.label) {
        const g = labelGroups.get(pl.inst.key) || { inst: pl.inst, labels: [], center: pl.inst.position.clone(), n: pl.n.clone(), halfWidth: (pl.groupSize * (TILE + 0.003)) / 2 };
        if (!g.labels.includes(pl.m.label)) g.labels.push(pl.m.label);
        labelGroups.set(pl.inst.key, g);
      }
    }
    for (const g of labelGroups.values()) {
      const el = document.createElement('div');
      el.className = 'yh-viewer__label';
      el.textContent = g.labels.join(' · ');
      el.hidden = true;
      overlay.appendChild(el);
      labelEls.push({ el, pos: g.center.addScaledVector(g.n, 0.01), n: g.n, halfWidth: g.halfWidth, halfWidthPx: 14 });
    }
    lastPlacements = placed;
    updatePointMatrices(performance.now());
    rebuildPairs();
    rebuildA11yList();
  }
  let lastPlacements = [];

  // ---------------------------------------------------------------- pairs
  const pairGroup = new THREE.Group();
  pairGroup.name = 'pairs';
  scene.add(pairGroup);
  let pairs = [];
  function endpointFor(ref) {
    const inst = resolveInstance(byKey, ref.pointId, ref.side);
    if (!inst) return null;
    return { inst, p: inst.position.clone(), n: inst.normal.clone() };
  }
  function rebuildPairs() {
    pairGroup.children.slice().forEach((c) => { pairGroup.remove(c); c.geometry.dispose(); c.material.dispose(); });
    for (const pr of pairs) {
      const A = endpointFor(pr.a), B = endpointFor(pr.b);
      if (!A || !B) continue;
      // when magnets sit on the endpoints, attach the arc to the tile tops
      const tileFor = (end, polarityPref) => {
        const cands = lastPlacements.filter((pl) => pl.inst === end.inst);
        const c = cands.find((pl) => pl.m.polarity === polarityPref) || cands[0];
        return c ? { p: c.p.clone().addScaledVector(c.n, TILE_H + 0.002), n: c.n.clone() } : null;
      };
      let a = tileFor(A, 'negative') || { p: A.p.clone().addScaledVector(A.n, 0.004), n: A.n };
      let b = tileFor(B, 'positive') || { p: B.p.clone().addScaledVector(B.n, 0.004), n: B.n };
      if (a.p.distanceTo(b.p) < 0.01) {
        const { x } = tangentFrame(A.n);
        a = { p: a.p.clone().addScaledVector(x, -0.017), n: a.n };
        b = { p: b.p.clone().addScaledVector(x, 0.017), n: b.n };
      }
      const dist = a.p.distanceTo(b.p);
      const mid = a.p.clone().add(b.p).multiplyScalar(0.5);
      const nsum = a.n.clone().add(b.n);
      let ctrl;
      const through = nsum.length() <= 0.5;
      if (!through) ctrl = mid.clone().addScaledVector(nsum.normalize(), 0.035 + 0.32 * dist);
      else {
        // opposite faces (e.g. front → back): route around the nearer flank
        const sx = Math.abs(mid.x) > 0.02 ? Math.sign(mid.x) : 1;
        ctrl = mid.clone().add(new THREE.Vector3(sx * (0.32 + 0.2 * Math.abs(mid.x)), 0.04, 0));
      }
      const curve = new THREE.QuadraticBezierCurve3(a.p, ctrl, b.p);
      const geo = new THREE.TubeGeometry(curve, 64, 0.0021, 8, false);
      const color = new THREE.Color(pairColors[pr.state] || pairColors.candidate);
      const solid = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, toneMapped: false }));
      solid.userData.pair = pr;
      pairGroup.add(solid);
      if (through) {
        // arcs that wrap around the body stay faintly visible through it
        const ghost = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthTest: false, depthWrite: false, toneMapped: false }));
        ghost.renderOrder = 6;
        ghost.userData.pair = pr;
        pairGroup.add(ghost);
      }
    }
    requestRender();
  }

  // ---------------------------------------------------------------- camera views & animation
  let anim = null;
  function fitDistance(dir, aspect, cam = camera) {
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const lateral = Math.abs(dir.x) > 0.7;
    const top = dir.y > 0.7;
    const needH = top ? 0.75 : 1.9;
    const needW = top ? 1.2 : lateral ? 0.7 : 1.22;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    return Math.max(needH / 2 / Math.tan(vfov / 2), needW / 2 / Math.tan(hfov / 2)) + 0.25;
  }
  function viewPose(view, aspect, cam) {
    const dir = VIEW_DIRS[view] || VIEW_DIRS.anterior;
    const target = view === 'superior' ? new THREE.Vector3(0, 1.45, 0) : BODY_CENTER.clone();
    const pos = target.clone().addScaledVector(dir, fitDistance(dir, aspect, cam));
    if (view !== 'superior') pos.y += 0.05;
    return { pos, target };
  }
  function animateTo(pos, target, ms = 650) {
    if (reduceMotion() || ms <= 0) {
      anim = null;
      camera.position.copy(pos); controls.target.copy(target); controls.update(); requestRender();
      return;
    }
    // interpolate in spherical coordinates around a moving target for a natural orbit
    const fromT = controls.target.clone(), toT = target.clone();
    const fromS = new THREE.Spherical().setFromVector3(camera.position.clone().sub(fromT));
    const toS = new THREE.Spherical().setFromVector3(pos.clone().sub(toT));
    let dTheta = toS.theta - fromS.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    anim = { t0: performance.now(), ms, fromT, toT, fromS, toS, dTheta };
    requestRender();
  }
  function stepAnim(now) {
    if (!anim) return false;
    const k = Math.min(1, (now - anim.t0) / anim.ms);
    const e = easeInOut(k);
    const t = anim.fromT.clone().lerp(anim.toT, e);
    const s = new THREE.Spherical(
      THREE.MathUtils.lerp(anim.fromS.radius, anim.toS.radius, e),
      THREE.MathUtils.lerp(anim.fromS.phi, anim.toS.phi, e),
      anim.fromS.theta + anim.dTheta * e,
    );
    controls.target.copy(t);
    camera.position.copy(t).add(new THREE.Vector3().setFromSpherical(s));
    camera.lookAt(t);
    if (k >= 1) anim = null;
    return true;
  }
  let currentView = 'anterior';
  function setView(view) {
    if (!VIEW_DIRS[view]) view = 'anterior';
    currentView = view;
    const { pos, target } = viewPose(view, camera.aspect);
    animateTo(pos, target);
    live.textContent = T.views[view] || view;
  }

  // ---------------------------------------------------------------- render loop
  let raf = 0;
  let disposed = false;
  function requestRender() { if (!raf && !disposed) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    const animating = stepAnim(now);
    const moving = animating ? false : controls.update();
    clampTarget();
    const pulsing = pulse && highlighted.size > 0 && !reduceMotion();
    if (pulsing || hovered) updatePointMatrices(now);
    renderer.render(scene, camera);
    updateOverlay();
    if (animating || moving || pulsing) requestRender();
  }
  function clampTarget() {
    const t = controls.target;
    if (!TARGET_BOX.containsPoint(t)) {
      const c = t.clone();
      TARGET_BOX.clampPoint(t, t);
      camera.position.add(t.clone().sub(c));
    }
  }
  controls.addEventListener('change', requestRender);

  // ---------------------------------------------------------------- overlay (tooltip / labels)
  const _v = new THREE.Vector3();
  function toScreen(p) {
    _v.copy(p).project(camera);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    return { x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h, z: _v.z };
  }
  function facing(p, n) { return n.dot(camera.position.clone().sub(p)) > 0; }
  function updateOverlay() {
    if (hovered) {
      const s = toScreen(hovered.position);
      tooltip.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y - 14)}px) translate(-50%, -100%)`;
      tooltip.hidden = false;
    } else tooltip.hidden = true;
    const pxPerM = canvas.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const l of labelEls) {
      const vis = facing(l.pos, l.n);
      l.halfWidthPx = (l.halfWidth * pxPerM) / Math.max(0.1, camera.position.distanceTo(l.pos));
      l.el.hidden = !vis;
      if (!vis) continue;
      const s = toScreen(l.pos);
      // place the chip on the outer side of the body (left half → left of the magnets)
      const c = toScreen(controls.target);
      const left = s.x < c.x - 4;
      const off = l.halfWidthPx + 10;
      l.el.style.transform = left
        ? `translate(${Math.round(s.x - off)}px, ${Math.round(s.y)}px) translate(-100%, -50%)`
        : `translate(${Math.round(s.x + off)}px, ${Math.round(s.y)}px) translate(0, -50%)`;
    }
  }
  function setHovered(inst, fromKeyboard = false) {
    if (hovered === inst) return;
    hovered = inst;
    if (inst) {
      tooltip.textContent = `${localName(inst.point, locale)}${inst.side !== 'C' ? ` · ${sideLabel(inst.side, locale)}` : ''}`;
      canvas.setAttribute('aria-describedby', tooltip.id);
    } else canvas.removeAttribute('aria-describedby');
    canvas.classList.toggle('is-pointer', !!inst && !fromKeyboard);
    updatePointMatrices(performance.now());
    opts.onHover?.({ pointId: inst ? inst.id : null, side: inst ? inst.side : null });
    requestRender();
  }

  // ---------------------------------------------------------------- picking
  function occluded(p) {
    const origin = camera.position.clone();
    const dir = p.clone().sub(origin);
    const dist = dir.length();
    dir.normalize();
    const h = model.raycast(origin, dir, dist - 0.006);
    return !!h && h.distance < dist - 0.006;
  }
  function pickPoint(clientX, clientY, radius) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const cands = [];
    for (const inst of instances) {
      if (!inst.visible) continue;
      const s = toScreen(inst.position);
      if (s.z > 1) continue;
      const d2 = (s.x - mx) ** 2 + (s.y - my) ** 2;
      if (d2 > radius * radius) continue;
      if (!inst.internal && !facing(inst.position, inst.normal)) continue;
      cands.push({ inst, d2, depth: camera.position.distanceTo(inst.position) });
    }
    cands.sort((a, b) => a.d2 - b.d2 || a.depth - b.depth);
    for (const c of cands.slice(0, 4)) if (c.inst.internal || !occluded(c.inst.position)) return c.inst;
    return null;
  }
  function pickSkin(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, camera);
    return model.raycast(rc.ray.origin, rc.ray.direction, 30);
  }

  let hoverQueued = null;
  function onPointerMove(ev) {
    if (ev.buttons) return;
    const r = ev.pointerType === 'touch' ? 22 : 12;
    if (!hoverQueued) requestAnimationFrame(() => {
      const q = hoverQueued; hoverQueued = null;
      if (q && !disposed) setHovered(pickPoint(q.x, q.y, q.r));
    });
    hoverQueued = { x: ev.clientX, y: ev.clientY, r };
  }
  let down = null;
  function onPointerDown(ev) { down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; anim = null; }
  function onPointerUp(ev) {
    if (!down) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    const dt = performance.now() - down.t;
    down = null;
    if (moved > 5 || dt > 700) return;
    const inst = pickPoint(ev.clientX, ev.clientY, ev.pointerType === 'touch' ? 22 : 12);
    if (inst) { opts.onPointClick?.({ pointId: inst.id, side: inst.side, clientX: ev.clientX, clientY: ev.clientY }); return; }
    const hit = pickSkin(ev.clientX, ev.clientY);
    if (hit) {
      const r = resolveRegion(hit.point);
      opts.onRegionClick?.({ regionId: r.regionId, side: r.side, clientX: ev.clientX, clientY: ev.clientY });
    }
  }
  function resolveRegion(p) {
    let r = model.regionAt(p);
    const known = new Set((opts.regions || []).map((x) => x.id));
    if (known.size && !known.has(r.regionId)) {
      // fall back to the region of the nearest catalog point
      let best = null, bd = Infinity;
      for (const inst of instances) { const d = inst.position.distanceTo(p); if (d < bd && inst.point.region) { bd = d; best = inst; } }
      if (best) r = { regionId: best.point.region, side: r.side };
    }
    return r;
  }
  function onDblClick(ev) {
    const hit = pickSkin(ev.clientX, ev.clientY);
    if (!hit) return;
    const dir = camera.position.clone().sub(controls.target).normalize();
    animateTo(hit.point.clone().addScaledVector(dir, 0.75), hit.point.clone(), 550);
  }
  function onLeave() { setHovered(null); }

  // ---------------------------------------------------------------- keyboard
  function orbitBy(dTheta, dPhi) {
    const off = camera.position.clone().sub(controls.target);
    const s = new THREE.Spherical().setFromVector3(off);
    s.theta += dTheta;
    s.phi = THREE.MathUtils.clamp(s.phi + dPhi, 0.05, Math.PI - 0.05);
    animateTo(controls.target.clone().add(new THREE.Vector3().setFromSpherical(s)), controls.target.clone(), 220);
  }
  function zoomBy(f) {
    const off = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(off.length() * f, controls.minDistance, controls.maxDistance);
    animateTo(controls.target.clone().add(off.setLength(len)), controls.target.clone(), 200);
  }
  function onKeyDown(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const k = ev.key;
    let handled = true;
    if (k === 'ArrowLeft') orbitBy(-Math.PI / 12, 0);
    else if (k === 'ArrowRight') orbitBy(Math.PI / 12, 0);
    else if (k === 'ArrowUp') orbitBy(0, -Math.PI / 18);
    else if (k === 'ArrowDown') orbitBy(0, Math.PI / 18);
    else if (k === 'f' || k === 'F') setView('anterior');
    else if (k === 'b' || k === 'B') setView('posterior');
    else if (k === '+' || k === '=') zoomBy(0.8);
    else if (k === '-' || k === '_') zoomBy(1.25);
    else if (k === 'Escape') setHovered(null);
    else handled = false;
    if (handled) ev.preventDefault();
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('keydown', onKeyDown);

  // ---------------------------------------------------------------- accessible list
  function rebuildA11yList() {
    list.textContent = '';
    const vis = instances.filter((i) => i.visible !== false && isVisible(i))
      .sort((a, b) => b.position.y - a.position.y || a.position.x - b.position.x);
    const frag = document.createDocumentFragment();
    for (const inst of vis) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yh-viewer__a11y-btn';
      btn.dataset.key = inst.key;
      btn.textContent = `${localName(inst.point, locale)}${inst.side !== 'C' ? ` — ${sideLabel(inst.side, locale)}` : ''}`;
      li.appendChild(btn);
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }
  list.addEventListener('focusin', (ev) => {
    const inst = byKey.get(ev.target?.dataset?.key);
    if (!inst) return;
    if (!inst.internal && !facing(inst.position, inst.normal)) setView(viewForNormal(inst.normal));
    setHovered(inst, true);
  });
  list.addEventListener('focusout', () => setHovered(null));
  list.addEventListener('click', (ev) => {
    const inst = byKey.get(ev.target?.dataset?.key);
    if (!inst) return;
    const rect = canvas.getBoundingClientRect();
    const s = toScreen(inst.position);
    opts.onPointClick?.({ pointId: inst.id, side: inst.side, clientX: rect.left + s.x, clientY: rect.top + s.y });
  });
  function viewForNormal(n) {
    if (n.y > 0.8) return 'superior';
    if (Math.abs(n.x) > Math.abs(n.z) + 0.2) return n.x > 0 ? 'left' : 'right';
    return n.z >= 0 ? 'anterior' : 'posterior';
  }

  // ---------------------------------------------------------------- resize
  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  const onMotionChange = () => { controls.enableDamping = !reduceMotion(); requestRender(); };
  reduceMotionMQ?.addEventListener?.('change', onMotionChange);

  // ---------------------------------------------------------------- init
  resize();
  setPoints(opts.points);
  rebuildA11yList();
  {
    const { pos, target } = viewPose('anterior', camera.aspect);
    camera.position.copy(pos); controls.target.copy(target); controls.update();
  }
  requestRender();

  // ---------------------------------------------------------------- public API
  /** @type {BodyViewer} */
  const api = {
    renderer: 'webgl',
    setView,
    setMagnets(list) { magnets = (list || []).filter((m) => m && m.pointId); rebuildMagnets(); },
    setPairs(list) { pairs = (list || []).filter((p) => p && p.a && p.b); rebuildPairs(); },
    highlight(pointIds, o = {}) {
      highlighted = new Set(pointIds || []);
      pulse = !!o.pulse;
      updatePointMatrices(performance.now());
      rebuildA11yList();
      requestRender();
    },
    setPointFilter(ids) {
      filter = ids ? new Set(ids) : null;
      updatePointMatrices(performance.now());
      rebuildA11yList();
      requestRender();
    },
    setShowAllPoints(show) {
      showAll = !!show;
      updatePointMatrices(performance.now());
      rebuildA11yList();
      requestRender();
    },
    focusPoint(pointId, side) {
      const inst = resolveInstance(byKey, pointId, side);
      if (!inst) return;
      const n = inst.internal ? camera.position.clone().sub(inst.position).normalize() : inst.normal.clone();
      const dir = n.clone().add(new THREE.Vector3(0, 0.15, 0)).normalize();
      animateTo(inst.position.clone().addScaledVector(dir, 0.7), inst.position.clone(), 650);
      setHovered(inst, true);
    },
    async snapshot(o = {}) {
      const width = Math.round(o.width || 800), height = Math.round(o.height || 1100);
      const view = o.view || 'anterior';
      const prev = { pos: camera.position.clone(), target: controls.target.clone(), aspect: camera.aspect, size: renderer.getSize(new THREE.Vector2()), pr: renderer.getPixelRatio(), hovered };
      const prevAnim = anim; anim = null;
      hovered = null;
      const prevShowAll = showAll;
      if (!o.includePoints) showAll = false;
      updatePointMatrices(performance.now());
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const { pos, target } = viewPose(view, camera.aspect);
      camera.position.copy(pos); camera.lookAt(target); camera.updateMatrixWorld(true);
      const prevBg = scene.background;
      if (!o.transparent) scene.background = new THREE.Color('#ffffff');
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
      const url = canvas.toDataURL('image/png');
      // restore
      scene.background = prevBg;
      showAll = prevShowAll;
      hovered = prev.hovered;
      renderer.setPixelRatio(prev.pr);
      renderer.setSize(prev.size.x, prev.size.y, false);
      camera.aspect = prev.aspect; camera.updateProjectionMatrix();
      camera.position.copy(prev.pos); controls.target.copy(prev.target); camera.lookAt(prev.target);
      anim = prevAnim;
      updatePointMatrices(performance.now());
      renderer.render(scene, camera);
      return url;
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      reduceMotionMQ?.removeEventListener?.('change', onMotionChange);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('keydown', onKeyDown);
      controls.dispose();
      pairGroup.children.forEach((c) => { c.geometry.dispose(); c.material.dispose(); });
      for (const mats of magnetMats.values()) { mats[4].map?.dispose(); mats[4].dispose(); mats[0].dispose(); }
      tileGeo.dispose();
      rims?.dispose(); cores?.dispose();
      rimGeo.dispose(); coreGeo.dispose(); rimMat.dispose(); coreMat.dispose(); ringTex.dispose();
      internalGroup.children.forEach((s) => s.material.dispose());
      if (!opts.model) model.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove(); overlay.remove(); list.remove(); live.remove(); loading.remove();
      container.classList.remove('yh-viewer');
    },
    /** @internal exposed for tests / tooling */
    _debug: { scene, camera, controls, model, instances: () => instances },
  };
  return api;
}

// ------------------------------------------------------------------ textures
function makeRingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffffff';
  g.lineWidth = 7;
  g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(32, 32, 6, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeMagnetTexture(color, glyph, done) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, S, S);
  // subtle top-light gradient for a machined look
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 4;
  g.strokeRect(6, 6, S - 12, S - 12);
  // glyph: drawn as bars (font-independent, crisp)
  g.fillStyle = '#ffffff';
  const bw = S * 0.5, bh = S * 0.12;
  g.fillRect((S - bw) / 2, (S - bh) / 2, bw, bh);
  if (glyph === '+') g.fillRect((S - bh) / 2, (S - bw) / 2, bh, bw);
  if (done) {
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
