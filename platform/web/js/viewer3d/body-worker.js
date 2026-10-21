/**
 * Module worker: builds the procedural body mesh off the main thread.
 * message in : { sex, h }
 * message out: { positions, normals, indices } (transferred) or { error }
 */
import { buildBody, polygonize } from './body-sdf.js';

self.onmessage = (ev) => {
  try {
    const { sex, h } = ev.data || {};
    const body = buildBody({ sex });
    const m = polygonize(body.sdf, { bounds: body.bounds, h });
    self.postMessage(m, [m.positions.buffer, m.normals.buffer, m.indices.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
