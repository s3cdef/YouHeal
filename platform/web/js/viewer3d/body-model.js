/**
 * YOU HEAL Clinical — procedural anatomical mannequin (ADR-005).
 *
 * The body is a signed distance field (./body-sdf.js) polygonised with
 * surface nets into ONE smooth indexed mesh (≈90k vertices at 5 mm), built in
 * a module Worker when available. The same SDF is kept on the main thread for
 * exact point snapping, picking and occlusion tests.
 *
 * Swapping in a licensed mesh later (ADR-005, `web/assets/models/body.glb`):
 *   1. Load the GLB with GLTFLoader (vendor `examples/jsm/loaders/GLTFLoader.js`
 *      next to three.module.js, imports rewritten to './three.module.js').
 *   2. Normalise it to the CONTRACT §4.3 frame (metres, feet y=0, faces +z,
 *      +x = patient's LEFT) and merge it into a single Mesh.
 *   3. `createMeshBodyModel(mesh)` wraps it in the same interface as
 *      `createBodyModel()` (snap / raycast / regionAt via THREE.Raycaster), and
 *      pass it to `createBodyViewer(el, { model })`. Points are re-snapped by
 *      raycast along their catalog `view` automatically.
 *
 * @module viewer3d/body-model
 */
import * as THREE from '../../vendor/three/three.module.js';
import { buildBody, polygonize, snapPoint, sphereTrace, sdfNormal, viewDirection } from './body-sdf.js';
import { regionAt } from './regions.js';

/** Skin tone presets (sRGB hex). `clinical` is a neutral gray-blue. */
export const SKIN_TONES = {
  light: '#efcfb6',
  medium: '#cfa38a',
  tan: '#c08a64',
  deep: '#8a5a3c',
  clinical: '#c3cad3',
};

const meshCache = new Map();

function buildInWorker(sex, h) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./body-worker.js', import.meta.url), { type: 'module' });
    } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timeout')); }, 30000);
    worker.onmessage = (ev) => {
      clearTimeout(timer); worker.terminate();
      if (ev.data && ev.data.error) reject(new Error(ev.data.error)); else resolve(ev.data);
    };
    worker.onerror = (ev) => { clearTimeout(timer); worker.terminate(); ev.preventDefault?.(); reject(new Error('worker error')); };
    worker.postMessage({ sex, h });
  });
}

/** Get (cached) mesh arrays for a sex preset. */
function getMeshArrays(sex, h, useWorker) {
  const key = `${sex}:${h}`;
  if (!meshCache.has(key)) {
    const p = (useWorker && typeof Worker !== 'undefined' ? buildInWorker(sex, h) : Promise.reject(new Error('no worker')))
      .catch(() => {
        const body = buildBody({ sex });
        return polygonize(body.sdf, { bounds: body.bounds, h });
      });
    meshCache.set(key, p);
    p.catch(() => meshCache.delete(key));
  }
  return meshCache.get(key);
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
  const disk = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.75), mat);
  disk.rotation.x = -Math.PI / 2;
  disk.position.set(0, 0.0005, 0.03);
  disk.renderOrder = -1;
  group.add(disk);
  const footMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.8 });
  for (const sx of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.36), footMat);
    f.rotation.x = -Math.PI / 2;
    f.position.set(sx * feetX, 0.001, 0.05);
    f.renderOrder = -1;
    group.add(f);
  }
  return group;
}

/**
 * Body model interface consumed by the viewer.
 * @typedef {object} BodyModel
 * @property {THREE.Group} object3d       scene graph root (mesh + ground shadow)
 * @property {THREE.Mesh} mesh            the skin mesh (raycast target)
 * @property {(color:string)=>void} setTone  skin colour (hex or SKIN_TONES key)
 * @property {(pos:{x:number,y:number,z:number}, view:string)=>{position:THREE.Vector3, normal:THREE.Vector3, internal:boolean}} snap
 * @property {(origin:THREE.Vector3, dir:THREE.Vector3, maxDist?:number)=>({point:THREE.Vector3, normal:THREE.Vector3, distance:number}|null)} raycast
 * @property {(p:THREE.Vector3)=>{regionId:string, side:'R'|'L'|'C'}} regionAt
 * @property {number[]} bounds  [x0,y0,z0,x1,y1,z1]
 * @property {()=>void} dispose
 */

/**
 * Build the procedural mannequin.
 * @param {{sex?:'neutral'|'male'|'female', tone?:string, resolution?:number, useWorker?:boolean}} [opts]
 * @returns {Promise<BodyModel>}
 */
export async function createBodyModel(opts = {}) {
  const sex = ['male', 'female', 'neutral'].includes(opts.sex) ? opts.sex : 'neutral';
  const h = opts.resolution || 0.005;
  const meshP = getMeshArrays(sex, h, opts.useWorker !== false);
  const body = buildBody({ sex });
  const arrays = await meshP;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();

  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(SKIN_TONES[opts.tone] || opts.tone || SKIN_TONES.medium),
    roughness: 0.58,
    metalness: 0.0,
    sheen: 0.35,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color('#ffe2cf'),
    clearcoat: 0.04,
    clearcoatRoughness: 0.6,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'body';
  const object3d = new THREE.Group();
  object3d.name = 'body-model';
  object3d.add(mesh);
  const ground = makeGround(0.13);
  object3d.add(ground);

  const sdf = body.sdf;
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

  return {
    kind: 'procedural',
    sex,
    object3d,
    mesh,
    material,
    bounds: body.bounds,
    skeleton: body.skeleton,
    sdf,
    setTone(color) { material.color.set(SKIN_TONES[color] || color); },
    snap(pos, view) {
      const r = snapPoint(sdf, [pos.x, pos.y, pos.z], view);
      return { position: v3(r.pos), normal: v3(r.normal), internal: r.internal };
    },
    raycast(origin, dir, maxDist = 20) {
      const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
      // skip empty space quickly: clip the ray to the bounds box
      const t = sphereTrace(sdf, o, d, maxDist);
      if (t < 0) return null;
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      return { point: v3(p), normal: v3(sdfNormal(sdf, p[0], p[1], p[2])), distance: t };
    },
    regionAt(p) { return regionAt([p.x, p.y, p.z], body.skeleton); },
    dispose() {
      geom.dispose();
      material.dispose();
      ground.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
    },
  };
}

/**
 * Wrap an arbitrary (e.g. licensed GLB) mesh, already normalised to the
 * CONTRACT frame, in the BodyModel interface. Snapping/picking use
 * THREE.Raycaster (slower than the SDF but generic).
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
    bounds: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z],
    setTone(color) { if (mesh.material?.color) mesh.material.color.set(SKIN_TONES[color] || color); },
    snap(pos, view) {
      const p = new THREE.Vector3(pos.x, pos.y, pos.z);
      if (view === 'internal') return { position: p, normal: new THREE.Vector3(0, 0, 1), internal: true };
      const d = viewDirection(view, pos.x) || [0, 0, 1];
      const out = new THREE.Vector3(d[0], d[1], d[2]);
      // nearest surface along the view line, approached from the outside
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
