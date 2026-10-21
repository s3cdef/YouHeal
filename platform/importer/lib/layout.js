// Layout helpers built on top of pdf.js pages.
import { byY } from './pdf.js';

// Group the lines of a page (or a subset) into visual rows (same baseline band).
export function rows(lines, tol = 3) {
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const out = [];
  for (const l of sorted) {
    const yc = (l.y0 + l.y1) / 2;
    const r = out.find(r => Math.abs(r.yc - yc) < tol);
    if (r) r.cells.push(l);
    else out.push({ yc, y0: l.y0, cells: [l] });
  }
  for (const r of out) {
    r.cells.sort((a, b) => a.x0 - b.x0);
    r.x0 = r.cells[0].x0;
    r.text = r.cells.map(c => c.text).join('  ');
  }
  return out.sort((a, b) => a.yc - b.yc);
}

export const isBoiler = t => /GOIZ TM INTELLECTUAL PROPERTY|^\s*(Pg\.|P\.)\s*\d+\s*$|biomagnetismolibre\.wordpress\.com/.test(t);

// Printed page number from footer, or null.
export function printedPage(page) {
  let best = null;
  for (const l of page.lines) {
    if (l.y0 < page.height * 0.85) continue;
    const m = l.text.match(/^(?:Pg\.|P\.)\s*(\d+)$/) || l.text.match(/^biomagnetismolibre\.wordpress\.com\s+(\d+)$/) || (/^\d+$/.test(l.text) ? [0, l.text] : null);
    if (m && (!best || l.y0 > best.y)) best = { y: l.y0, n: +m[1] };
  }
  return best ? best.n : null;
}

// Split the content lines of a page into two columns (left then right) by x threshold.
export function columns(page, frac = 0.48) {
  const thr = page.width * frac;
  const content = page.lines.filter(l => !isBoiler(l.text)).sort(byY);
  return [content.filter(l => l.x0 < thr), content.filter(l => l.x0 >= thr)];
}

// Text normalization
export const clean = s => String(s).replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*[–—]\s*/g, ' – ').trim();
// Join wrapped lines: "Descen-" + "dente" -> "Descendente"; otherwise join with a space.
export function joinWrapped(a, b) {
  a = a.trimEnd(); b = b.trimStart();
  if (/[a-záéíóúñü]-$/i.test(a) && /^[a-záéíóúñü]/.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}
