/**
 * Shared, renderer-independent helpers for the WebGL viewer and the SVG
 * fallback (point instancing, localisation, colours).
 * @module viewer3d/viewer-common
 */

/** CONTRACT §3 default polarity colours. */
export const DEFAULT_POLARITY = { negative: '#2563EB', positive: '#DC2626' };

/** Arc colours by pair state (colour is never the only cue — states are also listed in the UI). */
export const PAIR_COLORS = {
  candidate: '#94A3B8',
  found: '#F59E0B',
  impacted: '#7C3AED',
  cleared: '#10B981',
};

const TEXT = {
  en: {
    canvasLabel: 'Interactive 3D body model. Arrow keys rotate, F front, B back, plus and minus zoom. Press Tab to browse the visible points.',
    roleDescription: '3D body viewer',
    listLabel: 'Visible body points',
    loading: 'Loading 3D model…',
    sides: { R: 'Right', L: 'Left', C: 'Center' },
    views: { anterior: 'Front view', posterior: 'Back view', left: 'Left side view', right: 'Right side view', superior: 'Top view' },
    fallbackNote: '3D is not available on this device — showing the 2D body map.',
  },
  es: {
    canvasLabel: 'Modelo corporal 3D interactivo. Flechas para girar, F frente, B espalda, más y menos para acercar. Pulse Tab para recorrer los puntos visibles.',
    roleDescription: 'visor corporal 3D',
    listLabel: 'Puntos corporales visibles',
    loading: 'Cargando modelo 3D…',
    sides: { R: 'Derecho', L: 'Izquierdo', C: 'Central' },
    views: { anterior: 'Vista frontal', posterior: 'Vista posterior', left: 'Vista lateral izquierda', right: 'Vista lateral derecha', superior: 'Vista superior' },
    fallbackNote: 'El 3D no está disponible en este dispositivo: se muestra el mapa corporal 2D.',
  },
};

/** UI strings for a locale (falls back to English). */
export function uiText(locale) { return TEXT[String(locale || 'en').slice(0, 2)] || TEXT.en; }

/** Localised point name with fallback en → es → id. */
export function localName(point, locale) {
  const n = point && point.name;
  if (!n) return point ? point.id : '';
  const l = String(locale || 'en').slice(0, 2);
  return n[l] || n.en || n.es || point.id;
}

/** Localised side label. */
export function sideLabel(side, locale) { return uiText(locale).sides[side] || side; }

/**
 * Expand catalog points into per-side instances.
 * Bilateral: R at x = −|x| (catalog pos) and mirrored L at +|x|. Central: as given.
 * When `laterality` is missing, |x| > 12 mm is treated as bilateral.
 * @param {object[]} points
 * @returns {{key:string, id:string, side:'R'|'L'|'C', point:object, view:string, pos:{x:number,y:number,z:number}}[]}
 */
export function buildInstances(points) {
  const out = [];
  for (const p of points) {
    if (!p || !p.id || !p.pos) continue;
    const view = p.view || 'anterior';
    const bilateral = p.laterality ? p.laterality === 'bilateral' : Math.abs(p.pos.x) > 0.012;
    if (bilateral) {
      const ax = Math.abs(p.pos.x);
      out.push({ key: `${p.id}|R`, id: p.id, side: 'R', point: p, view, pos: { x: -ax, y: p.pos.y, z: p.pos.z } });
      out.push({ key: `${p.id}|L`, id: p.id, side: 'L', point: p, view, pos: { x: ax, y: p.pos.y, z: p.pos.z } });
    } else {
      out.push({ key: `${p.id}|C`, id: p.id, side: 'C', point: p, view, pos: { ...p.pos } });
    }
  }
  return out;
}

/**
 * Find the instance for a (pointId, side) reference. Accepts sides
 * 'R','L','C','RL' (either) and falls back sensibly when the point's
 * laterality does not match the requested side.
 */
export function resolveInstance(byKey, pointId, side) {
  const order = side === 'L' ? ['L', 'C', 'R'] : side === 'R' ? ['R', 'C', 'L'] : side === 'C' ? ['C', 'R', 'L'] : ['R', 'C', 'L'];
  for (const s of order) {
    const inst = byKey.get(`${pointId}|${s}`);
    if (inst) return inst;
  }
  return null;
}
