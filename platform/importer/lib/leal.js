// Parser for Oscar Leal, "Biomagnetismo Médico — Padecimientos & Patógenos" (2018 compendium).
import { clean, isBoiler } from './layout.js';

const TITLE_RE = /^(.+?)\s*\((Pt|Pd|Pr|Est)-([A-Za-z]{2})\)$/;
const LABELS = {
  kind: /^Patógeno \/ Par \/ Padecimiento:?$/,
  cls: /^Clasificación:?$/,
  contagion: /^Contagio \/ Causa:?$/,
  description: /^Descripción:?$/,
};

// 'Est' is not defined in the glossary; it is used for 15 entries describing states (e.g. Climaterio) -> condition.
export const TYPE_CODES = { Pt: 'pathogen', Pr: 'named-pair', Pd: 'condition', Est: 'condition' };
// Classification codes (glossary p.16–17) -> CONTRACT categories.
export const CLASS_CODES = {
  Vi: 'virus', Ba: 'bacteria', Ho: 'fungus', Pa: 'parasite', Pn: 'prion',
  Re: 'reservoir', RV: 'reservoir', RB: 'reservoir', RH: 'reservoir', RP: 'reservoir', RR: 'reservoir', RU: 'reservoir',
  Co: 'complex', DG: 'glandular-dysfunction', Es: 'special', Em: 'psychoemotional', Te: 'temporary',
};
export const CLASS_CODE_NAMES = {
  Vi: 'Virus', Ba: 'Bacteria', Ho: 'Hongo', Pa: 'Parásito', Pn: 'Prion', Re: 'Reservorio', Co: 'Complejo',
  DG: 'Disfunción Glandular', Es: 'Especial', Em: 'Psicoemocional', Te: 'Temporal', RV: 'Reservorio de Virus',
  RB: 'Reservorio de Bacterias', RH: 'Reservorio de Hongos', RP: 'Reservorio de Parásitos', RR: 'Reservorio de Priones',
  RU: 'Reservorio Universal',
};

export function parseLeal(pages, { from = 19, to = pages.length } = {}) {
  const entries = [];
  const warnings = [];
  let cur = null;
  for (const page of pages.slice(from - 1, to)) {
    const printed = page.pdfPage;
    const cx = page.width / 2;
    const lines = page.lines.filter(l => !isBoiler(l.text) && l.y0 < page.height * 0.92 && !/^Padecimientos & Patógenos( - [A-Z])?$/.test(clean(l.text)))
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    // ---- segment page into entity regions by title lines
    const titles = lines.filter(l => TITLE_RE.test(clean(l.text)) && Math.abs((l.x0 + l.x1) / 2 - cx) < 120 && !/\.{4,}/.test(l.text));
    const running = cur;
    const regions = [];
    const firstY = titles.length ? titles[0].y0 : Infinity;
    const contentAbove = lines.some(l => l.y0 < firstY - 1);
    if (running && contentAbove) regions.push({ entry: running, y0: -Infinity, y1: firstY });
    titles.forEach((t, i) => {
      const m = clean(t.text).match(TITLE_RE);
      const y1 = i + 1 < titles.length ? titles[i + 1].y0 : Infinity;
      if (i === 0 && running && running.rawTitle === clean(t.text) && !contentAbove) {
        regions.push({ entry: running, y0: t.y0 + 1, y1 });
        return;
      }
      cur = { name: clean(m[1]), type: m[2], cls: m[3], rawTitle: clean(t.text), page: printed, kindLabel: null, clsLabel: null,
              contagion: [], description: [], poles: [], protocols: [], tableCols: null };
      entries.push(cur);
      regions.push({ entry: cur, y0: t.y0 + 1, y1 });
    });
    for (const r of regions) {
      if (!r.entry) continue;
      const rl = lines.filter(l => l.y0 >= r.y0 && l.y0 < r.y1);
      consumeRegion(r.entry, rl, page, warnings, printed);
    }
  }
  for (const e of entries) { delete e.tableCols; delete e._lastField; delete e._started; }
  return { entries, warnings };
}

