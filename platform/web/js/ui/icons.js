// Original stroke icon set (24×24, 1.75 stroke). Rendered as inline SVG via createElementNS.
import { svgEl } from './dom.js';

const P = {
  home: ['M3 11.5 12 4l9 7.5', 'M5.5 10v9.5h13V10', 'M10 19.5v-5h4v5'],
  users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.8c2 .7 3.2 2.5 3.5 5.2'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 20.5c.8-4 4-6 8-6s7.2 2 8 6'],
  book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20', 'M8 7.5h8', 'M8 11h6'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20.5 20.5-4.5-4.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  chevronRight: ['m9 5 7 7-7 7'],
  chevronLeft: ['m15 5-7 7 7 7'],
  chevronDown: ['m5 9 7 7 7-7'],
  arrowLeft: ['M19 12H5', 'm11 6-6 6 6 6'],
  play: ['M7 4.5v15l12-7.5Z'],
  pause: ['M8 5v14', 'M16 5v14'],
  timer: ['M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M12 9v4l2.5 2', 'M10 2.5h4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  print: ['M7 9V3h10v6', 'M7 18H4.5A1.5 1.5 0 0 1 3 16.5v-6A1.5 1.5 0 0 1 4.5 9h15a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H17', 'M7 14h10v7H7Z'],
  logout: ['M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15', 'M10 16.5 14.5 12 10 7.5', 'M14.5 12H4'],
  sun: ['M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z', 'M12 2v2', 'M12 20v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm4.9 19.1 1.4-1.4', 'm17.7 6.3 1.4-1.4'],
  moon: ['M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z'],
  monitor: ['M3 5h18v11H3Z', 'M8 20h8', 'M12 16v4'],
  shield: ['M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6Z', 'm9 12 2 2 4-4'],
  alert: ['M12 3.5 2.5 20h19Z', 'M12 10v4.5', 'M12 17.5v.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5.5', 'M12 7.5v.01'],
  magnet: ['M6 3h4v8a2 2 0 0 0 4 0V3h4v8a6 6 0 0 1-12 0Z', 'M6 7h4', 'M14 7h4'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  sparkles: ['M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z'],
  file: ['M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8Z', 'M14 3v5h5', 'M8.5 13h7', 'M8.5 16.5h5'],
  clipboard: ['M9 4h6v3H9Z', 'M15 5.5h2.5A1.5 1.5 0 0 1 19 7v12.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5V7a1.5 1.5 0 0 1 1.5-1.5H9', 'm9 14 2 2 4-4'],
  calendar: ['M4.5 5.5h15A1.5 1.5 0 0 1 21 7v12.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5V7a1.5 1.5 0 0 1 1.5-1.5Z', 'M3 10h18', 'M8 3v5', 'M16 3v5'],
  edit: ['M4 20h4L19 9l-4-4L4 16Z', 'm13.5 6.5 4 4'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  copy: ['M9 9h11v11H9Z', 'M5 15H4V4h11v1'],
  lock: ['M6 11h12v9.5H6Z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  refresh: ['M20 11a8 8 0 0 0-14.6-4.5L4 8', 'M4 3.5V8h4.5', 'M4 13a8 8 0 0 0 14.6 4.5L20 16', 'M20 20.5V16h-4.5'],
  panelLeft: ['M3.5 4h17v16h-17Z', 'M9.5 4v16'],
  panelRight: ['M3.5 4h17v16h-17Z', 'M14.5 4v16'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 12h.01'],
  layers: ['m12 3 9 5-9 5-9-5Z', 'm3 13 9 5 9-5'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  keyboard: ['M3 6h18v12H3Z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M7 14h10'],
  upload: ['M12 16V4', 'm7 9 5-5 5 5', 'M4 16v3.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V16'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3 12h18', 'M12 3c2.5 2.4 3.7 5.4 3.7 9s-1.2 6.6-3.7 9c-2.5-2.4-3.7-5.4-3.7-9S9.5 5.4 12 3Z'],
  rotate: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  heart: ['M12 20s-7.5-4.5-7.5-10A4.5 4.5 0 0 1 12 7.5 4.5 4.5 0 0 1 19.5 10C19.5 15.5 12 20 12 20Z'],
};

export function icon(name, { size = 20, label = null, cls = '' } = {}) {
  const paths = P[name] || P.info;
  const s = svgEl('svg', {
    class: `icon ${cls}`.trim(), width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    focusable: 'false', 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label,
  }, paths.map((d) => svgEl('path', { d })));
  return s;
}

/** Brand mark: two poles joined by field lines. */
export function brandMark(size = 28) {
  return svgEl('svg', { class: 'brand-mark', width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' },
    svgEl('path', { d: 'M8 16c0-6 3.6-10 8-10s8 4 8 10', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, class: 'bm-line' }),
    svgEl('path', { d: 'M8 16c0 6 3.6 10 8 10s8-4 8-10', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, class: 'bm-line' }),
    svgEl('path', { d: 'M8 16c0-3.4 3.6-5.6 8-5.6s8 2.2 8 5.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.1, opacity: 0.6, class: 'bm-line' }),
    svgEl('path', { d: 'M8 16c0 3.4 3.6 5.6 8 5.6s8-2.2 8-5.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.1, opacity: 0.6, class: 'bm-line' }),
    svgEl('circle', { cx: 8, cy: 16, r: 3, class: 'bm-neg' }),
    svgEl('circle', { cx: 24, cy: 16, r: 3, class: 'bm-pos' }),
  );
}
