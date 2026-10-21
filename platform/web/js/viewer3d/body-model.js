/**
 * YOU HEAL Clinical — 3D body model (ADR-005, revision 2026-10-21).
 *
 * Primary body: the MakeHuman CC0 base mesh with macro targets (neutral /
 * female / male presets), converted at build time by tools/3d/build-body.mjs
 * into web/assets/models/ (see PROVENANCE.md). It is fetched and decoded in a
 * module Worker (CSP-safe, cached per preset); a uniform-grid mesh query
 * (./mesh-query.js) provides point snapping, picking and occlusion tests.
 *
 * Fallback: if the asset cannot be loaded, the procedural signed-distance-field
 * mannequin (./body-sdf.js) is meshed instead, with SDF-based queries.
 *
 * Any other licensed mesh already normalised to the CONTRACT §4.3 frame can be
 * wrapped with `createMeshBodyModel(mesh)` and passed as
 * `createBodyViewer(el, { model })`; catalog points are re-snapped along their
 * `view` automatically.
 *
 * @module viewer3d/body-model
 */
import * as THREE from '../../vendor/three/three.module.js';
import { buildBody, polygonize, snapPoint, sphereTrace, sdfNormal, viewDirection } from './body-sdf.js';
import { buildMeshQuery } from './mesh-query.js';
import { loadBodyAsset } from './body-asset.js';
import { regionAt, DEFAULT_SKELETON } from './regions.js';

/** Skin tone presets (sRGB hex). `clinical` is a neutral gray-blue. */
export const SKIN_TONES = {
  light: '#efcfb6',
  medium: '#d6a98c',
  tan: '#b98262',
  deep: '#7e523a',
  clinical: '#c3cad3',
};

const cache = new Map();

function runWorker(msg) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./body-worker.js', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timeout')); }, 30000);
    worker.onmessage = (ev) => {
      clearTimeout(timer); worker.terminate();
      if (ev.data && ev.data.error) reject(new Error(ev.data.error)); else resolve(ev.data);
    };
    worker.onerror = (ev) => { clearTimeout(timer); worker.terminate(); ev.preventDefault?.(); reject(new Error('worker error')); };
    worker.postMessage(msg);
  });
}

/** Mesh arrays for a preset: MakeHuman asset (worker → main thread) or SDF fallback. Cached. */
function getBodyArrays(sex, opts) {
  const key = `${sex}:${opts.source || 'auto'}:${opts.modelsUrl || ''}`;
  if (!cache.has(key)) {
    const canWorker = opts.useWorker !== false && typeof Worker !== 'undefined';
    const asset = () => (canWorker ? runWorker({ kind: 'asset', sex, baseUrl: opts.modelsUrl ? String(new URL(opts.modelsUrl, location.href)) : null }) : Promise.reject(new Error('no worker')))
      .catch((e) => (e && /HTTP|format|mismatch/.test(e.message) ? Promise.reject(e) : loadBodyAsset({ sex, baseUrl: opts.modelsUrl })))
      .then((a) => ({ ...a, kind: 'makehuman' }));
    const sdf = () => (canWorker ? runWorker({ kind: 'sdf', sex, h: 0.005 }) : Promise.reject(new Error('no worker')))
      .catch(() => { const b = buildBody({ sex }); return polygonize(b.sdf, { bounds: b.bounds, h: 0.005 }); })
      .then((m) => ({ ...m, kind: 'procedural' }));
    const p = opts.source === 'procedural' ? sdf() : asset().catch((e) => {
      console.warn(`[viewer3d] MakeHuman body asset unavailable (${e.message}); using the procedural mannequin`);
      return sdf();
    });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(20,24,32,0.55)');
  grd.addColorStop(0.45, 'rgba(20,24,32,0.22)');
  grd.addColorStop(1, 'rgba(20,24,32,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeGround(feetX) {
  const group = new THREE.Group();
  group.name = 'ground-shadow';
  const tex = shadowTexture();
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.55 });
  const disk = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8), mat);
  disk.rotation.x = -Math.PI / 2;
  disk.position.set(0, 0.0005, 0.05);
  disk.renderOrder = -1;
  group.add(disk);
  const footMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.8 });
  for (const sx of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.36), footMat);
    f.rotation.x = -Math.PI / 2;
    f.position.set(sx * feetX, 0.001, 0.07);
    f.renderOrder = -1;
    group.add(f);
  }
  return group;
}

