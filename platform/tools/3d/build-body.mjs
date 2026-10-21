#!/usr/bin/env node
// Build-time converter: MakeHuman CC0 base mesh + macro targets → compact body
// assets for the 3D viewer (web/assets/models/). Zero dependencies (Node ≥ 22).
//
//   node tools/3d/build-body.mjs [--cache DIR] [--record]
//
// 1. Downloads the pinned upstream files (raw.githubusercontent.com, commit
//    UPSTREAM_COMMIT) into a scratch cache OUTSIDE the repo and verifies the
//    SHA-256 recorded below (--record prints fresh hashes instead of failing).
// 2. Parses base.obj, keeps only the `body` skin group (+ the two eyeball
//    helpers as a separate `eyes` group); drops joints, proxy helpers
//    (tights/skirt/hair/genital), teeth, tongue and eyelashes.
// 3. Applies MakeHuman macro targets for three presets (adult "young",
//    average muscle/weight, race mix 1/3 each): neutral (gender 0.5),
//    female (gender 0), male (gender 1).
// 4. One Catmull-Clark subdivision step (quads), triangulation.
// 5. Normalises to the CONTRACT §4.3 frame: metres, feet at y = 0,
//    vertex height 1.75 m, faces +z, +x = patient's LEFT (MakeHuman's
//    "l-" side is already +x and the mesh faces +z).
// 6. Writes: body.json (header: groups, presets, bbox, skeleton landmarks),
//    body-index.bin (Uint16/Uint32 triangle indices, shared by all presets),
//    body-<preset>.bin (Int16 quantised positions; normals are rebuilt at load).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_REPO = 'makehumancommunity/makehuman';
export const UPSTREAM_COMMIT = 'a8bc2d54ff0ac92e78ff71431b1023eda42bf482';
const RAW = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/`;

/** Upstream files and their SHA-256 (recorded with --record at the pinned commit). */
export const FILES = {
  'LICENSE.md': 'edd99571ca62698f78c943fd4fffb159a413c315fa0d4819d3cec5cadaf8b4f1',
  'LICENSE.ASSETS.md': 'f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c',
  'makehuman/data/3dobjs/base.obj': '8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c',
  'makehuman/data/targets/macrodetails/african-female-young.target': '92d61eeb3c164b421fd5a7c3537ee45e7e1a51de4d49bf312e19c3df2be1d8fc',
  'makehuman/data/targets/macrodetails/african-male-young.target': '894abc1fbb3d28543a51fef16f89d5d4bdf9aa2e1534413339811a3d47818b7d',
  'makehuman/data/targets/macrodetails/asian-female-young.target': '095fe79694fa19e1fe98d93009ec116199bd524e081c640351a10eccf2cca1eb',
  'makehuman/data/targets/macrodetails/asian-male-young.target': 'ed2e8c191cb6b87b4a2d97c80486acb2604fa549316c7aa2a738a5d5a14334dc',
  'makehuman/data/targets/macrodetails/caucasian-female-young.target': '118379f6e8ba9266247fdb8788a20e1df40a239f97ced0b9905bcbcc74f6e820',
  'makehuman/data/targets/macrodetails/caucasian-male-young.target': '70e228ba7164737dae664454394536fc5935fa48d333c1a97d77e2dc6eacc5f5',
  'makehuman/data/targets/macrodetails/proportions/female-young-averagemuscle-averageweight-idealproportions.target': '0a3bd099b7a88150d56d68b69c07d3d3538cb57279e0e775d13f19d3dc3e339d',
  'makehuman/data/targets/macrodetails/proportions/male-young-averagemuscle-averageweight-idealproportions.target': '7bbd790604c908417ff8ca11e566e3577508d92a4f397a2ace0f89f4cc3aa373',
};

const T = 'makehuman/data/targets/macrodetails/';
const race = (g, w) => Object.fromEntries(['african', 'asian', 'caucasian'].map((r) => [`${T}${r}-${g}-young.target`, w / 3]));
/** Preset → { target path: weight }. Proportions at 0.5 of "ideal" (MakeHuman slider 0.75). */
export const PRESETS = {
  neutral: { ...race('female', 0.5), ...race('male', 0.5), [`${T}proportions/female-young-averagemuscle-averageweight-idealproportions.target`]: 0.25, [`${T}proportions/male-young-averagemuscle-averageweight-idealproportions.target`]: 0.25 },
  female: { ...race('female', 1), [`${T}proportions/female-young-averagemuscle-averageweight-idealproportions.target`]: 0.5 },
  male: { ...race('male', 1), [`${T}proportions/male-young-averagemuscle-averageweight-idealproportions.target`]: 0.5 },
};
export const TARGET_HEIGHT = 1.75;
const KEEP_GROUPS = { body: 'skin', 'helper-l-eye': 'eyes', 'helper-r-eye': 'eyes' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'web', 'assets', 'models');
const args = process.argv.slice(2);
const cacheDir = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : join(tmpdir(), `yh-makehuman-${UPSTREAM_COMMIT.slice(0, 12)}`);
const record = args.includes('--record');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchVerified(path) {
  const local = join(cacheDir, path);
  let buf = null;
  try { await stat(local); buf = await readFile(local); } catch { /* not cached */ }
  if (!buf) {
    const res = await fetch(RAW + path);
    if (!res.ok) throw new Error(`download ${path}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, buf);
  }
  const h = sha256(buf);
  if (record) console.log(`  '${path}': '${h}',`);
  else if (FILES[path] !== h) throw new Error(`SHA-256 mismatch for ${path}: ${h} (expected ${FILES[path]})`);
  return buf;
}

