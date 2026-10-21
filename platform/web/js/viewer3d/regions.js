/**
 * Body-zone resolution for clicks on the skin (CONTRACT §4.4 region ids).
 * Pure functions; works for any model normalised to the CONTRACT §4.3 frame
 * (a swapped GLB can pass its own skeleton landmarks or reuse the default).
 * @module viewer3d/regions
 */

/** Region ids that every model must be able to resolve (subset of regions.json). */
export const REGION_IDS = [
  'head', 'face', 'neck', 'thorax', 'abdomen', 'pelvis', 'upper-back', 'lower-back', 'gluteal',
  'arm', 'forearm', 'hand', 'thigh', 'knee', 'leg', 'foot',
];

function segDist(p, a, b) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const px = p[0] - a[0], py = p[1] - a[1], pz = p[2] - a[2];
  let t = (px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - bx * t, py - by * t, pz - bz * t);
}

/** Default skeleton landmarks (patient LEFT side) matching body-sdf.js neutral. */
export const DEFAULT_SKELETON = {
  shoulderJ: [0.172, 1.402, -0.012], elbow: [0.27, 1.136, -0.008], wrist: [0.378, 0.92, 0.009],
  fingertip: [0.475, 0.735, 0.04], hipJ: [0.088, 0.905, -0.004], knee: [0.103, 0.492, 0.004], ankle: [0.118, 0.086, -0.022],
};

/**
 * Resolve the clinical body zone for a surface point.
 * @param {number[]} p [x,y,z] in the CONTRACT frame
 * @param {object} [sk] skeleton landmarks (patient LEFT side)
 * @returns {{regionId:string, side:'R'|'L'|'C'}}
 */
export function regionAt(p, sk = DEFAULT_SKELETON) {
  const [x, y, z] = p;
  const ax = Math.abs(x);
  const side = x > 0.025 ? 'L' : x < -0.025 ? 'R' : 'C';
  const q = [ax, y, z];
  // upper limb
  if (ax > 0.13 && y < 1.44 && y > 0.6) {
    const du = segDist(q, sk.shoulderJ, sk.elbow);
    const df = segDist(q, sk.elbow, sk.wrist);
    const dh = segDist(q, sk.wrist, sk.fingertip);
    const m = Math.min(du, df, dh);
    const torsoHalf = y > 1.15 ? 0.17 : 0.16;
    if (m < 0.075 && (ax > torsoHalf || y < 1.0)) {
      const id = m === dh ? 'hand' : m === df ? 'forearm' : 'arm';
      return { regionId: id, side: side === 'C' ? 'L' : side };
    }
  }
  // head & neck
  if (y > 1.585) return { regionId: z > 0.035 && y < 1.70 && ax < 0.07 ? 'face' : 'head', side };
  if (y > 1.515) return { regionId: z > 0.02 ? 'face' : 'neck', side };
  if (y > 1.45 && ax < 0.09) return { regionId: 'neck', side };
  // lower limb
  const legSide = side === 'C' ? (x >= 0 ? 'L' : 'R') : side;
  if (y < 0.115) return { regionId: 'foot', side: legSide };
  if (y < 0.43) return { regionId: 'leg', side: legSide };
  if (y < 0.56) return { regionId: 'knee', side: legSide };
  if (y < 0.80 || (y < 0.86 && ax > 0.05 && z > -0.04) || (y < 0.84 && ax > 0.03)) return { regionId: 'thigh', side: legSide };
  // trunk
  const back = z < -0.015;
  if (y >= 1.16) return { regionId: back ? 'upper-back' : 'thorax', side };
  if (y >= 0.95) return { regionId: back ? 'lower-back' : 'abdomen', side };
  return { regionId: back ? 'gluteal' : 'pelvis', side };
}