function consumeRegion(e, lines, page, warnings, printed) {
  e._started = true;
  const blocksById = new Map(page.blocks.map(b => [b.id, b]));
  const used = new Set();
  // header row of the poles table
  const neg = lines.find(l => /^Polo Negativo$/.test(clean(l.text)));
  const pos = lines.find(l => /^Polo Positivo$/.test(clean(l.text)));
  const prot = lines.find(l => /^Protocolo \/ Top$/.test(clean(l.text)));
  if (neg && pos) e.tableCols = { negX: (neg.x0 + neg.x1) / 2, posX: (pos.x0 + pos.x1) / 2, protX: prot ? (prot.x0 + prot.x1) / 2 : 640, y: neg.y0 };
  const tableY = neg ? neg.y0 : (e.tableCols && !lines.some(l => LABELS.description.test(clean(l.text)) || LABELS.contagion.test(clean(l.text))) && lines.every(l => (l.x1 - l.x0) < 300) ? -Infinity : Infinity);
  for (const h of [neg, pos, prot]) if (h) used.add(h);

  // ---- labels
  for (const l of lines) {
    const t = clean(l.text);
    if (l.y0 >= tableY) continue;
    if (LABELS.kind.test(t)) {
      used.add(l);
      const v = lines.find(o => !used.has(o) && Math.abs(o.y0 - l.y0) < 3 && o.x0 > l.x1 && o.x0 < page.width * 0.55);
      if (v) { e.kindLabel = clean(v.text); used.add(v); }
    } else if (LABELS.cls.test(t)) {
      used.add(l);
      const v = lines.find(o => !used.has(o) && Math.abs(o.y0 - l.y0) < 3 && o.x0 > l.x1);
      if (v) { e.clsLabel = clean(v.text); used.add(v); }
    }
  }
  // ---- prose blocks (contagion / description), assigned by label vertical position
  for (const l of lines) {
    const m = l.y0 < tableY && clean(l.text).match(/^(Contagio \/ Causa|Descripción):\s+(.+)$/);
    if (m) { used.add(l); const f = m[1] === 'Descripción' ? 'description' : 'contagion'; e[f].push(m[2]); e._lastField = f; }
  }
  const labelLines = lines.filter(l => !used.has(l) && l.y0 < tableY && (LABELS.contagion.test(clean(l.text)) || LABELS.description.test(clean(l.text))));
  labelLines.forEach(l => used.add(l));
  const proseLines = lines.filter(l => !used.has(l) && l.y0 < tableY && l.x0 > 125);
  const proseBlocks = [...new Set(proseLines.map(l => l.block))].map(id => blocksById.get(id)).sort((a, b) => a.y0 - b.y0);
  for (const b of proseBlocks) {
    const blines = proseLines.filter(l => l.block === b.id);
    blines.forEach(l => used.add(l));
    const lab = labelLines.find(l => { const yc = (l.y0 + l.y1) / 2; return yc >= b.y0 - 2 && yc <= b.y1 + 2; });
    let field = lab ? (LABELS.contagion.test(clean(lab.text)) ? 'contagion' : 'description') : e._lastField;
    if (!field) { field = 'description'; warnings.push(`p.${printed} ${e.name}: unlabeled prose block assigned to description`); }
    e[field].push(blines.map(l => clean(l.text)).join('\n'));
    e._lastField = field;
  }
  // ---- table rows
  if (e.tableCols) {
    const { negX, posX, protX } = e.tableCols;
    const cell = l => { const c = (l.x0 + l.x1) / 2; const d = [['neg', Math.abs(c - negX)], ['pos', Math.abs(c - posX)], ['prot', Math.abs(c - protX)]]; return d.sort((a, b) => a[1] - b[1])[0][0]; };
    const tl = lines.filter(l => !used.has(l) && l.y0 >= tableY).sort((a, b) => a.y0 - b.y0);
    tl.forEach(l => used.add(l));
    for (const l of tl.filter(l => cell(l) === 'prot')) e.protocols.push(clean(l.text));
    const col = { neg: tl.filter(l => cell(l) === 'neg'), pos: tl.filter(l => cell(l) === 'pos') };
    const yc = l => (l.y0 + l.y1) / 2;
    const rows = [];
    const paired = new Set();
    // 1) lines at the same height in both columns form a row
    for (const n of col.neg) {
      const p = col.pos.find(p => !paired.has(p) && Math.abs(yc(p) - yc(n)) < 2.5);
      if (p) { rows.push({ y: yc(n), neg: [n], pos: [p] }); paired.add(n); paired.add(p); }
    }
    // 2) remaining lines form multi-line cells (runs within one pdf block, uninterrupted by paired lines),
    //    matched across columns by vertical centre (cells are vertically centred in their row)
    const runs = side => {
      const out = [];
      for (const l of col[side]) {
        if (paired.has(l)) { out.push(null); continue; }
        const r = out[out.length - 1];
        if (r && r.block === l.block && l.y0 - r.lines[r.lines.length - 1].y1 < 8) r.lines.push(l);
        else out.push({ block: l.block, lines: [l] });
      }
      return out.filter(Boolean).map(r => ({ ...r, yc: (r.lines[0].y0 + r.lines[r.lines.length - 1].y1) / 2 }));
    };
    const rn = runs('neg'), rp = runs('pos');
    for (const a of rn) {
      const b = rp.find(b => !b.used && Math.abs(b.yc - a.yc) < 3.5);
      if (b) { b.used = true; rows.push({ y: a.yc, neg: a.lines, pos: b.lines }); }
      else a.orphan = true;
    }
    for (const r of [...rn.filter(r => r.orphan).map(r => ({ y: r.yc, neg: r.lines, pos: [] })), ...rp.filter(r => !r.used).map(r => ({ y: r.yc, neg: [], pos: r.lines }))]) {
      warnings.push(`p.${printed} ${e.name}: unmatched pole cell neg="${r.neg.map(l => clean(l.text)).join(' ')}" pos="${r.pos.map(l => clean(l.text)).join(' ')}"`);
    }
    rows.sort((a, b) => a.y - b.y);
    const txt = ls => clean(ls.map(l => clean(l.text)).join(' '));
    for (const r of rows) {
      const neg = txt(r.neg), pos = txt(r.pos);
      const prev = e.poles[e.poles.length - 1];
      // both cells continuing a wrapped previous row (e.g. "Rodilla - Ligamento" / "externo")
      if (prev && prev.page === printed && /^[a-záéíóúñ(]/.test(neg) && /^[a-záéíóúñ(]/.test(pos) && r.neg.length === 1 && r.pos.length === 1) {
        prev.neg += ' ' + neg; prev.pos += ' ' + pos;
        warnings.push(`p.${printed} ${e.name}: merged wrapped pole row "${neg}" / "${pos}"`);
        continue;
      }
      e.poles.push({ neg, pos, page: printed });
    }
  }
  for (const l of lines) if (!used.has(l)) warnings.push(`p.${printed} ${e.name}: unused line "${clean(l.text)}"`);
}
