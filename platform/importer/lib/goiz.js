// Parser for the Goiz "Guía de Pares Biomagnéticos" (Level 1 and Level 2).
import { rows, isBoiler, clean, joinWrapped, columns } from './layout.js';
import { byY } from './pdf.js';

const NUM_RE = /^(\d{1,3})\.\s+(\S.*)$/;

// ---------------------------------------------------------------- index ----
// Parses "Índice General" entries: "N. A – B (Relation)   P. x" grouped by section header.
export function parseIndex(pages, { from, to, pageOffset, doc }) {
  const out = [];
  let section = null, cur = null, started = false;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const page of pages.slice(from - 1, to)) {
    for (const r of rows(page.lines.filter(l => !isBoiler(l.text) || /^P\.\s*\d+$/.test(l.text) && l.y0 < page.height * 0.9))) {
      const t = clean(r.text);
      let m;
      if ((m = t.match(/^Pares Biomagnéticos \((.+)\)$/))) { flush(); section = m[1]; started = true; continue; }
      if (!started) continue;
      if (/\.{5,}/.test(t)) { flush(); if (/^Recomendaciones/.test(t)) return out; continue; }
      if ((m = t.match(NUM_RE)) && +m[1] >= 1) {
        flush();
        cur = { doc, n: +m[1], section, text: m[2], page: null };
      } else if (cur) {
        cur.text = joinWrapped(cur.text, t);
      } else continue;
      const pm = cur.text.match(/^(.*?)\s*P\.\s*(\d+)$/);
      if (pm) { cur.text = pm[1]; cur.page = +pm[2]; }
    }
  }
  flush();
  return out;
}

// Split "A – B (Relation)" into point names and relation.
export function splitPairTitle(text) {
  let t = clean(text);
  let relation = null;
  // trailing balanced parenthesis group = relation
  if (t.endsWith(')')) {
    let depth = 0;
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i] === ')') depth++;
      else if (t[i] === '(' && --depth === 0) {
        const before = t.slice(0, i).trim();
        // only treat as relation if what is inside is not a side marker
        const inner = t.slice(i + 1, -1);
        if (!isSideMarker(inner)) { relation = inner.trim(); t = before; }
        break;
      }
    }
  }
  const parts = t.split(/\s+[–-]\s+/).map(s => s.trim()).filter(Boolean);
  return { parts, relation };
}

export const SIDE_TOKENS = /^(D|I|C|S|Inf|A|P|Lat|D\/I|I\/D|C\/D\/I|C\/\s*D\/I|Contralateral|contralateral|Ipsilateral|ipsilateral|Cualquiera|mismo lado|Inf\.?|S\/Inf|D\/I\/C|3\/4)$/i;
export const isSideMarker = s => s.split(/\s*,\s*/).every(x => SIDE_TOKENS.test(x.trim()));

// ---------------------------------------------------------------- pairs ----
// Locate every pair block ("N. Title" above a "Relación ..." line) and split its text column.
export function parsePairBlocks(pages, { from, to, pageOffset, doc, expected }) {
  const blocks = [];
  const warnings = [];
  for (const page of pages.slice(from - 1, to)) {
    const printed = page.pdfPage + pageOffset;
    const lines = page.lines.filter(l => !isBoiler(l.text)).sort(byY);
    const rel = lines.filter(l => /^Relación(\s|$)/.test(l.text));
    if (!rel.length) continue;
    const titles = [];
    let prevY = -1;
    for (const r of rel) {
      // nearest numbered line above r (and below previous relation line)
      const cands = lines.filter(l => l.y0 < r.y0 - 1 && l.y0 > prevY && NUM_RE.test(l.text) && expected.has(+l.text.match(NUM_RE)[1]));
      const title = cands.sort((a, b) => b.y0 - a.y0)[0];
      if (!title) { warnings.push(`p.${printed}: Relación without title at y=${r.y0.toFixed(0)}`); continue; }
      titles.push({ title, rel: r });
      prevY = r.y0;
    }
    titles.forEach(({ title, rel: r }, i) => {
      const end = i + 1 < titles.length ? titles[i + 1].title.y0 - 0.5 : Infinity;
      const start = i === 0 ? -Infinity : title.y0 - 0.5;
      const colX = r.x0 - 4;
      const titleLines = lines.filter(l => l.y0 >= title.y0 - 0.5 && l.y0 < r.y0 - 0.5 && l !== title && l.x0 >= colX)
        .filter(l => !/^\d{1,3}\.\s/.test(l.text));
      const text = lines.filter(l => l.y0 >= r.y0 - 0.5 && l.y0 < end && l.x0 >= colX);
      const figure = lines.filter(l => l.y0 >= start && l.y0 < end && l.x0 < colX && l !== title);
      const m = title.text.match(NUM_RE);
      blocks.push({ doc, n: +m[1], page: printed, title: clean(m[2]), titleExtra: titleLines.map(l => clean(l.text)), textLines: text, figure: figure.map(l => clean(l.text)), colX: r.x0 });
    });
  }
  return { blocks, warnings };
}

const countChecks = s => (s.match(/√/g) || []).length;

// Turn the text column of one block into structured fields.
export function interpretBlock(b) {
  const out = { relationText: null, ratings: {}, symptomLines: [], recLines: [], other: [] };
  let mode = 'head';
  const indentOf = l => l.x0 - b.colX;
  for (const l of b.textLines) {
    const t = clean(l.text);
    if (!t) continue;
    let m;
    if (mode === 'head' && (m = t.match(/^Relación\s*(.*)$/))) { out.relationText = m[1]; continue; }
    if ((mode === 'head' || mode === 'rel') && (m = t.match(/^([FPR])\s*(√[√\s]*)$/))) { out.ratings[m[1]] = countChecks(m[2]); mode = 'rel'; continue; }
    if (/^Sintomatolog[ií]a:?$/.test(t)) { mode = 'sym'; continue; }
    if (/^Recomendaciones:?$/.test(t)) { mode = 'rec'; continue; }
    if (/^Notas?:?$/.test(t)) { mode = 'note'; continue; }
    const item = { text: t, indent: indentOf(l) };
    if (mode === 'sym') out.symptomLines.push(item);
    else if (mode === 'rec') out.recLines.push(item);
    else if (mode === 'head' && out.relationText != null && out.ratings.F == null) out.relationText = joinWrapped(out.relationText, t);
    else out.other.push({ mode, ...item });
  }
  return out;
}

// Group raw lines into logical items: bullets "- x" and wrapped continuations.
export function groupLines(lines) {
  const items = [];
  for (const { text, indent } of lines) {
    const bullet = /^[-•]\s*/.test(text);
    const t = text.replace(/^[-•]\s*/, '');
    const prev = items[items.length - 1];
    const open = prev && (prev.text.split('(').length > prev.text.split(')').length);
    const contin = prev && !bullet && (open || /[-,]$/.test(prev.text) || (/^[a-záéíóúñü(]/.test(t) && !/^(pb|vs)\b/i.test(t)));
    if (contin) prev.text = joinWrapped(prev.text, t);
    else items.push({ text: t, bullet: bullet || indent > 4 });
  }
  return items;
}

// --------------------------------------------------------- column lists ----
// Generic two-column list reader for back-matter pages: returns ordered lines with column info.
export function columnLines(pages, from, to, pageOffset) {
  const out = [];
  for (const page of pages.slice(from - 1, to)) {
    const [left, right] = columns(page);
    for (const [ci, col] of [left, right].entries())
      for (const l of col) out.push({ text: clean(l.text), x: l.x0, y: l.y0, col: ci, page: page.pdfPage + pageOffset });
  }
  return out;
}
