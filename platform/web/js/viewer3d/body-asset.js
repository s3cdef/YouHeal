/**
 * Loader/decoder for the MakeHuman-derived body assets in web/assets/models/
 * (built by tools/3d/build-body.mjs). Pure JS: runs in a Worker, on the main
 * thread (SVG fallback) and in Node (catalog build / tests).
 *
 * Asset format "yh-body-v1": body.json header + body-index.bin (Uint16/Uint32
 * triangles shared by every preset) + body-<preset>.bin (Int16 positions,
 * normalised to the preset bbox). Smooth normals are rebuilt at decode time.
 * @module viewer3d/body-asset
 */

export const DEFAULT_MODELS_URL = new URL('../../assets/models/', import.meta.url);

/**
 * Decode raw buffers into typed arrays.
 * @param {object} header  parsed body.json
 * @param {string} preset  'neutral' | 'female' | 'male'
 * @param {ArrayBuffer} indexBuf
 * @param {ArrayBuffer} posBuf
 */
export function decodeBodyAsset(header, preset, indexBuf, posBuf) {
  const p = header.presets[preset] || header.presets.neutral;
  const q = new Int16Array(posBuf);
  const n = q.length / 3;
  if (n !== header.vertexCount) throw new Error('body asset: vertex count mismatch');
  const positions = new Float32Array(q.length);
  const mn = p.bboxMin, mx = p.bboxMax;
  for (let i = 0; i < q.length; i += 3) {
    for (let k = 0; k < 3; k++) positions[i + k] = mn[k] + ((q[i + k] + 32768) / 65535) * (mx[k] - mn[k]);
  }
  const indices = header.index.type === 'uint16' ? new Uint16Array(indexBuf) : new Uint32Array(indexBuf);
  const normals = computeNormals(positions, indices);
  // trunk depth centre (front/back split for region resolution)
  let zf = -Infinity, zb = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i]) < 0.03 && positions[i + 1] > 1.0 && positions[i + 1] < 1.35) { zf = Math.max(zf, positions[i + 2]); zb = Math.min(zb, positions[i + 2]); }
  }
  const skeleton = { ...p.skeleton, trunkZ: Number.isFinite(zf) ? +((zf + zb) / 2).toFixed(4) : 0.05 };
  return {
    preset: header.presets[preset] ? preset : 'neutral',
    positions, normals, indices,
    groups: header.groups,
    skeleton,
    bounds: [...mn, ...mx],
  };
}

/** Area-weighted smooth vertex normals. */
export function computeNormals(P, I) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
  return N;
}

/**
 * Fetch + decode a preset (browser / worker).
 * @param {{sex?:string, baseUrl?:string|URL}} [o]
 */
export async function loadBodyAsset(o = {}) {
  const base = o.baseUrl ? new URL(o.baseUrl, typeof location !== 'undefined' ? location.href : undefined) : DEFAULT_MODELS_URL;
  const get = async (name, kind) => {
    const r = await fetch(new URL(name, base));
    if (!r.ok) throw new Error(`body asset ${name}: HTTP ${r.status}`);
    return kind === 'json' ? r.json() : r.arrayBuffer();
  };
  const header = await get('body.json', 'json');
  if (header.format !== 'yh-body-v1') throw new Error('body asset: unknown format');
  const preset = header.presets[o.sex] ? o.sex : 'neutral';
  const [ib, pb] = await Promise.all([get(header.index.file), get(header.presets[preset].file)]);
  return decodeBodyAsset(header, preset, ib, pb);
}
