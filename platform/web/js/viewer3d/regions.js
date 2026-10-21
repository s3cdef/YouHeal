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

/** Default skeleton landmarks (patient LEFT side): MakeHuman neutral preset. */
export const DEFAULT_SKELETON = {
  shoulderJ: [0.189, 1.3906, 0.0206], elbow: [0.3577, 1.2008, 0.0212], wrist: [0.4868, 1.0688, 0.1943],
  knuckle: [0.5401, 0.9884, 0.2952], fingertip: [0.5426, 0.9426, 0.3284],
  hipJ: [0.1056, 0.9215, 0.0047], knee: [0.1479, 0.5113, 0.0394], ankle: [0.1882, 0.0715, 0.0223], trunkZ: 0.05,
};

/**
 * Resolve the clinical body zone for a surface point. Thresholds are relative
 * to the skeleton landmarks, so any body normalised to the CONTRACT frame works.
 * @param {number[]} p [x,y,z] in the CONTRACT frame
 * @param {object} [sk] skeleton landmarks (patient LEFT side) + trunkZ (trunk depth centre)
 * @returns {{regionId:string, side:'R'|'L'|'C'}}
 */
export function regionAt(p, sk = DEFAULT_SKELETON) {
  const [x, y, z] = p;
  const ax = Math.abs(x);
  const side = x > 0.025 ? 'L' : x < -0.025 ? 'R' : 'C';
  const q = [ax, y, z];
  const hipY = sk.hipJ[1], kneeY = sk.knee[1], ankleY = sk.ankle[1];
  const trunkZ = sk.trunkZ ?? 0.005;
  // upper limb
  if (ax > 0.13 && y < sk.shoulderJ[1] + 0.05 && y > 0.6) {
    const du = segDist(q, sk.shoulderJ, sk.elbow);
    const df = segDist(q, sk.elbow, sk.wrist);
    const dh = segDist(q, sk.wrist, sk.fingertip);
    const m = Math.min(du, df, dh);
    const torsoHalf = sk.shoulderJ[0] - 0.01;
    if (m < 0.075 && (ax > torsoHalf || y < hipY + 0.08)) {
      const id = m === dh ? 'hand' : m === df ? 'forearm' : 'arm';
      return { regionId: id, side: side === 'C' ? 'L' : side };
    }
  }
  // head & neck
  if (y > 1.585) return { regionId: z > trunkZ + 0.03 && y < 1.70 && ax < 0.07 ? 'face' : 'head', side };
  if (y > 1.515) return { regionId: z > trunkZ + 0.015 ? 'face' : 'neck', side };
  if (y > sk.shoulderJ[1] + 0.05 && ax < 0.09) return { regionId: 'neck', side };
  // lower limb
  const legSide = side === 'C' ? (x >= 0 ? 'L' : 'R') : side;
  const back = z < trunkZ - 0.02;
  if (y < ankleY + 0.04) return { regionId: 'foot', side: legSide };
  if (y < kneeY - 0.065) return { regionId: 'leg', side: legSide };
  if (y < kneeY + 0.055) return { regionId: 'knee', side: legSide };
  const crotchY = hipY - 0.085;
  // front: below the inguinal line (pubic tubercle → ASIS); back: below the gluteal fold; side: below the trochanter
  const inguinal = hipY - 0.07 + (ax - 0.02) * 0.95;
  if (y < crotchY || (!back && y < inguinal && ax > 0.03) || (ax > sk.hipJ[0] + 0.03 && y < hipY - 0.03)) return { regionId: 'thigh', side: legSide };
  // trunk
  // anterior thorax/abdomen boundary follows the costal arch (xiphoid → lateral margin)
  const xiphoidY = hipY + 0.30;
  if (back ? y >= hipY + 0.23 : y >= xiphoidY - 0.6 * ax) return { regionId: back ? 'upper-back' : 'thorax', side };
  if (y >= hipY + 0.035) return { regionId: back ? 'lower-back' : 'abdomen', side };
  return { regionId: back ? 'gluteal' : 'pelvis', side };
}