function skinMaterial(tone) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(SKIN_TONES[tone] || tone || SKIN_TONES.medium),
    roughness: 0.6,
    metalness: 0.0,
    sheen: 0.4,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color('#ffd9c4'),
    specularIntensity: 0.35,
  });
}

/** Per-vertex eye colours (sclera / iris / pupil) from the gaze direction (+z). */
function eyeColors(P, I, group, count) {
  const col = new Float32Array(count * 3).fill(1);
  const verts = new Set();
  for (let t = group.start; t < group.start + group.count; t++) verts.add(I[t]);
  const sides = [[], []];
  for (const v of verts) sides[P[v * 3] > 0 ? 1 : 0].push(v);
  const sclera = new THREE.Color('#ece6de'), iris = new THREE.Color('#4a3a2e'), pupil = new THREE.Color('#141110');
  for (const vs of sides) {
    if (!vs.length) continue;
    const c = [0, 1, 2].map((k) => vs.reduce((s, v) => s + P[v * 3 + k], 0) / vs.length);
    for (const v of vs) {
      const d = [P[v * 3] - c[0], P[v * 3 + 1] - c[1], P[v * 3 + 2] - c[2]];
      const cos = d[2] / (Math.hypot(...d) || 1);
      const k = cos > 0.95 ? pupil : cos > 0.82 ? iris : sclera;
      col[v * 3] = k.r; col[v * 3 + 1] = k.g; col[v * 3 + 2] = k.b;
    }
  }
  return col;
}

/**
 * Body model interface consumed by the viewer.
 * @typedef {object} BodyModel
 * @property {'makehuman'|'procedural'|'mesh'} kind
 * @property {THREE.Group} object3d       scene graph root (mesh + ground shadow)
 * @property {THREE.Mesh} mesh            the skin mesh
 * @property {(color:string)=>void} setTone  skin colour (hex or SKIN_TONES key)
 * @property {(pos:{x:number,y:number,z:number}, view:string)=>{position:THREE.Vector3, normal:THREE.Vector3, internal:boolean}} snap
 * @property {(origin:THREE.Vector3, dir:THREE.Vector3, maxDist?:number)=>({point:THREE.Vector3, normal:THREE.Vector3, distance:number}|null)} raycast
 * @property {(p:THREE.Vector3)=>{regionId:string, side:'R'|'L'|'C'}} regionAt
 * @property {object} skeleton  landmarks of the patient-LEFT side (CONTRACT frame)
 * @property {number[]} bounds  [x0,y0,z0,x1,y1,z1]
 * @property {()=>void} dispose
 */

/**
 * Build the body model (MakeHuman asset, falling back to the procedural mannequin).
 * @param {{sex?:'neutral'|'male'|'female', tone?:string, useWorker?:boolean, source?:'auto'|'procedural', modelsUrl?:string}} [opts]
 * @returns {Promise<BodyModel>}
 */