function parseObj(text) {
  const v = [];
  const faces = []; // {g, idx:[...]}
  const joints = new Map(); // name -> Set(vertex)
  let g = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) { const p = line.split(/\s+/); v.push(+p[1], +p[2], +p[3]); }
    else if (line.startsWith('g ')) g = line.slice(2).trim();
    else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map((s) => parseInt(s, 10) - 1);
      if (g.startsWith('joint-')) { if (!joints.has(g)) joints.set(g, new Set()); idx.forEach((i) => joints.get(g).add(i)); }
      else if (KEEP_GROUPS[g]) faces.push({ g: KEEP_GROUPS[g], idx });
    }
  }
  return { v: Float64Array.from(v), faces, joints };
}

function parseTarget(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length === 4) out.push(+p[0], +p[1], +p[2], +p[3]);
  }
  return out;
}

/** One Catmull-Clark step on a quad mesh (with boundary rules). Returns quads. */
export function catmullClark(pos, quads) {
  const nv = pos.length / 3;
  const nf = quads.length / 4;
  const edgeKey = (a, b) => (a < b ? a * 1048576 + b : b * 1048576 + a);
  const edges = new Map(); // key -> {a,b,faces:[]}
  for (let f = 0; f < nf; f++) for (let k = 0; k < 4; k++) {
    const a = quads[f * 4 + k], b = quads[f * 4 + ((k + 1) & 3)];
    const key = edgeKey(a, b);
    let e = edges.get(key);
    if (!e) { e = { a, b, faces: [], id: 0 }; edges.set(key, e); }
    e.faces.push(f);
  }
  const fp = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) fp[f * 3 + c] += pos[quads[f * 4 + k] * 3 + c] / 4;
  const ne = edges.size;
  const out = new Float64Array((nv + nf + ne) * 3);
  // edge points
  let ei = 0;
  const vFaces = Array.from({ length: nv }, () => []);
  const vEdges = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 4; k++) vFaces[quads[f * 4 + k]].push(f);
  for (const e of edges.values()) {
    e.id = nv + nf + ei++;
    const o = e.id * 3;
    for (let c = 0; c < 3; c++) {
      const mid = (pos[e.a * 3 + c] + pos[e.b * 3 + c]) / 2;
      out[o + c] = e.faces.length === 2 ? (pos[e.a * 3 + c] + pos[e.b * 3 + c] + fp[e.faces[0] * 3 + c] + fp[e.faces[1] * 3 + c]) / 4 : mid;
    }
    vEdges[e.a].push(e); vEdges[e.b].push(e);
  }
  // vertex points
  for (let i = 0; i < nv; i++) {
    const es = vEdges[i];
    const boundary = es.filter((e) => e.faces.length !== 2);
    for (let c = 0; c < 3; c++) {
      const P = pos[i * 3 + c];
      if (boundary.length >= 2) {
        const s = boundary.slice(0, 2).reduce((t, e) => t + pos[(e.a === i ? e.b : e.a) * 3 + c], 0);
        out[i * 3 + c] = 0.75 * P + 0.125 * s;
      } else if (es.length && vFaces[i].length) {
        const n = vFaces[i].length;
        const F = vFaces[i].reduce((t, f) => t + fp[f * 3 + c], 0) / n;
        const R = es.reduce((t, e) => t + (pos[e.a * 3 + c] + pos[e.b * 3 + c]) / 2, 0) / es.length;
        out[i * 3 + c] = (F + 2 * R + (n - 3) * P) / n;
      } else out[i * 3 + c] = P;
    }
  }
  for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) out[(nv + f) * 3 + c] = fp[f * 3 + c];
  const nq = new Uint32Array(nf * 16);
  for (let f = 0; f < nf; f++) {
    const q = [quads[f * 4], quads[f * 4 + 1], quads[f * 4 + 2], quads[f * 4 + 3]];
    for (let k = 0; k < 4; k++) {
      const v0 = q[k], vn = q[(k + 1) & 3], vp = q[(k + 3) & 3];
      const eNext = edges.get(edgeKey(v0, vn)).id, ePrev = edges.get(edgeKey(vp, v0)).id;
      nq.set([v0, eNext, nv + f, ePrev], (f * 4 + k) * 4);
    }
  }
  return { pos: out, quads: nq };
}

