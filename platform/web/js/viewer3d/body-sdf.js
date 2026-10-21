/**
 * YOU HEAL Clinical — procedural human body as a signed distance field (SDF).
 *
 * Pure math, no DOM / no three.js, so it runs in the browser (viewer + SVG
 * fallback), in a Worker, and in Node (catalog build / tests).
 *
 * Frame (CONTRACT §4.3): metres, feet at y = 0, vertex ≈ 1.75, body faces +z,
 * +x is the patient's LEFT. The body is bilaterally symmetric, so every
 * primitive is authored for the patient's LEFT side (x > 0) and the field is
 * evaluated at |x|.
 *
 * Shape vocabulary:
 *  - `loft`      : a swept elliptical / super-elliptical cross-section along a
 *                  segment, with front/back depth asymmetry and centre offsets
 *                  (torso, neck, limbs, hands, feet).
 *  - `ellipsoid` : oriented ellipsoids for muscle masses / bony landmarks.
 *  - `roundCone` : capsules with different end radii.
 * Primitives are combined with polynomial smooth-min so joints read as one
 * sculpted surface (mannequin look) instead of intersecting parts.
 *
 * @module viewer3d/body-sdf
 */

const { sqrt, abs, min, max, floor, pow } = Math;

/** Polynomial smooth minimum (union) with blend radius k. */
export function smin(a, b, k) {
  const h = max(k - abs(a - b), 0) / k;
  return min(a, b) - h * h * k * 0.25;
}
/** Polynomial smooth maximum (used for smooth subtraction). */
export function smax(a, b, k) {
  const h = max(k - abs(a - b), 0) / k;
  return max(a, b) + h * h * k * 0.25;
}

const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add3 = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Rotation matrix (row-major 3x3) from XYZ Euler angles in radians. */
function eulerMatrix(rx = 0, ry = 0, rz = 0) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz * Ry * Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

// ---------------------------------------------------------------------------
// Primitives. Each returns { f(x,y,z) -> distance, box:[x0,y0,z0,x1,y1,z1] }.
// ---------------------------------------------------------------------------

/**
 * Oriented ellipsoid (iq's bound approximation).
 * @param {number[]} c centre  @param {number[]} r radii  @param {number[]} [rot] Euler XYZ radians
 */
export function ellipsoid(c, r, rot) {
  const [cx, cy, cz] = c, [rx, ry, rz] = r;
  const M = rot ? eulerMatrix(rot[0], rot[1], rot[2]) : null;
  const rm = max(rx, ry, rz);
  const f = (x, y, z) => {
    let dx = x - cx, dy = y - cy, dz = z - cz;
    if (M) { // local = R^T * d
      const lx = M[0] * dx + M[3] * dy + M[6] * dz;
      const ly = M[1] * dx + M[4] * dy + M[7] * dz;
      const lz = M[2] * dx + M[5] * dy + M[8] * dz;
      dx = lx; dy = ly; dz = lz;
    }
    const ax = dx / rx, ay = dy / ry, az = dz / rz;
    const k0 = sqrt(ax * ax + ay * ay + az * az);
    if (k0 < 1e-9) return -min(rx, ry, rz);
    const bx = ax / rx, by = ay / ry, bz = az / rz;
    const k1 = sqrt(bx * bx + by * by + bz * bz);
    return k0 * (k0 - 1) / k1;
  };
  const lb = (x, y, z) => { const dx = x - cx, dy = y - cy, dz = z - cz; return sqrt(dx * dx + dy * dy + dz * dz) - rm; };
  return { f, lb, box: [cx - rm, cy - rm, cz - rm, cx + rm, cy + rm, cz + rm] };
}

/** Capsule with different end radii (exact SDF, iq). */
export function roundCone(a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const f = (x, y, z) => {
    const pax = x - a[0], pay = y - a[1], paz = z - a[2];
    const yv = pax * bax + pay * bay + paz * baz;
    const zv = yv - l2;
    const qx = pax * l2 - bax * yv, qy = pay * l2 - bay * yv, qz = paz * l2 - baz * yv;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yv * yv * l2, z2 = zv * zv * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zv) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yv) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
    return (sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
  };
  const m = max(r1, r2);
  return {
    f,
    lb: segBound(a, b, m),
    box: [min(a[0], b[0]) - m, min(a[1], b[1]) - m, min(a[2], b[2]) - m, max(a[0], b[0]) + m, max(a[1], b[1]) + m, max(a[2], b[2]) + m],
  };
}

const TABLE = 192;

/**
 * Loft: elliptical (or super-elliptical, exponent n) cross-section swept along
 * segment a→b. `front` is a hint for the local "front" axis (orthogonalised).
 * side = normalize(cross(axis, front)).
 * keys: [[u, w, f, b, off, offS], ...] with u ∈ [0,1]; w = half-width along
 * side, f/b = half-depth on the +front / −front half, off/offS = centre
 * offsets along front / side. Interpolated with Catmull-Rom (C1) into a table.
 */