export async function createBodyModel(opts = {}) {
  const sex = ['male', 'female', 'neutral'].includes(opts.sex) ? opts.sex : 'neutral';
  const arrays = await getBodyArrays(sex, opts);
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  const material = skinMaterial(opts.tone);
  let materials = material;
  let eyeMat = null;
  if (arrays.kind === 'makehuman' && arrays.groups?.eyes?.count) {
    geom.addGroup(arrays.groups.skin.start, arrays.groups.skin.count, 0);
    geom.addGroup(arrays.groups.eyes.start, arrays.groups.eyes.count, 1);
    geom.setAttribute('color', new THREE.BufferAttribute(eyeColors(arrays.positions, arrays.indices, arrays.groups.eyes, arrays.positions.length / 3), 3));
    eyeMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 });
    materials = [material, eyeMat];
  }
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  const mesh = new THREE.Mesh(geom, materials);
  mesh.name = 'body';
  const object3d = new THREE.Group();
  object3d.name = 'body-model';
  object3d.add(mesh);

  let snapFn, raycastFn, skeleton, bounds;
  if (arrays.kind === 'makehuman') {
    const q = buildMeshQuery(arrays.positions, arrays.indices, arrays.normals, { triCount: arrays.groups.skin.count });
    skeleton = arrays.skeleton;
    bounds = arrays.bounds;
    snapFn = (p, view) => q.snap(p, view);
    raycastFn = (o, d, maxT) => { const h = q.raycast(o, d, maxT); return h ? { pos: h.point, normal: h.normal, t: h.t } : null; };
  } else {
    const body = buildBody({ sex });
    skeleton = body.skeleton;
    bounds = body.bounds;
    snapFn = (p, view) => snapPoint(body.sdf, p, view);
    raycastFn = (o, d, maxT) => {
      const t = sphereTrace(body.sdf, o, d, maxT);
      if (t < 0) return null;
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      return { pos: p, normal: sdfNormal(body.sdf, p[0], p[1], p[2]), t };
    };
  }
  const ground = makeGround(Math.abs(skeleton.ankle?.[0] || 0.13));
  object3d.add(ground);

  return {
    kind: arrays.kind,
    sex,
    object3d,
    mesh,
    material,
    bounds,
    skeleton,
    setTone(color) { material.color.set(SKIN_TONES[color] || color); },
    snap(pos, view) {
      const r = snapFn([pos.x, pos.y, pos.z], view);
      return { position: v3(r.pos), normal: v3(r.normal), internal: r.internal };
    },
    raycast(origin, dir, maxDist = 20) {
      const r = raycastFn([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], maxDist);
      return r ? { point: v3(r.pos), normal: v3(r.normal), distance: r.t } : null;
    },
    regionAt(p) { return regionAt([p.x, p.y, p.z], skeleton); },
    dispose() {
      geom.dispose();
      material.dispose();
      eyeMat?.dispose();
      ground.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
    },
  };
}

/**
 * Wrap an arbitrary (e.g. licensed GLB) mesh, already normalised to the
 * CONTRACT frame, in the BodyModel interface (THREE.Raycaster queries).
 * @param {THREE.Mesh} mesh
 * @returns {BodyModel}
 */
export function createMeshBodyModel(mesh) {
  const object3d = new THREE.Group();
  object3d.add(mesh);
  object3d.add(makeGround(0.13));
  const rc = new THREE.Raycaster();
  const box = new THREE.Box3().setFromObject(mesh);
  const hitAlong = (origin, dir, far) => {
    rc.set(origin, dir); rc.far = far; rc.near = 0;
    const hits = rc.intersectObject(mesh, false);
    return hits[0] || null;
  };
  return {
    kind: 'mesh',
    object3d,
    mesh,
    material: mesh.material,
    skeleton: DEFAULT_SKELETON,
    bounds: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z],
    setTone(color) { if (mesh.material?.color) mesh.material.color.set(SKIN_TONES[color] || color); },
    snap(pos, view) {
      const p = new THREE.Vector3(pos.x, pos.y, pos.z);
      if (view === 'internal') return { position: p, normal: new THREE.Vector3(0, 0, 1), internal: true };
      const d = viewDirection(view, pos.x) || [0, 0, 1];
      const out = new THREE.Vector3(d[0], d[1], d[2]);
      const start = p.clone().addScaledVector(out, 0.16);
      const h = hitAlong(start, out.clone().negate(), 0.32);
      if (!h) return { position: p, normal: out, internal: false };
      const n = h.face ? h.face.normal.clone().transformDirection(mesh.matrixWorld) : out;
      return { position: h.point, normal: n, internal: false };
    },
    raycast(origin, dir, maxDist = 20) {
      const h = hitAlong(origin, dir, maxDist);
      if (!h) return null;
      return { point: h.point, normal: h.face.normal.clone().transformDirection(mesh.matrixWorld), distance: h.distance };
    },
    regionAt(p) { return regionAt([p.x, p.y, p.z]); },
    dispose() {
      object3d.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); } });
    },
  };
}
