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

/** Start fetching the 3D module graph (three.js) early, e.g. while the scan's data is still loading. */
export function preload3D() { load3D(); }

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

function loadImage(src) {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = src; });
}

/**
 * Crop every snapshot to the UNION of their content bounds (non-background pixels) plus padding, so the
 * body fills the frame whatever the camera fit / arm span, and front and back keep exactly the same scale.
 */
async function trimToUnion(snaps, { pad = 0.035, maxBytes = 1.9 * 1024 * 1024 } = {}) {
  const keys = Object.keys(snaps).filter((k) => snaps[k]);
  const imgs = await Promise.all(keys.map((k) => loadImage(snaps[k])));
  const W = imgs[0].naturalWidth; const H = imgs[0].naturalHeight;
  let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
  for (const im of imgs) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (d[i + 3] > 20 && (d[i] < 236 || d[i + 1] < 236 || d[i + 2] < 236)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
  }
  if (x1 < 0) return snaps; // blank — leave untouched
  const p = Math.round(Math.max(x1 - x0, y1 - y0) * pad);
  x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p); x1 = Math.min(W - 1, x1 + p); y1 = Math.min(H - 1, y1 + p);
  const cw = x1 - x0 + 1; const ch = y1 - y0 + 1;
  const out = {};
  keys.forEach((k, idx) => {
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch);
    g.drawImage(imgs[idx], x0, y0, cw, ch, 0, 0, cw, ch);
    let url = c.toDataURL('image/png');
    if (url.length > maxBytes) url = c.toDataURL('image/jpeg', 0.9); // stay under the 2 MB image limit
    out[k] = url;
  });
  return out;
}

/** Offscreen render of anterior + posterior snapshots with magnets (for reports / protocol cards). */
export async function renderSnapshots({ points, regions, polarity, locale, magnets, pairs = [], views = ['anterior', 'posterior'], width = 800, height = 1100, trim = true }) {
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
    return trim ? await trimToUnion(out).catch(() => out) : out;
  } catch (err) {
    console.warn('[bodymap] snapshot failed', err);
    return null;
  } finally {
    try { viewer && viewer.dispose(); } catch { /* ignore */ }
    host.remove();
  }
}