function centroid(v, set, map) {
  const c = [0, 0, 0];
  for (const i of set) for (let k = 0; k < 3; k++) c[k] += map(v, i, k);
  return c.map((x) => x / set.size);
}

async function main() {
  console.log(`MakeHuman ${UPSTREAM_REPO}@${UPSTREAM_COMMIT.slice(0, 12)} → ${outDir}`);
  const bufs = {};
  for (const p of Object.keys(FILES)) bufs[p] = await fetchVerified(p);
  if (record) { console.log('(hashes printed; paste them into FILES)'); return; }
  const obj = parseObj(bufs['makehuman/data/3dobjs/base.obj'].toString('utf8'));
  const targets = {};
  for (const p of Object.keys(FILES)) if (p.endsWith('.target')) targets[p] = parseTarget(bufs[p].toString('utf8'));

  // compact vertex set used by kept faces (skin first, then eyes)
  const order = ['skin', 'eyes'];
  const remap = new Map();
  const quadsByGroup = {};
  for (const g of order) {
    const q = [];
    for (const f of obj.faces) if (f.g === g) { for (const i of f.idx) { if (!remap.has(i)) remap.set(i, remap.size); q.push(remap.get(i)); } }
    quadsByGroup[g] = q;
  }
  const srcIdx = [...remap.keys()];
  const header = {
    format: 'yh-body-v1',
    source: { repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT, license: 'CC0-1.0', files: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, v])) },
    frame: 'CONTRACT §4.3: metres, feet y=0, vertex 1.75 m, faces +z, +x = patient LEFT',
    subdivision: 'catmull-clark x1',
    presets: {},
  };

  let topo = null;
  for (const [preset, weights] of Object.entries(PRESETS)) {
    const v = Float64Array.from(obj.v);
    for (const [path, w] of Object.entries(weights)) {
      const t = targets[path];
      for (let i = 0; i < t.length; i += 4) { const k = t[i] * 3; v[k] += w * t[i + 1]; v[k + 1] += w * t[i + 2]; v[k + 2] += w * t[i + 3]; }
    }
    // joints (skeleton landmarks) from the deformed helper geometry
    const J = (name) => centroid(v, obj.joints.get(name), (vv, i, k) => vv[i * 3 + k]);
    // compact + subdivide each group separately (eyes stay separate)
    const positions = [];
    const tris = { skin: [], eyes: [] };
    let base = 0;
    for (const g of order) {
      const used = [...new Set(quadsByGroup[g])].sort((a, b) => a - b);
      const local = new Map(used.map((u, i) => [u, i]));
      const p = new Float64Array(used.length * 3);
      used.forEach((u, i) => { const s = srcIdx[u]; p[i * 3] = v[s * 3]; p[i * 3 + 1] = v[s * 3 + 1]; p[i * 3 + 2] = v[s * 3 + 2]; });
      const q = Uint32Array.from(quadsByGroup[g].map((u) => local.get(u)));
      const sub = catmullClark(p, q);
      for (let i = 0; i < sub.pos.length; i++) positions.push(sub.pos[i]);
      for (let f = 0; f < sub.quads.length; f += 4) {
        const [a, b, c, d] = [sub.quads[f], sub.quads[f + 1], sub.quads[f + 2], sub.quads[f + 3]].map((x) => x + base);
        tris[g].push(a, b, c, a, c, d);
      }
      base += sub.pos.length / 3;
    }
    const P = Float64Array.from(positions);
    // normalise: feet y = 0, height 1.75 m; centre x/z on the body midline / ground joint
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < P.length; i += 3) { minY = Math.min(minY, P[i]); maxY = Math.max(maxY, P[i]); }
    const s = TARGET_HEIGHT / (maxY - minY);
    const ground = J('joint-ground');
    const tf = (x, y, z) => [(x - ground[0]) * s, (y - minY) * s, (z - ground[2]) * s];
    for (let i = 0; i < P.length; i += 3) { const r = tf(P[i], P[i + 1], P[i + 2]); P[i] = r[0]; P[i + 1] = r[1]; P[i + 2] = r[2]; }
    const L = (name) => tf(...J(name)).map((x) => +x.toFixed(4));
    const skeleton = {
      head: L('joint-head'), neck: L('joint-neck'), spine1: L('joint-spine-1'), spine2: L('joint-spine-2'), spine3: L('joint-spine-3'), spine4: L('joint-spine-4'), pelvis: L('joint-pelvis'),
      clavicle: L('joint-l-clavicle'), scapula: L('joint-l-scapula'), shoulderJ: L('joint-l-shoulder'), elbow: L('joint-l-elbow'), wrist: L('joint-l-hand'),
      knuckle: L('joint-l-finger-3-2'), fingertip: L('joint-l-finger-3-4'), thumbTip: L('joint-l-finger-1-4'),
      hipJ: L('joint-l-upper-leg'), knee: L('joint-l-knee'), ankle: L('joint-l-ankle'), toe: L('joint-l-toe-1-3'),
      eye: L('joint-l-eye'), jaw: L('joint-jaw'), mouth: L('joint-mouth'),
    };
    // bbox + quantisation
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
    const q = new Int16Array(P.length);
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) q[i + k] = Math.round(((P[i + k] - mn[k]) / (mx[k] - mn[k])) * 65535 - 32768);
    const file = `body-${preset}.bin`;
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, file), Buffer.from(q.buffer));
    header.presets[preset] = { file, sha256: sha256(Buffer.from(q.buffer)), bboxMin: mn.map((x) => +x.toFixed(5)), bboxMax: mx.map((x) => +x.toFixed(5)), skeleton, targets: weights };
    const allTris = tris.skin.concat(tris.eyes);
    if (!topo) {
      topo = { vertexCount: P.length / 3, groups: { skin: { start: 0, count: tris.skin.length }, eyes: { start: tris.skin.length, count: tris.eyes.length } }, tris: allTris };
    } else if (topo.tris.length !== allTris.length) throw new Error('topology differs between presets');
    console.log(`  ${preset}: ${P.length / 3} vertices, height ${(mx[1] - mn[1]).toFixed(3)} m, quantisation step ${(Math.max(...mx.map((x, k) => x - mn[k])) / 65535 * 1000).toFixed(3)} mm`);
  }
  const idx = topo.vertexCount < 65536 ? Uint16Array.from(topo.tris) : Uint32Array.from(topo.tris);
  await writeFile(join(outDir, 'body-index.bin'), Buffer.from(idx.buffer));
  header.vertexCount = topo.vertexCount;
  header.index = { file: 'body-index.bin', type: idx instanceof Uint16Array ? 'uint16' : 'uint32', count: idx.length, sha256: sha256(Buffer.from(idx.buffer)) };
  header.groups = topo.groups;
  header.position = { type: 'int16-normalised', note: 'p = min + (q + 32768) / 65535 * (max - min)' };
  await writeFile(join(outDir, 'body.json'), JSON.stringify(header, null, 1) + '\n');
  await writeFile(join(outDir, 'LICENSE.ASSETS.md'), bufs['LICENSE.ASSETS.md']);
  console.log(`  index: ${idx.length / 3} triangles (${header.index.type})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
