// Back-matter parsers for the Goiz guides: protocol lists (basic / Top 10 / Top 5), disease protocols,
// symptom vocabulary lists, general recommendations, contraindications, abbreviations, intake form.
import { rows, isBoiler, clean, joinWrapped } from './layout.js';

const open = t => (t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length;

// Rows of one page split in two columns (left column first). Each row = merged same-baseline lines.
export function pageColumnRows(page, pageOffset, frac = 0.48) {
  const thr = page.width * frac;
  const content = page.lines.filter(l => !isBoiler(l.text));
  const out = [];
  for (const [ci, col] of [content.filter(l => l.x0 < thr), content.filter(l => l.x0 >= thr)].entries())
    for (const r of rows(col)) out.push({ text: clean(r.cells.map(c => c.text).join(' ')), x: r.x0, y: r.yc, col: ci, page: page.pdfPage + pageOffset });
  return out;
}
export const rangeRows = (pages, from, to, off, frac) => pages.slice(from - 1, to).flatMap(p => pageColumnRows(p, off, frac));
export const rangeRowsSingle = (pages, from, to, off) => pages.slice(from - 1, to).flatMap(p =>
  rows(p.lines.filter(l => !isBoiler(l.text))).map(r => ({ text: clean(r.text), x: r.x0, y: r.yc, page: p.pdfPage + off })));

// ------------------------------------------------------------ Top lists ----
const LIST_TITLE = /^(Top\s+(10|5|Top\s+10)\b.*|.*\bBásico\b.*|Protocolo Básico.*)$/;
export function parseNumberedLists(rowsIn, { doc }) {
  const lists = [];
  let cur = null, item = null, titleOpen = false;
  for (const r of rowsIn) {
    const t = r.text;
    if (/^(PROTOCOLOS BÁSICOS|Los protocolos básicos)/.test(t)) continue;
    let m;
    if (titleOpen && cur) { cur.title = joinWrapped(cur.title, t); titleOpen = open(cur.title) || /-$/.test(cur.title); continue; }
    if (!/^\d+\./.test(t) && LIST_TITLE.test(t) && t.length < 70) {
      cur = { title: t, items: [], page: r.page, doc };
      lists.push(cur); item = null; titleOpen = open(t) || /-$/.test(t);
      continue;
    }
    if (!cur) continue;
    if ((m = t.match(/^(\d+)\.\s*(.*)$/))) { item = { n: +m[1], text: m[2], page: r.page }; cur.items.push(item); continue; }
    if (item && r.x > 0) { item.text = joinWrapped(item.text, t); continue; }
  }
  return lists;
}

// ---------------------------------------------------- disease protocols ----
export function parseDiseaseProtocols(rowsIn, { doc }) {
  const out = [];
  let cur = null, last = null;
  for (const r of rowsIn) {
    const t = r.text;
    if (/^(Protocolos de Par Biomagnético por Enfermedad|Los protocolos de Par|tar la práctica|como guías|cuidado con el imán|caso de ser necesario|no son más importantes)/.test(t)) continue;
    let m;
    if ((m = t.match(/^(\d{1,3})\.\s+(.+)$/))) {
      cur = { n: +m[1], name: m[2], items: [], page: r.page, doc, nameOpen: /-$/.test(m[2]) || open(m[2]) };
      out.push(cur); last = null;
      continue;
    }
    if (!cur) continue;
    if (cur.nameOpen || (!cur.items.length && /^[a-záéíóúñ(]/.test(t))) { cur.name = joinWrapped(cur.name, t); cur.nameOpen = /-$/.test(cur.name) || open(cur.name); continue; }
    const cont = last && (/[-–,]$/.test(last.text) || open(last.text) || /^[a-záéíóúñ(]/.test(t));
    if (cont) { last.text = joinWrapped(last.text, t); continue; }
    last = { text: t, page: r.page };
    cur.items.push(last);
  }
  for (const d of out) delete d.nameOpen;
  return out;
}

// -------------------------------------------- symptom vocabulary (L1 p.113–118) ----
export function parseSymptomLists(rowsIn) {
  const groups = [];
  let cur = null, item = null;
  for (const r of rowsIn) {
    const t = r.text;
    let m;
    if ((m = t.match(/^Síntomas\s+(.+)$/)) && !/^•/.test(t)) { cur = { header: m[1], items: [], page: r.page }; groups.push(cur); item = null; continue; }
    if (!cur) continue;
    if ((m = t.match(/^•\s*(.+)$/))) { item = { text: m[1], page: r.page }; cur.items.push(item); continue; }
    if (item) item.text = joinWrapped(item.text, t);
  }
  return groups;
}

// ----------------------------------------------- general recommendations ----
export function parseRecommendationSections(rowsIn, titles) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tset = titles.map(t => [norm(t), t]);
  const out = [];
  let cur = null, item = null;
  for (const r of rowsIn) {
    const t = r.text;
    const hit = !/^[-•]/.test(t) && tset.find(([n]) => norm(t) === n);
    if (hit) { cur = { title: hit[1], intro: [], items: [], page: r.page }; out.push(cur); item = null; continue; }
    if (!cur) continue;
    let m;
    if ((m = t.match(/^(\d+)\.\s+(.+)$/))) { item = { n: +m[1], text: m[2] }; cur.items.push(item); continue; }
    const target = cur.items.length ? (cur.outro ||= []) : cur.intro;
    if ((m = t.match(/^[•-]\s*(.+)$/))) { target.push('• ' + m[1]); item = null; continue; }
    if (item && !cur.outro && (r.x > 90 || /^[a-záéíóúñ(]/.test(t) || /-$/.test(item.text))) { item.text = joinWrapped(item.text, t); continue; }
    item = null;
    const last = target[target.length - 1];
    if (last && !last.startsWith('• ') && !/[.:]$/.test(last)) target[target.length - 1] = joinWrapped(last, t);
    else if (last && last.startsWith('• ') && /^[a-záéíóúñ(]/.test(t)) target[target.length - 1] = joinWrapped(last, t);
    else target.push(t);
  }
  return out;
}

// ---------------------------------------------------- contraindications ----
export function parseContraindications(pages, from, to, off) {
  const lists = { relative: [], absolute: [] };
  let kind = null, done = false;
  const cur = [null, null];
  for (const page of pages.slice(from - 1, to)) {
    const thr = page.width * 0.48;
    for (const r of rows(page.lines.filter(l => !isBoiler(l.text)))) {
      const full = clean(r.text);
      if (/^Contraindicaciones Relativas$/.test(full)) { kind = 'relative'; cur[0] = cur[1] = null; continue; }
      if (/^Contraindicaciones Absolutas$/.test(full)) { kind = 'absolute'; cur[0] = cur[1] = null; continue; }
      if (!kind || done) continue;
      if (/^(Es una responsabilidad|Hoja de Registro)/.test(full)) { done = true; continue; }
      const cells = [r.cells.filter(c => c.x0 < thr), r.cells.filter(c => c.x0 >= thr)].map(cs => clean(cs.map(c => c.text).join(' ')));
      cells.forEach((t, ci) => {
        if (!t) return;
        const m = t.match(/^(\d+)\.\s+(.+)$/);
        if (m) { cur[ci] = { n: +m[1], text: m[2], page: page.pdfPage + off }; lists[kind].push(cur[ci]); return; }
        const it = cur[ci];
        if (it && (open(it.text) || /[-,]$/.test(it.text) || /^[a-záéíóúñ(]/.test(t))) it.text = joinWrapped(it.text, t);
        else cur[ci] = null; // prose: closes the item
      });
    }
  }
  for (const k of Object.keys(lists)) lists[k].sort((a, b) => a.n - b.n);
  return lists;
}

// --------------------------------------------------------- abbreviations ----
export function parseAbbreviations(page) {
  const lines = page.lines.filter(l => !isBoiler(l.text));
  const head = lines.find(l => /Referencia de Siglas y Abreviaturas/.test(l.text));
  if (!head) return [];
  const body = lines.filter(l => l.y0 > head.y1);
  // 4 x-columns: abbr | meaning | abbr | meaning
  const xs = [...new Set(body.map(l => Math.round(l.x0)))].sort((a, b) => a - b);
  const clusters = [];
  for (const x of xs) { const c = clusters.find(c => Math.abs(c.x - x) < 12); if (c) c.n++; else clusters.push({ x, n: 1 }); }
  const cols = clusters.filter(c => body.filter(l => Math.abs(Math.round(l.x0) - c.x) < 12).length >= 3).map(c => c.x).sort((a, b) => a - b).slice(0, 4);
  const colOf = l => cols.reduce((best, x, i) => Math.abs(l.x0 - x) < Math.abs(l.x0 - cols[best]) ? i : best, 0);
  const out = [];
  for (const side of [0, 2]) {
    const abbr = body.filter(l => colOf(l) === side).sort((a, b) => a.y0 - b.y0);
    const mean = body.filter(l => colOf(l) === side + 1).sort((a, b) => a.y0 - b.y0);
    const entries = abbr.map(a => ({ abbr: clean(a.text), y: a.y0, meaning: '' }));
    for (const m of mean) {
      const e = entries.find(e => Math.abs(e.y - m.y0) < 3);
      if (e) e.meaning = e.meaning ? joinWrapped(e.meaning, m.text) : clean(m.text);
      else { const prev = [...entries].reverse().find(e => e.y < m.y0); if (prev) prev.meaning = joinWrapped(prev.meaning, m.text); }
    }
    out.push(...entries);
  }
  return out.map(({ abbr, meaning }) => ({ abbr, meaning: clean(meaning) }));
}

// ------------------------------------------------------------ intake form ----
export function parseIntakeForm(pages, from, to, off) {
  const seq = rangeRowsSingle(pages, from, to, off);
  const startIdx = seq.findIndex(r => /^Hoja de Registro$/.test(r.text));
  const s = seq.slice(startIdx);
  const endIdx = s.findIndex(r => /^Bibliografía$/.test(r.text));
  const rowsF = endIdx > 0 ? s.slice(0, endIdx) : s;
  const intro = [], recordSpec = [], questions = [], fields = [], consent = [], legal = [], what = [];
  let mode = 'intro', block = null;
  for (const r of rowsF.slice(1)) {
    const t = r.text;
    let m;
    if (/^Hoja de Registro$/.test(t)) { mode = 'form'; continue; }
    if (mode === 'intro') {
      if ((m = t.match(/^(\d+)\.\s+(.+)$/))) { recordSpec.push(m[2]); continue; }
      if (recordSpec.length) { recordSpec[recordSpec.length - 1] = joinWrapped(recordSpec[recordSpec.length - 1], t); continue; }
      intro.push(t); continue;
    }
    // form page
    for (const f of t.matchAll(/(?:^|\s)([A-ZÁÉÍÓÚ][a-záéíóúñ]+|e-mail):/g)) fields.push(f[1]);
    if (/^AUTORIZACIÓN/.test(t)) { block = 'consent'; continue; }
    if (/^¿Qué es el Par Biomagnético\?$/.test(t)) { block = 'what'; continue; }
    if (/^¿/.test(t)) { questions.push(t); block = null; continue; }
    if (/^Escriba sus síntomas/.test(t)) { questions.push(t); continue; }
    if (/^El cliente está consciente/.test(t)) { block = 'legal'; }
    if (/^Fecha\s+Punto de rastreo/.test(t)) { block = 'table'; fields.push(...t.split(/\s{2,}|\s(?=Punto|Fenómenos)/)); continue; }
    if (block === 'consent' && !/^(Nombre|Dirección|Ocupación):/.test(t)) consent.push(t);
    if (block === 'what') what.push(t);
    if (block === 'legal' && !/^Nombre y firma/.test(t)) legal.push(t.replace(/\s+Nombre y firma del cliente$/, ''));
  }
  const j = a => a.reduce((acc, t) => acc ? joinWrapped(acc, t) : t, '');
  return { intro: j(intro), recordSpec, questions, fields: [...new Set(fields)], consent: j(consent), explanation: j(what), legal: j(legal) };
}