export function loft(a, b, front, keys, n = 2) {
  const axis = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  let fr = add3(front, axis, -dot3(front, axis));
  fr = norm3(fr);
  const side = norm3(cross3(axis, fr));
  // Build tables
  const P = 5;
  const tab = new Float64Array(TABLE * P);
  const der = new Float64Array(TABLE * P);
  const ks = keys.map((k) => [k[0], k[1], k[2], k[3], k[4] || 0, k[5] || 0]);
  const evalKey = (u, p) => {
    // non-uniform Catmull-Rom (finite-difference tangents)
    let i = 0;
    while (i < ks.length - 2 && u > ks[i + 1][0]) i++;
    const k0 = ks[i], k1 = ks[i + 1];
    const u0 = k0[0], u1 = k1[0];
    const t = clampN((u - u0) / (u1 - u0 || 1), 0, 1);
    const tang = (j) => {
      const prev = ks[max(j - 1, 0)], next = ks[min(j + 1, ks.length - 1)];
      return (next[p + 1] - prev[p + 1]) / ((next[0] - prev[0]) || 1);
    };
    const m0 = tang(i) * (u1 - u0), m1 = tang(i + 1) * (u1 - u0);
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * k0[p + 1] + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * k1[p + 1] + (t3 - t2) * m1;
  };
  for (let i = 0; i < TABLE; i++) {
    const u = i / (TABLE - 1);
    for (let p = 0; p < P; p++) tab[i * P + p] = evalKey(u, p);
  }
  for (let i = 0; i < TABLE; i++) {
    const i0 = max(i - 1, 0), i1 = min(i + 1, TABLE - 1);
    const du = (i1 - i0) / (TABLE - 1) * L;
    for (let p = 0; p < P; p++) der[i * P + p] = (tab[i1 * P + p] - tab[i0 * P + p]) / du;
  }
  const [ax, ay, az] = a, [dx, dy, dz] = axis, [fx, fy, fz] = fr, [sx, sy, sz] = side;
  const sq = clampN((n - 2) / 1.0, 0, 1);
  const f = (x, y, z) => {
    const px = x - ax, py = y - ay, pz = z - az;
    const t = px * dx + py * dy + pz * dz;
    const u = t / L;
    const uc = u < 0 ? 0 : u > 1 ? 1 : u;
    const fi = uc * (TABLE - 1);
    let i0 = floor(fi); if (i0 >= TABLE - 1) i0 = TABLE - 2;
    const w1 = fi - i0, w0 = 1 - w1;
    const o0 = i0 * P, o1 = o0 + P;
    const W = tab[o0] * w0 + tab[o1] * w1;
    const F = tab[o0 + 1] * w0 + tab[o1 + 1] * w1;
    const B = tab[o0 + 2] * w0 + tab[o1 + 2] * w1;
    const O = tab[o0 + 3] * w0 + tab[o1 + 3] * w1;
    const OS = tab[o0 + 4] * w0 + tab[o1 + 4] * w1;
    const s = px * sx + py * sy + pz * sz - OS;
    const fv = px * fx + py * fy + pz * fz - O;
    const D = fv > 0 ? F : B;
    const q = sqrt(s * s + fv * fv);
    const as = (s < 0 ? -s : s) / W, af = (fv < 0 ? -fv : fv) / D;
    let kk = sqrt(as * as + af * af);
    if (sq > 0) { // squarer section: blend of L2 and L4 norms (cheap super-ellipse)
      const a2 = as * as, f2 = af * af;
      kk = (1 - sq) * kk + sq * sqrt(sqrt(a2 * a2 + f2 * f2));
    }
    let d2;
    if (kk < 1e-9) { d2 = -(W < D ? W : D); }
    else {
      const r = q / kk;
      d2 = q - r;
      // slope correction so the field stays close to a true distance on tapers
      const cs = (s < 0 ? -s : s) / q, cf = (fv < 0 ? -fv : fv) / q;
      const dW = der[o0] * w0 + der[o1] * w1;
      const dD = fv > 0 ? der[o0 + 1] * w0 + der[o1 + 1] * w1 : der[o0 + 2] * w0 + der[o1 + 2] * w1;
      const dO = der[o0 + 3] * w0 + der[o1 + 3] * w1;
      const dOS = der[o0 + 4] * w0 + der[o1 + 4] * w1;
      const r3 = r * r * r;
      let g = r3 * cs * cs / (W * W * W) * dW + r3 * cf * cf / (D * D * D) * dD;
      g += dO * (fv > 0 ? cf : -cf) + dOS * (s > 0 ? cs : -cs);
      d2 /= sqrt(1 + g * g);
    }
    if (u < 0 || u > 1) {
      const ov = u < 0 ? -t : t - L;
      return d2 > 0 ? sqrt(d2 * d2 + ov * ov) : ov;
    }
    return d2;
  };
  // Conservative bounding box
  let maxR = 0;
  for (let i = 0; i < TABLE; i++) {
    const o = i * P;
    maxR = max(maxR, tab[o] + abs(tab[o + 4]), max(tab[o + 1], tab[o + 2]) + abs(tab[o + 3]));
  }
  return {
    f,
    lb: segBound(a, b, maxR * 1.05),
    box: [min(a[0], b[0]) - maxR, min(a[1], b[1]) - maxR, min(a[2], b[2]) - maxR, max(a[0], b[0]) + maxR, max(a[1], b[1]) + maxR, max(a[2], b[2]) + maxR],
  };
}

/** Lower bound of the distance to anything within radius r of segment ab. */
function segBound(a, b, r) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const il = 1 / (bx * bx + by * by + bz * bz);
  return (x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2];
    let t = (px * bx + py * by + pz * bz) * il; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - bx * t, dy = py - by * t, dz = pz - bz * t;
    return sqrt(dx * dx + dy * dy + dz * dz) - r;
  };
}

/** Chord parameter u ∈ [0,1] of point p projected on segment a→b. */
function chainU(a, b, p) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return dot3([p[0] - a[0], p[1] - a[1], p[2] - a[2]], d) / dot3(d, d);
}

/**
 * Loft along the chord of a joint chain (polyline). Rows are [u, w, f, b,
 * dOff?, dOffS?] along the chord; the polyline's deviation from the chord is
 * added to the centre offsets (piecewise linear, smoothed by the spline).
 */
export function chainLoft(points, front, rows, n = 2) {
  const a = points[0], b = points[points.length - 1];
  const axis = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const fr = norm3(add3(front, axis, -dot3(front, axis)));
  const side = norm3(cross3(axis, fr));
  const vs = points.map((p) => {
    const u = chainU(a, b, p);
    const proj = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    const dev = [p[0] - proj[0], p[1] - proj[1], p[2] - proj[2]];
    return { u, off: dot3(dev, fr), offS: dot3(dev, side) };
  });
  const devAt = (u) => {
    for (let i = 0; i < vs.length - 1; i++) {
      if (u <= vs[i + 1].u || i === vs.length - 2) {
        const t = clampN((u - vs[i].u) / ((vs[i + 1].u - vs[i].u) || 1), 0, 1);
        return { off: vs[i].off + (vs[i + 1].off - vs[i].off) * t, offS: vs[i].offS + (vs[i + 1].offS - vs[i].offS) * t };
      }
    }
    return { off: 0, offS: 0 };
  };
  const keys = rows.map((r) => { const d = devAt(r[0]); return [r[0], r[1], r[2], r[3], (r[4] || 0) + d.off, (r[5] || 0) + d.offS]; });
  return loft(a, b, front, keys, n);
}

