// Loads the 3D viewer (CONTRACT §6) and falls back to the 2D body map if the module is missing
// or fails to initialise. Never throws to the caller.
import { createBodyMap2D } from './map2d.js';

let modPromise = null;
function load3D() {
  if (!modPromise) {
    modPromise = import('/js/viewer3d/viewer.js')
      .then((m) => (typeof m.createBodyViewer === 'function' ? m : null))
      .catch((err) => { console.info('[bodymap] 3D viewer unavailable, using 2D map:', err && err.message); return null; });
  }
  return modPromise;
}

/** Returns { viewer, kind: '3d'|'2d', error? } */
export async function createViewer(container, opts, { prefer2D = false } = {}) {
  if (!prefer2D) {
    const mod = await load3D();
    if (mod) {
      try {
        const viewer = await mod.createBodyViewer(container, opts);
        if (viewer) return { viewer, kind: viewer.renderer === 'svg' ? 'svg' : viewer.kind || '3d' };
      } catch (err) {
        console.warn('[bodymap] 3D viewer failed to start, using 2D map:', err);
        while (container.firstChild) container.removeChild(container.firstChild);
      }
    }
  }
  const viewer = await createBodyMap2D(container, opts);
  return { viewer, kind: '2d' };
}

/** Offscreen render of anterior + posterior snapshots with magnets (for reports / protocol cards). */
export async function renderSnapshots({ points, regions, polarity, locale, magnets, pairs = [], views = ['anterior', 'posterior'], width = 800, height = 1100 }) {
  const host = document.createElement('div');
  host.className = 'offscreen-viewer';
  host.style.width = `${Math.round(width / 2)}px`;
  host.style.height = `${Math.round(height / 2)}px`;
  document.body.append(host);
  let viewer = null;
  try {
    ({ viewer } = await createViewer(host, { points, regions, locale, polarity, sex: 'neutral', onPointClick() {}, onRegionClick() {}, onHover() {} }));
    viewer.setShowAllPoints && viewer.setShowAllPoints(false);
    viewer.setMagnets(magnets);
    viewer.setPairs && viewer.setPairs(pairs);
    const out = {};
    for (const v of views) {
      out[v] = await viewer.snapshot({ view: v, width, height, transparent: false });
    }
    return out;
  } catch (err) {
    console.warn('[bodymap] snapshot failed', err);
    return null;
  } finally {
    try { viewer && viewer.dispose(); } catch { /* ignore */ }
    host.remove();
  }
}
