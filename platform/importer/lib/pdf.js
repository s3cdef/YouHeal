// Thin wrapper around poppler's `pdftotext -bbox-layout`.
// Returns pages -> blocks -> lines with coordinates (PDF points, origin top-left).
import { execFileSync } from 'node:child_process';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});
const num = (attrs, k) => Number(attrs.match(new RegExp(`${k}="([-\\d.]+)"`))[1]);
const box = attrs => ({ x0: num(attrs, 'xMin'), y0: num(attrs, 'yMin'), x1: num(attrs, 'xMax'), y1: num(attrs, 'yMax') });

export function readPdf(file) {
  let xml;
  try {
    xml = execFileSync('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 1 << 30, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`pdftotext failed for ${file}: ${e.message}. Is poppler-utils installed?`);
  }
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let pm, idx = 0;
  while ((pm = pageRe.exec(xml))) {
    idx++;
    const page = { pdfPage: idx, width: +pm[1], height: +pm[2], blocks: [], lines: [] };
    const blockRe = /<block ([^>]*)>([\s\S]*?)<\/block>/g;
    let bm, bi = 0;
    while ((bm = blockRe.exec(pm[3]))) {
      const block = { ...box(bm[1]), id: bi++, lines: [] };
      const lineRe = /<line ([^>]*)>([\s\S]*?)<\/line>/g;
      let lm;
      while ((lm = lineRe.exec(bm[2]))) {
        const words = [];
        const wordRe = /<word ([^>]*)>([^<]*)<\/word>/g;
        let wm;
        while ((wm = wordRe.exec(lm[2]))) words.push({ ...box(wm[1]), t: decode(wm[2]) });
        const line = { ...box(lm[1]), block: block.id, words, text: words.map(w => w.t).join(' ') };
        block.lines.push(line);
        page.lines.push(line);
      }
      block.text = block.lines.map(l => l.text).join('\n');
      page.blocks.push(block);
    }
    pages.push(page);
  }
  return pages;
}

// Sort lines in reading order (top-to-bottom, then left-to-right), merging lines whose y overlap.
export const byY = (a, b) => (Math.abs(a.y0 - b.y0) < 2 ? a.x0 - b.x0 : a.y0 - b.y0);
