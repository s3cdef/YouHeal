/**
 * Spatial queries on a triangle mesh (uniform grid acceleration): ray casts,
 * all-hits along a segment, closest point, and catalog point snapping.
 * Pure JS (worker / main thread / Node). Used with the MakeHuman body mesh.
 * @module viewer3d/mesh-query
 */
import { viewDirection } from './body-sdf.js';

/**
 * @param {Float32Array} P positions
 * @param {Uint16Array|Uint32Array} I triangle indices
 * @param {Float32Array} [N] vertex normals (for smooth hit normals)
 * @param {{triCount?:number, cell?:number}} [o] triCount limits queries to the first N triangles (skin group)
 */
export function buildMeshQuery(P, I, N, o = {}) {
  const triCount = o.triCount ? o.triCount / 3 : I.length / 3;
  const cell = o.cell || 0.025;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triCount * 3; t++) { const v = I[t] * 3; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[v + k]); mx[k] = Math.max(mx[k], P[v + k]); } }
  for (let k = 0; k < 3; k++) { mn[k] -= 1e-3; mx[k] += 1e-3; }
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((mx[k] - mn[k]) / cell)));
  const [DX, DY, DZ] = dims;
  const cellOf = (x, k) => Math.min(dims[k] - 1, Math.max(0, Math.floor((x - mn[k]) / cell)));
  const counts = new Uint32Array(DX * DY * DZ + 1);
  const triBox = (t, f) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const lo = [0, 1, 2].map((k) => cellOf(Math.min(P[a + k], P[b + k], P[c + k]), k));
    const hi = [0, 1, 2].map((k) => cellOf(Math.max(P[a + k], P[b + k], P[c + k]), k));
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) f((z * DY + y) * DX + x);
  };
  for (let t = 0; t < triCount; t++) triBox(t, (c) => { counts[c + 1]++; });
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const items = new Uint32Array(counts[counts.length - 1]);
  const fill = counts.slice(0, -1);
  for (let t = 0; t < triCount; t++) triBox(t, (c) => { items[fill[c]++] = t; });
  const stamp = new Uint32Array(triCount);
  let stampId = 0;

  // Möller–Trumbore; returns t or -1, writes barycentrics to bary
  const bary = [0, 0];
  function hitTri(t, ox, oy, oz, dx, dy, dz) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) return -1;
    const inv = 1 / det;
    const sx = ox - P[a], sy = oy - P[a + 1], sz = oz - P[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    bary[0] = u; bary[1] = v;
    return tt;
  }
  function faceNormal(t) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }
  function smoothNormal(t, u, v) {
    if (!N) return faceNormal(t);
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3, w = 1 - u - v;
    const n = [0, 1, 2].map((k) => N[a + k] * w + N[b + k] * u + N[c + k] * v);
    const l = Math.hypot(...n) || 1;
    return n.map((x) => x / l);
  }

  /** Walk the grid along the ray; cb(t, tri, u, v) for every hit in [0, maxT]; return true from cb to stop. */
  function traverse(o, d, maxT, cb) {
    // clip to grid box
    let t0 = 0, t1 = maxT;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) { if (o[k] < mn[k] || o[k] > mx[k]) return; continue; }
      let a = (mn[k] - o[k]) / d[k], b = (mx[k] - o[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return;
    }
    stampId++;
    if (stampId === 0xffffffff) { stamp.fill(0); stampId = 1; }
    const p = [o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0];
    const c = [cellOf(p[0], 0), cellOf(p[1], 1), cellOf(p[2], 2)];
    const step = [0, 1, 2].map((k) => (d[k] > 0 ? 1 : d[k] < 0 ? -1 : 0));
    const tMax = [0, 1, 2].map((k) => (step[k] === 0 ? Infinity : (mn[k] + (c[k] + (step[k] > 0 ? 1 : 0)) * cell - o[k]) / d[k]));
    const tDelta = [0, 1, 2].map((k) => (step[k] === 0 ? Infinity : cell / Math.abs(d[k])));
    for (let guard = 0; guard < 4096; guard++) {
      const ci = (c[2] * DY + c[1]) * DX + c[0];
      const cellExit = Math.min(tMax[0], tMax[1], tMax[2]);
      for (let j = counts[ci]; j < counts[ci + 1]; j++) {
        const t = items[j];
        if (stamp[t] === stampId) continue;
        stamp[t] = stampId;
        const th = hitTri(t, o[0], o[1], o[2], d[0], d[1], d[2]);
        if (th >= t0 - 1e-9 && th <= t1) { if (cb(th, t, bary[0], bary[1], cellExit)) return; }
      }
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (tMax[k] > t1) return;
      c[k] += step[k];
      if (c[k] < 0 || c[k] >= dims[k]) return;
      tMax[k] += tDelta[k];
    }
  }

  /** Nearest hit along a unit ray. */
  function raycast(o, d, maxT = 20) {
    let best = null;
    traverse(o, d, maxT, (t, tri, u, v, cellExit) => {
      if (!best || t < best.t) best = { t, tri, u, v };
      return best.t <= cellExit; // nearest hit inside the current cell → done
    });
    if (!best) return null;
    return { t: best.t, point: [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t], normal: smoothNormal(best.tri, best.u, best.v), faceNormal: faceNormal(best.tri), tri: best.tri };
  }

  /** All hits along o + t d, t ∈ [0, maxT] (sorted). */
  function raycastAll(o, d, maxT) {
    const hits = [];
    traverse(o, d, maxT, (t, tri, u, v) => { hits.push({ t, tri, u, v }); return false; });
    hits.sort((a, b) => a.t - b.t);
    return hits.map((h) => ({ t: h.t, tri: h.tri, point: [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t], faceNormal: faceNormal(h.tri), normal: smoothNormal(h.tri, h.u, h.v) }));
  }

  function closestOnTri(t, p) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const A = [P[a], P[a + 1], P[a + 2]], B = [P[b], P[b + 1], P[b + 2]], C = [P[c], P[c + 1], P[c + 2]];
    const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const ab = sub(B, A), ac = sub(C, A), ap = sub(p, A);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return A;
    const bp = sub(p, B), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return B;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [A[0] + ab[0] * v, A[1] + ab[1] * v, A[2] + ab[2] * v]; }
    const cp = sub(p, C), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return C;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [A[0] + ac[0] * w, A[1] + ac[1] * w, A[2] + ac[2] * w]; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [B[0] + (C[0] - B[0]) * w, B[1] + (C[1] - B[1]) * w, B[2] + (C[2] - B[2]) * w]; }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return [A[0] + ab[0] * v + ac[0] * w, A[1] + ab[1] * v + ac[1] * w, A[2] + ab[2] * v + ac[2] * w];
  }

  /** Closest surface point within maxR (grid shells). */
  function closestPoint(p, maxR = 0.2) {
    const c = [cellOf(p[0], 0), cellOf(p[1], 1), cellOf(p[2], 2)];
    let best = null, bd = Infinity;
    const maxRing = Math.ceil(maxR / cell) + 1;
    stampId++;
    for (let r = 0; r <= maxRing; r++) {
      if (best && (r - 1) * cell > bd) break;
      for (let z = c[2] - r; z <= c[2] + r; z++) for (let y = c[1] - r; y <= c[1] + r; y++) for (let x = c[0] - r; x <= c[0] + r; x++) {
        if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== r) continue;
        if (x < 0 || y < 0 || z < 0 || x >= DX || y >= DY || z >= DZ) continue;
        const ci = (z * DY + y) * DX + x;
        for (let j = counts[ci]; j < counts[ci + 1]; j++) {
          const t = items[j];
          if (stamp[t] === stampId) continue;
          stamp[t] = stampId;
          const q = closestOnTri(t, p);
          const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
          if (d < bd) { bd = d; best = { point: q, tri: t, distance: d }; }
        }
      }
    }
    if (best) best.normal = faceNormal(best.tri);
    return best;
  }

  /**
   * Snap a catalog position to the skin along its `view` (CONTRACT §4.3):
   * the crossing nearest to `pos` whose outward normal faces the view.
   */
  function snap(pos, view, range = 0.16) {
    if (view === 'internal') return { pos: pos.slice(), normal: [0, 0, 1], internal: true };
    const d = viewDirection(view, pos[0]);
    if (d) {
      const o = [pos[0] - d[0] * range, pos[1] - d[1] * range, pos[2] - d[2] * range];
      let best = null;
      for (const h of raycastAll(o, d, 2 * range)) {
        const fn = h.faceNormal;
        if (fn[0] * d[0] + fn[1] * d[1] + fn[2] * d[2] <= 0) continue; // entering, not exiting
        if (!best || Math.abs(h.t - range) < Math.abs(best.t - range)) best = h;
      }
      if (best) return { pos: best.point, normal: best.normal, internal: false };
    }
    const c = closestPoint(pos, 0.3);
    if (!c) return { pos: pos.slice(), normal: [0, 0, 1], internal: false };
    const t = c.tri;
    return { pos: c.point, normal: c.normal, internal: false, tri: t };
  }

  return { raycast, raycastAll, closestPoint, snap, bounds: [...mn, ...mx] };
}
