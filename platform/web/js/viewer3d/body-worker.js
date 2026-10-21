/**
 * Module worker: prepares body geometry off the main thread.
 * in : { kind:'asset', sex, baseUrl? }  → fetch + decode the MakeHuman asset
 *      { kind:'sdf', sex, h }            → mesh the procedural fallback mannequin
 * out: typed arrays (transferred) + metadata, or { error }
 */
import { buildBody, polygonize } from './body-sdf.js';
import { loadBodyAsset } from './body-asset.js';
import { buildMeshGrid } from './mesh-query.js';

self.onmessage = async (ev) => {
  const { kind, sex, h, baseUrl } = ev.data || {};
  try {
    if (kind === 'asset') {
      const a = await loadBodyAsset({ sex, baseUrl: baseUrl || undefined });
      // collision grid for picking/snapping is built here too (off the main thread)
      a.grid = buildMeshGrid(a.positions, a.indices, { triCount: a.groups.skin.count });
      self.postMessage(a, [a.positions.buffer, a.normals.buffer, a.indices.buffer, a.grid.counts.buffer, a.grid.items.buffer]);
    } else {
      const body = buildBody({ sex });
      const m = polygonize(body.sdf, { bounds: body.bounds, h: h || 0.005 });
      self.postMessage(m, [m.positions.buffer, m.normals.buffer, m.indices.buffer]);
    }
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