function clampN(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---------------------------------------------------------------------------
// Body definition
// ---------------------------------------------------------------------------

/** Proportion presets — modest, medical-atlas style. */
export const SEX_PRESETS = {
  neutral: { shoulder: 1.0, hip: 1.0, waist: 1.0, chest: 0.5, breast: 0, limb: 1.0, neck: 1.0, glute: 1.0 },
  male: { shoulder: 1.06, hip: 0.96, waist: 1.03, chest: 1.0, breast: 0, limb: 1.05, neck: 1.08, glute: 0.95 },
  female: { shoulder: 0.93, hip: 1.07, waist: 0.92, chest: 0.2, breast: 1.0, limb: 0.94, neck: 0.92, glute: 1.08 },
};

/**
 * Build the body SDF.
 * @param {{sex?: 'neutral'|'male'|'female'}} [opts]
 * @returns {{ sdf:(x:number,y:number,z:number)=>number, bounds:number[], skeleton:object, sex:string }}
 */
export function buildBody(opts = {}) {
  const sex = SEX_PRESETS[opts.sex] ? opts.sex : 'neutral';
  const P = SEX_PRESETS[sex];
  const sh = P.shoulder, hp = P.hip, wa = P.waist, lm = P.limb;

  // ---------------- skeleton landmarks (patient LEFT side, x > 0) ----------
  const dirA = (ang, fz) => norm3([Math.sin(ang), -Math.cos(ang), fz]);
  const shoulderJ = [0.170 * sh, 1.405, -0.012];
  const armDir = dirA(0.34, 0.02);
  const elbow = add3(shoulderJ, armDir, 0.29);
  const foreDir = dirA(0.45, 0.08);
  const wrist = add3(elbow, foreDir, 0.25);
  const handDir = dirA(0.40, 0.05);
  const knuckle = add3(wrist, handDir, 0.09);
  const fingDir = dirA(0.36, 0.22);
  const fingertip = add3(knuckle, fingDir, 0.085);
  const hipJ = [0.088 * hp, 0.905, -0.004];
  const knee = [0.100 * (0.5 + 0.5 * hp), 0.490, 0.004];
  const ankle = [0.112, 0.085, -0.022];
  const legDir1 = norm3([knee[0] - hipJ[0], knee[1] - 0.975, knee[2] - hipJ[2]]);
  const legDir2 = norm3([ankle[0] - knee[0], ankle[1] - knee[1], ankle[2] - knee[2]]);
  const skeleton = { shoulderJ, elbow, wrist, knuckle, fingertip, hipJ, knee, ankle, armDir, foreDir, handDir };

  const prims = []; // {f, lb, k, op}
  const U = (p, k) => prims.push({ ...p, k, op: 0 });
  const S = (p, k) => prims.push({ ...p, k, op: 1 }); // smooth subtraction

  // ---------------- torso (loft along y, front = +z, soft super-ellipse) ---
  const Y0 = 0.79, Y1 = 1.505;
  const T = (y, w, f, b, off) => [(y - Y0) / (Y1 - Y0), w, f, b, off];
  U(loft([0, Y0, 0], [0, Y1, 0], [0, 0, 1], [
    T(0.800, 0.030, 0.025, 0.030, -0.012),
    T(0.825, 0.070 * hp, 0.055, 0.065, -0.014),
    T(0.860, 0.125 * hp, 0.078, 0.090, -0.016),
    T(0.910, 0.150 * hp, 0.088, 0.098, -0.015),
    T(0.970, 0.145 * hp, 0.090, 0.090, -0.010),
    T(1.025, 0.143 * (hp + wa) / 2, 0.090, 0.082, -0.002),
    T(1.075, 0.142 * wa, 0.089, 0.078, 0.003),
    T(1.130, 0.145 * wa, 0.094, 0.082, 0.005),
    T(1.200, 0.151 * (wa + sh) / 2, 0.102, 0.090, 0.005),
    T(1.270, 0.158 * sh, 0.107, 0.097, 0.002),
    T(1.340, 0.162 * sh, 0.100, 0.098, -0.004),
    T(1.400, 0.156 * sh, 0.084, 0.090, -0.010),
    T(1.445, 0.120 * sh, 0.062, 0.075, -0.016),
    T(1.480, 0.068, 0.046, 0.056, -0.018),
    T(1.505, 0.040, 0.030, 0.040, -0.018),
  ], 2.25), 0);

  U(ellipsoid([0, 1.030, 0.032], [0.100 * wa, 0.100, 0.056]), 0.05);              // abdomen
  U(ellipsoid([0, 1.235, 0.022], [0.138 * sh, 0.105, 0.085]), 0.05);              // rib cage
  const pc = 0.6 + 0.4 * P.chest;
  U(ellipsoid([0.068 * sh, 1.320, 0.078], [0.066 * sh, 0.046 * pc + 0.008, 0.034 * pc], [0, 0, -0.25]), 0.03); // pectoral
  if (P.breast > 0) U(ellipsoid([0.080 * sh, 1.268, 0.082], [0.054, 0.052, 0.046], [0.25, 0, 0]), 0.045);
  U(ellipsoid([0.118 * sh, 1.220, -0.035], [0.040, 0.110, 0.060], [0, 0, 0.15]), 0.05); // latissimus
  U(ellipsoid([0.082 * sh, 1.300, -0.060], [0.060, 0.090, 0.040], [0, 0, 0.18]), 0.05); // scapula
  U(ellipsoid([0.060, 1.120, -0.050], [0.045, 0.090, 0.035]), 0.05);               // erector spinae
  U(ellipsoid([0.068 * hp, 0.866, -0.058], [0.078 * P.glute, 0.086, 0.065 * P.glute], [0.1, 0, 0.1]), 0.05); // gluteus maximus
  U(ellipsoid([0.108 * hp, 0.905, -0.020], [0.048, 0.075, 0.062]), 0.06);         // gluteus medius / hip
  S(roundCone([0, 1.005, -0.112], [0, 1.395, -0.120], 0.012, 0.012), 0.03);       // spinal groove

  // ---------------- neck & shoulder girdle ---------------------------------
  const nk = P.neck;
  U(roundCone([0, 1.410, -0.024], [0, 1.580, -0.016], 0.057 * nk, 0.050 * nk), 0.04);
  U(roundCone([0.050, 1.575, -0.022], [0.018, 1.447, 0.045], 0.014 * nk, 0.012), 0.02); // sternocleidomastoid
  U(roundCone([0.030, 1.490, -0.035], [0.155 * sh, 1.440, -0.020], 0.045 * nk, 0.040), 0.045); // trapezius
  U(roundCone([0.018, 1.445, 0.050], [0.155 * sh, 1.448, 0.012], 0.010, 0.012), 0.02); // clavicle
  U(ellipsoid(add3(add3(shoulderJ, armDir, 0.03), [0.014, 0.012, 0]), [0.048 * lm, 0.070, 0.056 * lm], [0, 0, 0.34]), 0.03); // deltoid

  // ---------------- limbs: one loft per limb along the chord of its joint
  // chain; the joint deviation is encoded as centre offsets, so knees and
  // elbows are seamless (no overlapping parts).
  const uaA = add3(shoulderJ, armDir, -0.02), wristEnd = add3(wrist, foreDir, 0.012);
  const uE = chainU(uaA, wristEnd, elbow);
  U(chainLoft([uaA, elbow, wristEnd], [0, 0, 1], [
    [0.00, 0.047 * lm, 0.047 * lm, 0.047 * lm],
    [0.10, 0.046 * lm, 0.046 * lm, 0.045 * lm],
    [0.28, 0.041 * lm, 0.046 * lm, 0.042 * lm, 0.002],
    [uE - 0.12, 0.036 * lm, 0.040 * lm, 0.038 * lm],
    [uE - 0.03, 0.034 * lm, 0.034 * lm, 0.035 * lm],
    [uE, 0.034 * lm, 0.033 * lm, 0.035 * lm],
    [uE + 0.05, 0.037 * lm, 0.034 * lm, 0.035 * lm],
    [uE + 0.12, 0.041 * lm, 0.035 * lm, 0.034 * lm, 0.002],
    [uE + 0.25, 0.035 * lm, 0.029 * lm, 0.029 * lm],
    [0.95, 0.0285 * lm, 0.021 * lm, 0.021 * lm],
    [1.00, 0.027 * lm, 0.019 * lm, 0.020 * lm],
  ]), 0.035);
  // hand: palm + fused fingers in one loft (fingers curl slightly forward)
  const handA = add3(wrist, handDir, -0.014);
  const uK = chainU(handA, fingertip, knuckle);
  U(chainLoft([handA, knuckle, fingertip], [0, 0, 1], [
    [0.00, 0.026, 0.018, 0.019],
    [0.15, 0.031, 0.019, 0.018],
    [0.35, 0.036, 0.018, 0.016],
    [uK - 0.06, 0.040, 0.0155, 0.014],
    [uK, 0.039, 0.0140, 0.0125],
    [uK + 0.06, 0.038, 0.0125, 0.011],
    [0.76, 0.034, 0.010, 0.009],
    [0.90, 0.027, 0.009, 0.008],
    [0.96, 0.020, 0.0075, 0.007],
    [1.00, 0.006, 0.003, 0.003],
  ]), 0.012);
  const sideOut = norm3(cross3([0, 0, 1], handDir)); // lateral (away from the torso) for the left hand
  const thumbBase = add3(add3(add3(wrist, handDir, 0.024), sideOut, 0.021), [0, 0, 1], 0.005);
  const thumbDir = norm3(add3(add3(handDir, sideOut, 0.32), [0, 0, 1], 0.30));
  U(ellipsoid(add3(add3(add3(wrist, handDir, 0.036), sideOut, 0.013), [0, 0, 1], 0.008), [0.015, 0.026, 0.011], [0, 0, 0.40]), 0.012); // thenar
  U(roundCone(thumbBase, add3(thumbBase, thumbDir, 0.034), 0.0125, 0.010), 0.01);
  U(roundCone(add3(thumbBase, thumbDir, 0.034), add3(thumbBase, thumbDir, 0.058), 0.010, 0.0082), 0.004);

  // leg: hip → knee → ankle
  const legA = [hipJ[0] - 0.006, 0.99, hipJ[2] - 0.002], legB = [ankle[0], ankle[1] - 0.02, ankle[2]];
  const uKn = chainU(legA, legB, knee);
  const uCalf = chainU(legA, legB, [knee[0], 0.36, 0]);
  U(chainLoft([legA, knee, legB], [0, 0, 1], [
    [0.00, 0.035 * lm, 0.035 * lm, 0.035 * lm, 0, 0.030],
    [0.06, 0.068 * lm, 0.068 * lm, 0.072 * lm, 0, 0.016],
    [0.13, 0.088 * lm, 0.087 * lm, 0.090 * lm, 0, 0.010],
    [0.20, 0.084 * lm, 0.083 * lm, 0.081 * lm, 0.004, 0.006],
    [0.34, 0.073 * lm, 0.073 * lm, 0.068 * lm, 0.004, 0.002],
    [uKn - 0.08, 0.057 * lm, 0.059 * lm, 0.054 * lm],
    [uKn - 0.02, 0.051 * lm, 0.055 * lm, 0.050 * lm],
    [uKn, 0.050 * lm, 0.056 * lm, 0.049 * lm],
    [uKn + 0.035, 0.049 * lm, 0.052 * lm, 0.051 * lm],
    [uCalf - 0.06, 0.051 * lm, 0.048 * lm, 0.060 * lm, 0, 0.003],
    [uCalf, 0.053 * lm, 0.044 * lm, 0.068 * lm, 0, 0.005],
    [uCalf + 0.09, 0.045 * lm, 0.039 * lm, 0.055 * lm, 0, 0.002],
    [0.86, 0.033 * lm, 0.031 * lm, 0.035 * lm],
    [0.95, 0.027, 0.028, 0.029],
    [1.00, 0.026, 0.027, 0.028],
  ]), 0.06);
  U(ellipsoid([knee[0], knee[1] + 0.012, knee[2] + 0.044], [0.024, 0.029, 0.014]), 0.016); // patella
  U(ellipsoid([ankle[0] - 0.024, ankle[1] - 0.004, ankle[2] + 0.002], [0.011, 0.015, 0.013]), 0.014); // medial malleolus (−x side of the left leg)
  U(ellipsoid([ankle[0] + 0.025, ankle[1] - 0.014, ankle[2] - 0.008], [0.011, 0.015, 0.013]), 0.014); // lateral malleolus
  const heel = [0.113, 0.036, -0.075];
  const toe = [0.145, 0.020, 0.185];
  U(loft(heel, toe, [0, 1, 0], [
    [0.00, 0.014, 0.012, 0.014],
    [0.05, 0.026, 0.026, 0.028],
    [0.16, 0.031, 0.050, 0.032],
    [0.32, 0.034, 0.052, 0.031, -0.004],
    [0.55, 0.040, 0.034, 0.024, -0.004, 0.002],
    [0.75, 0.045, 0.024, 0.021, 0, 0.004],
    [0.90, 0.041, 0.018, 0.018, 0, 0.006],
    [0.97, 0.030, 0.012, 0.012, 0, 0.007],
    [1.00, 0.014, 0.006, 0.006, 0, 0.007],
  ]), 0.03);

  // ---------------- head ---------------------------------------------------
  const head = [];
  const HU = (p, k) => head.push({ ...p, k, op: 0 });
  const HS = (p, k) => head.push({ ...p, k, op: 1 });
  // head: a loft of transverse sections (y, half-width, front, back, centre z)
  // giving the sagittal profile forehead → brow → orbit → cheek → mouth → chin,
  // plus a few features. Stylised, calm mannequin face.
  const HY0 = 1.50, HY1 = 1.751;
  const Hk = (y, w, fz, bz) => [(y - HY0) / (HY1 - HY0), w, (fz - bz) / 2, (fz - bz) / 2, (fz + bz) / 2];
  HU(loft([0, HY0, 0], [0, HY1, 0], [0, 0, 1], [
    Hk(1.500, 0.010, 0.030, 0.010),
    Hk(1.512, 0.024, 0.052, -0.004),
    Hk(1.524, 0.036, 0.070, -0.020),
    Hk(1.538, 0.044, 0.077, -0.036),
    Hk(1.554, 0.050, 0.080, -0.058),
    Hk(1.572, 0.058, 0.082, -0.078),
    Hk(1.592, 0.064, 0.085, -0.090),
    Hk(1.612, 0.068, 0.083, -0.098),
    Hk(1.632, 0.071, 0.080, -0.103),
    Hk(1.652, 0.074, 0.085, -0.106),
    Hk(1.668, 0.076, 0.088, -0.107),
    Hk(1.692, 0.076, 0.083, -0.104),
    Hk(1.716, 0.069, 0.071, -0.094),
    Hk(1.735, 0.053, 0.050, -0.074),
    Hk(1.746, 0.030, 0.026, -0.044),
    Hk(1.751, 0.006, 0.004, -0.012),
  ], 2.3), 0);
  HU(ellipsoid([0, 1.531, 0.066], [0.017, 0.012, 0.012]), 0.016);       // mental protuberance
  HU(ellipsoid([0.050, 1.620, 0.050], [0.017, 0.011, 0.015]), 0.025);   // zygoma (soft)
  HS(ellipsoid([0.032, 1.639, 0.094], [0.016, 0.0095, 0.013]), 0.012);   // orbit
  HU(ellipsoid([0.032, 1.6385, 0.073], [0.0105, 0.009, 0.009]), 0.008); // eyelid mound
  HU(roundCone([0, 1.648, 0.086], [0, 1.608, 0.099], 0.0065, 0.0105), 0.014); // nose
  HU(ellipsoid([0, 1.566, 0.080], [0.017, 0.0055, 0.0065]), 0.01);      // lips (subtle)
  HU(ellipsoid([0.075, 1.624, -0.016], [0.0085, 0.025, 0.015], [0, 0.25, 0]), 0.008); // ear
  const headPrims = head;

  // ---------------- assemble ----------------------------------------------
  // Two groups: body primitives, and head primitives (combined on their own,
  // then blended into the neck). A uniform acceleration grid stores, per cell,
  // the primitives that can influence the field there (conservative, using
  // 1-Lipschitz lower bounds), which makes evaluation ~5x faster.
  const groups = [prims, headPrims].map((list) => ({
    f: list.map((p) => p.f), k: list.map((p) => p.k), op: list.map((p) => p.op), lb: list.map((p) => p.lb), n: list.length,
  }));
  const HEAD_K = 0.026;
  const combineIdx = (g, idx, n, x, y, z) => {
    let d = Infinity;
    for (let j = 0; j < n; j++) {
      const i = idx ? idx[j] : j;
      const k = g.k[i];
      if (g.op[i] === 0) {
        if (d !== Infinity && g.lb[i](x, y, z) > d + k) continue;
        const v = g.f[i](x, y, z);
        d = k > 0 && d !== Infinity ? smin(d, v, k) : (v < d ? v : d);
      } else {
        if (d === Infinity || g.lb[i](x, y, z) > k - d) continue;
        d = smax(d, -g.f[i](x, y, z), k);
      }
    }
    return d;
  };
  const fullSdf = (x, y, z) => {
    x = x < 0 ? -x : x;
    const d = combineIdx(groups[0], null, groups[0].n, x, y, z);
    const dh = combineIdx(groups[1], null, groups[1].n, x, y, z);
    return dh === Infinity ? d : d === Infinity ? dh : smin(d, dh, HEAD_K);
  };

  const bounds = [-0.53, -0.004, -0.17, 0.53, 1.78, 0.235];
  const G = 0.03, gx0 = 0, gy0 = bounds[1], gz0 = bounds[2];
  const GX = Math.ceil(bounds[3] / G), GY = Math.ceil((bounds[4] - gy0) / G), GZ = Math.ceil((bounds[5] - gz0) / G);
  const hd = G * Math.sqrt(3) / 2, margin = 0.01;
  const cellLists = [new Array(GX * GY * GZ), new Array(GX * GY * GZ)];
  const cellFar = new Float32Array(GX * GY * GZ);
  for (let J = 0; J < GY; J++) for (let K = 0; K < GZ; K++) for (let I = 0; I < GX; I++) {
    const c = (J * GZ + K) * GX + I;
    const x = gx0 + (I + 0.5) * G, y = gy0 + (J + 0.5) * G, z = gz0 + (K + 0.5) * G;
    const dc = fullSdf(x, y, z);
    const U = dc + hd + margin;
    let any = false;
    for (let gi = 0; gi < 2; gi++) {
      const g = groups[gi];
      const keep = [];
      for (let i = 0; i < g.n; i++) {
        const lbc = g.lb[i](x, y, z) - hd;
        const kk = g.k[i] + (gi === 1 ? HEAD_K : 0);
        if (g.op[i] === 0 ? lbc <= U + kk : lbc <= kk - (dc - hd) + margin) keep.push(i);
      }
      if (keep.length) any = true;
      cellLists[gi][c] = keep.length ? Int16Array.from(keep) : null;
    }
    cellFar[c] = any ? 0 : Math.max(dc - hd, 0.002);
  }

  /** Signed distance (metres, negative inside). */
  const sdf = (x, y, z) => {
    if (x < 0) x = -x;
    const I = floor((x - gx0) / G), J = floor((y - gy0) / G), K = floor((z - gz0) / G);
    if (I < 0 || J < 0 || K < 0 || I >= GX || J >= GY || K >= GZ) return fullSdf(x, y, z);
    const c = (J * GZ + K) * GX + I;
    const far = cellFar[c];
    if (far > 0) return far;
    const lb = cellLists[0][c], lh = cellLists[1][c];
    const d = lb ? combineIdx(groups[0], lb, lb.length, x, y, z) : Infinity;
    if (!lh) return d;
    const dh = combineIdx(groups[1], lh, lh.length, x, y, z);
    return dh === Infinity ? d : d === Infinity ? dh : smin(d, dh, HEAD_K);
  };

  return { sex, sdf, sdfExact: fullSdf, bounds, skeleton };
}

// ---------------------------------------------------------------------------
// Geometry helpers on an SDF
// ---------------------------------------------------------------------------

/** Normalised gradient (outward normal) via tetrahedral differences. */
export function sdfNormal(sdf, x, y, z, e = 0.0008) {
  const a = sdf(x + e, y - e, z - e), b = sdf(x - e, y - e, z + e), c = sdf(x - e, y + e, z - e), d = sdf(x + e, y + e, z + e);
  const nx = a - b - c + d, ny = -a - b + c + d, nz = -a + b - c + d;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Newton-project a point onto the zero level set. */
export function projectToSurface(sdf, p, iters = 6) {
  let [x, y, z] = p;
  for (let i = 0; i < iters; i++) {
    const d = sdf(x, y, z);
    if (abs(d) < 1e-5) break;
    const n = sdfNormal(sdf, x, y, z);
    x -= n[0] * d; y -= n[1] * d; z -= n[2] * d;
  }
  return [x, y, z];
}

/**
 * Ray / sphere-trace: first surface hit along origin + t*dir (dir unit),
 * t ∈ [0, maxT]. Returns t or -1.
 */
export function sphereTrace(sdf, o, dir, maxT = 10, minStep = 0.0008) {
  let t = 0;
  let prevD = sdf(o[0], o[1], o[2]);
  if (prevD < 0) return 0;
  for (let i = 0; i < 400 && t < maxT; i++) {
    const step = max(prevD * 0.8, minStep);
    const t1 = t + step;
    const d = sdf(o[0] + dir[0] * t1, o[1] + dir[1] * t1, o[2] + dir[2] * t1);
    if (d < 0) { // bisection between t and t1
      let lo = t, hi = t1;
      for (let j = 0; j < 20; j++) {
        const m = (lo + hi) / 2;
        const dm = sdf(o[0] + dir[0] * m, o[1] + dir[1] * m, o[2] + dir[2] * m);
        if (dm < 0) hi = m; else lo = m;
      }
      return (lo + hi) / 2;
    }
    t = t1; prevD = d;
  }
  return -1;
}

/**
 * Find the surface crossing nearest to `p` on the line p + t*dirOut whose
 * outward normal faces dirOut (i.e. the surface seen from that side).
 * Searches |t| ≤ range. Returns {t, pos} or null.
 */
export function snapAlong(sdf, p, dirOut, range = 0.16) {
  const at = (t) => sdf(p[0] + dirOut[0] * t, p[1] + dirOut[1] * t, p[2] + dirOut[2] * t);
  const step = 0.0015;
  let best = null;
  // walk from -range to +range looking for inside→outside transitions along +dirOut
  let tPrev = -range, dPrev = at(tPrev);
  for (let t = -range + step; t <= range + 1e-9; t += step) {
    const d = at(t);
    if (dPrev < 0 && d >= 0) {
      let lo = tPrev, hi = t;
      for (let j = 0; j < 22; j++) { const m = (lo + hi) / 2; if (at(m) < 0) lo = m; else hi = m; }
      const tc = (lo + hi) / 2;
      if (!best || abs(tc) < abs(best.t)) best = { t: tc };
    }
    tPrev = t; dPrev = d;
  }
  if (!best) return null;
  best.pos = [p[0] + dirOut[0] * best.t, p[1] + dirOut[1] * best.t, p[2] + dirOut[2] * best.t];
  return best;
}

/** Outward direction for a catalog `view` and side sign (x sign of the instance). */
export function viewDirection(view, xSign) {
  switch (view) {
    case 'anterior': return [0, 0, 1];
    case 'posterior': return [0, 0, -1];
    case 'lateral': return [xSign >= 0 ? 1 : -1, 0, 0];
    case 'superior': return [0, 1, 0];
    case 'inferior': return [0, -1, 0];
    default: return null;
  }
}

/**
 * Snap a catalog position to the skin.
 * @returns {{pos:number[], normal:number[], internal:boolean}}
 */
export function snapPoint(sdf, pos, view) {
  if (view === 'internal') return { pos: pos.slice(), normal: [0, 0, 1], internal: true };
  const dir = viewDirection(view, pos[0]);
  let hit = dir ? snapAlong(sdf, pos, dir) : null;
  let q = hit ? hit.pos : projectToSurface(sdf, pos);
  if (!hit) q = projectToSurface(sdf, q);
  return { pos: q, normal: sdfNormal(sdf, q[0], q[1], q[2]), internal: false };
}

// ---------------------------------------------------------------------------
// Mesher: naive surface nets on a sparse (coarse-culled) grid, vertices
// Newton-projected onto the exact zero set, normals from the SDF gradient.
// ---------------------------------------------------------------------------

/**
 * Polygonise an SDF.
 * @param {(x:number,y:number,z:number)=>number} sdf
 * @param {{bounds:number[], h?:number, coarse?:number}} o
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array}}
 */
export function polygonize(sdf, o) {
  const h = o.h || 0.005;
  const [x0, y0, z0, x1, y1, z1] = o.bounds;
  const nx = Math.ceil((x1 - x0) / (4 * h)) * 4 + 1, ny = Math.ceil((y1 - y0) / (4 * h)) * 4 + 1, nz = Math.ceil((z1 - z0) / (4 * h)) * 4 + 1;
  // Level 0 (step 4h): full grid. Level 1 (step 2h): evaluated only inside
  // level-0 cells near the surface. Level 2 (step h): evaluated per slab only
  // inside level-1 cells near the surface. Elsewhere the sign is uniform and
  // copied from the parent level.
  const mkLevel = (step, parent) => {
    const NX = (nx - 1) / step + 1, NY = (ny - 1) / step + 1, NZ = (nz - 1) / step + 1;
    const v = new Float32Array(NX * NY * NZ);
    for (let J = 0; J < NY; J++) for (let K = 0; K < NZ; K++) for (let I = 0; I < NX; I++) {
      let val;
      if (parent) {
        const r = parent.step / step;
        let pI = floor(I / r), pJ = floor(J / r), pK = floor(K / r);
        if (pI > parent.NX - 2) pI = parent.NX - 2; if (pJ > parent.NY - 2) pJ = parent.NY - 2; if (pK > parent.NZ - 2) pK = parent.NZ - 2;
        if (parent.near[(pJ * (parent.NZ - 1) + pK) * (parent.NX - 1) + pI]) val = sdf(x0 + I * step * h, y0 + J * step * h, z0 + K * step * h);
        else val = parent.v[(Math.round(J / r) * parent.NZ + Math.round(K / r)) * parent.NX + Math.round(I / r)];
      } else val = sdf(x0 + I * step * h, y0 + J * step * h, z0 + K * step * h);
      v[(J * NZ + K) * NX + I] = val;
    }
    const thr = 1.05 * step * h;
    const near = new Uint8Array((NX - 1) * (NY - 1) * (NZ - 1));
    for (let J = 0; J < NY - 1; J++) for (let K = 0; K < NZ - 1; K++) for (let I = 0; I < NX - 1; I++) {
      let mn = Infinity, neg = false, ps = false;
      for (let c = 0; c < 8; c++) {
        const val = v[((J + ((c >> 1) & 1)) * NZ + K + ((c >> 2) & 1)) * NX + I + (c & 1)];
        const a = val < 0 ? -val : val;
        if (a < mn) mn = a;
        if (val < 0) neg = true; else ps = true;
      }
      if (mn < thr || (neg && ps)) near[(J * (NZ - 1) + K) * (NX - 1) + I] = 1;
    }
    return { step, NX, NY, NZ, v, near };
  };
  const L1 = mkLevel(2, mkLevel(4, null));
  const C = 2, NX = L1.NX, NY = L1.NY, NZ = L1.NZ, cv = L1.v, near = L1.near;
  const cidx = (I, J, K) => (J * NZ + K) * NX + I;
  const nidx = (I, J, K) => (J * (NZ - 1) + K) * (NX - 1) + I;
  const cnx = nx - 1, cnz = nz - 1;
  const layer = (j) => {
    const L = new Float32Array(nx * nz);
    let J = floor(j / C); if (J > NY - 2) J = NY - 2;
    const onBoundary = j % C === 0 && j > 0;
    const Jr = Math.round(j / C) > NY - 1 ? NY - 1 : Math.round(j / C);
    const y = y0 + j * h;
    for (let k = 0; k < nz; k++) {
      let K = floor(k / C); if (K > NZ - 2) K = NZ - 2;
      const Kr = Math.round(k / C) > NZ - 1 ? NZ - 1 : Math.round(k / C);
      const z = z0 + k * h;
      for (let i = 0; i < nx; i++) {
        let I = floor(i / C); if (I > NX - 2) I = NX - 2;
        const isNear = near[nidx(I, J, K)] || (onBoundary && near[nidx(I, J - 1, K)]);
        if (isNear) L[k * nx + i] = sdf(x0 + i * h, y, z);
        else {
          const Ir = Math.round(i / C) > NX - 1 ? NX - 1 : Math.round(i / C);
          L[k * nx + i] = cv[cidx(Ir, Jr, Kr)];
        }
      }
    }
    return L;
  };
  const pos = [];
  const quads = [];
  let prevCells = new Int32Array(cnx * cnz).fill(-1);
  let V0 = layer(0);
  const cv8 = new Float64Array(8);
  // corner c -> (di, dj, dk); edges as corner pairs
  const CI = [0, 1, 0, 1, 0, 1, 0, 1], CJ = [0, 0, 0, 0, 1, 1, 1, 1], CK = [0, 0, 1, 1, 0, 0, 1, 1];
  const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3], EB = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
  for (let j = 0; j < ny - 1; j++) {
    const V1 = layer(j + 1);
    const cells = new Int32Array(cnx * cnz).fill(-1);
    let J = floor(j / C); if (J > NY - 2) J = NY - 2;
    for (let k = 0; k < cnz; k++) {
      let K = floor(k / C); if (K > NZ - 2) K = NZ - 2;
      for (let i = 0; i < cnx; i++) {
        let I = floor(i / C); if (I > NX - 2) I = NX - 2;
        if (!near[nidx(I, J, K)]) continue;
        const b0 = k * nx + i, b1 = b0 + nx;
        cv8[0] = V0[b0]; cv8[1] = V0[b0 + 1]; cv8[2] = V0[b1]; cv8[3] = V0[b1 + 1];
        cv8[4] = V1[b0]; cv8[5] = V1[b0 + 1]; cv8[6] = V1[b1]; cv8[7] = V1[b1 + 1];
        let mask = 0;
        for (let c = 0; c < 8; c++) if (cv8[c] < 0) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = EA[e], b = EB[e];
          const va = cv8[a], vb = cv8[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          sx += CI[a] + (CI[b] - CI[a]) * t;
          sy += CJ[a] + (CJ[b] - CJ[a]) * t;
          sz += CK[a] + (CK[b] - CK[a]) * t;
          cnt++;
        }
        cells[k * cnx + i] = pos.length / 3;
        pos.push(x0 + (i + sx / cnt) * h, y0 + (j + sy / cnt) * h, z0 + (k + sz / cnt) * h);
      }
    }
    // y-edges inside this slab
    for (let k = 1; k < cnz; k++) for (let i = 1; i < cnx; i++) {
      const a = V0[k * nx + i], b = V1[k * nx + i];
      if ((a < 0) === (b < 0)) continue;
      quads.push(cells[(k - 1) * cnx + i - 1], cells[(k - 1) * cnx + i], cells[k * cnx + i], cells[k * cnx + i - 1]);
    }
    if (j > 0) {
      // x-edges and z-edges on layer j (shared by slabs j-1 and j)
      for (let k = 1; k < cnz; k++) for (let i = 0; i < cnx; i++) {
        const a = V0[k * nx + i], b = V0[k * nx + i + 1];
        if ((a < 0) === (b < 0)) continue;
        quads.push(prevCells[(k - 1) * cnx + i], prevCells[k * cnx + i], cells[k * cnx + i], cells[(k - 1) * cnx + i]);
      }
      for (let k = 0; k < cnz; k++) for (let i = 1; i < cnx; i++) {
        const a = V0[k * nx + i], b = V0[(k + 1) * nx + i];
        if ((a < 0) === (b < 0)) continue;
        quads.push(prevCells[k * cnx + i - 1], prevCells[k * cnx + i], cells[k * cnx + i], cells[k * cnx + i - 1]);
      }
    }
    prevCells = cells;
    V0 = V1;
  }
  const nv = pos.length / 3;
  const P = new Float32Array(pos);
  const Nn = new Float32Array(nv * 3);
  // one Newton step; value and gradient come from the same 4 tetrahedral samples
  const e = 0.0007;
  for (let v = 0; v < nv; v++) {
    let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const a = sdf(x + e, y - e, z - e), b = sdf(x - e, y - e, z + e), c = sdf(x - e, y + e, z - e), d = sdf(x + e, y + e, z + e);
    let gx = a - b - c + d, gy = -a - b + c + d, gz = -a + b - c + d;
    const l = Math.hypot(gx, gy, gz) || 1;
    gx /= l; gy /= l; gz /= l;
    const st = clampN((a + b + c + d) * 0.25, -h, h);
    P[v * 3] = x - gx * st; P[v * 3 + 1] = y - gy * st; P[v * 3 + 2] = z - gz * st;
    Nn[v * 3] = gx; Nn[v * 3 + 1] = gy; Nn[v * 3 + 2] = gz;
  }
  // triangulate quads, orient by normals, split along the shorter diagonal
  const idx = new Uint32Array((quads.length / 4) * 6);
  let w = 0;
  const d2 = (a, b) => { const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2]; return dx * dx + dy * dy + dz * dz; };
  for (let q = 0; q < quads.length; q += 4) {
    let a = quads[q], b = quads[q + 1], c = quads[q + 2], d = quads[q + 3];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    // orientation: compare face normal with vertex normals
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const sn = fx * (Nn[a * 3] + Nn[c * 3]) + fy * (Nn[a * 3 + 1] + Nn[c * 3 + 1]) + fz * (Nn[a * 3 + 2] + Nn[c * 3 + 2]);
    if (sn < 0) { const t = b; b = d; d = t; }
    if (d2(a, c) <= d2(b, d)) { idx[w++] = a; idx[w++] = b; idx[w++] = c; idx[w++] = a; idx[w++] = c; idx[w++] = d; }
    else { idx[w++] = a; idx[w++] = b; idx[w++] = d; idx[w++] = b; idx[w++] = c; idx[w++] = d; }
  }
  return { positions: P, normals: Nn, indices: idx.subarray(0, w) };
}
