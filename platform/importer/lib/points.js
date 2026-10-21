// Point-name normalization: canonical point + side + qualifiers + notes.
import { slug, slugKeep } from './slug.js';
import { POINTS } from './point-aliases.js';
import { clean } from './layout.js';

export const pointTable = new Map();   // id -> { id, es, en, laterality, aliases:Set }
const aliasIndex = new Map();          // key -> id

export function addAlias(id, alias) {
  for (const k of [slugKeep(alias), slug(alias)]) if (k && !aliasIndex.has(k)) aliasIndex.set(k, id);
  pointTable.get(id)?.aliases.add(alias);
}
for (const [es, en, laterality, aliases] of POINTS) {
  const id = slug(es);
  if (pointTable.has(id)) throw new Error(`duplicate point id ${id}`);
  pointTable.set(id, { id, es, en, laterality, aliases: new Set([es]) });
}
// canonical names first so that they win over aliases of other points
for (const p of pointTable.values()) addAlias(p.id, p.es);
for (const [es, , , aliases] of POINTS) for (const a of aliases) addAlias(slug(es), a);

export const lookupPoint = name => aliasIndex.get(slugKeep(name)) ?? aliasIndex.get(slug(name)) ?? null;

const SIDE_MAP = { d: 'R', i: 'L', c: 'C', 'd/i': 'RL', 'i/d': 'RL', 'd / i': 'RL' };
const QUAL_MAP = { s: 'S', sup: 'S', inf: 'INF', 'inf.': 'INF', a: 'A', ant: 'A', p: 'P', post: 'P', lat: 'LAT' };
const ORDINALS = /^(primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|quinta|quinto|sexta|sexto|s[eé]ptima|s[eé]ptimo|octava|novena|d[eé]cima|doceava)$/i;

// Parse a raw point reference such as "Riñón (D/I)", "Riñón izquierdo (mismo lado)",
// "Hígado - Suprahepático", "Mandíbula (C/D/I)", "Pleura (Ipsilateral)".
export function parsePointRef(raw) {
  let s = clean(raw).replace(/\s+\(/g, ' (').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  const r = { raw: clean(raw), side: null, qualifiers: [], notes: [], name: null, point: null, altPoint: null };
  const setSide = v => { if (!r.side || (r.side === 'RL' || r.side === 'C') && v !== 'RL') r.side = v; };
  const note = n => { if (!r.notes.includes(n)) r.notes.push(n); };
  // parenthesised markers
  s = s.replace(/\(([^()]*)\)/g, (m, inner) => {
    const k = inner.trim().toLowerCase().replace(/\s+/g, ' ');
    if (SIDE_MAP[k]) { setSide(SIDE_MAP[k]); return ' '; }
    if (QUAL_MAP[k]) { if (!r.qualifiers.includes(QUAL_MAP[k])) r.qualifiers.push(QUAL_MAP[k]); return ' '; }
    if (k === 'c/d/i' || k === 'c/ d/i' || k === 'd/i/c') { setSide('C'); note('C/D/I: central, derecho o izquierdo'); return ' '; }
    if (k === 'contralateral' || k === 'lado contrario') { setSide('RL'); note('contralateral'); return ' '; }
    if (k === 'ipsilateral' || k === 'mismo lado') { setSide('RL'); note('mismo lado (ipsilateral)'); return ' '; }
    if (k === 'cualquiera') { setSide('RL'); note('cualquiera'); return ' '; }
    if (k === 'lado derecho' || k === 'derecho' || k === 'derecha') { setSide('R'); return ' '; }
    if (k === 'lado izquierdo' || k === 'izquierdo' || k === 'izquierda') { setSide('L'); return ' '; }
    if (k === 'bilateral') { setSide('RL'); note('bilateral'); return ' '; }
    if (k === '3/4') { note('L3/L4'); return ' '; }
    if (/^lado pie acortado$/.test(k)) { note('lado del pie acortado'); return ' '; }
    if (/^lado pie más largo$/.test(k)) { note('lado del pie más largo'); return ' '; }
    if (/^(norte de eu y canadá)$/.test(k)) { note(inner.trim()); return ' '; }
    if (/^(zona de conflicto|carina)$/.test(k)) { note(inner.trim()); return ' '; }
    return m; // keep (e.g. "(Nervio)", "(Arteria)", "(axila-brazo)")
  });
  // trailing side words
  const words = [
    [/\s+del mismo lado\b/i, () => { setSide('RL'); note('mismo lado (ipsilateral)'); }],
    [/\s+mismo lado\b/i, () => { setSide('RL'); note('mismo lado (ipsilateral)'); }],
    [/\s+del lado contrario\b/i, () => { setSide('RL'); note('contralateral'); }],
    [/\s+contralateral\b/i, () => { setSide('RL'); note('contralateral'); }],
    [/\s+ipsilateral\b/i, () => { setSide('RL'); note('mismo lado (ipsilateral)'); }],
    [/\s+izq\/der\b/i, () => setSide('RL')],
    [/\s+(derecho|derecha)\b/i, () => setSide('R')],
    [/\s+(izquierdo|izquierda)\b/i, () => setSide('L')],
    [/\s+D\/I$/, () => setSide('RL')],
  ];
  for (const [re, fn] of words) if (re.test(s)) { s = s.replace(re, ' '); fn(); }
  s = clean(s.replace(/\(\s*\)/g, ''));
  r.name = s;
  resolve(r, s);
  if (!r.side) r.side = 'C';
  return r;
}

function resolve(r, s) {
  let id = lookupPoint(s);
  if (id) { r.point = id; return; }
  // "Ovario/Testículo", "Próstata/Útero": first alternative is the point, second is an alternate
  if (/\//.test(s) && !/ - /.test(s)) {
    const [a, b] = s.split('/').map(x => x.trim());
    const ia = lookupPoint(a), ib = lookupPoint(b);
    if (ia && ib) { r.point = ia; r.altPoint = ib; r.notes.push(`${a} / ${b}`); return; }
  }
  // hierarchical compendium names "Organ - Part"
  const m = s.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) {
    const [, a, b] = m;
    const tries = [b, /\s(de|del)$/i.test(b) ? `${b} ${a}` : null, ORDINALS.test(b) ? a : null].filter(Boolean);
    for (const t of tries) if ((id = lookupPoint(t))) { r.point = id; return; }
    // qualifiers expressed as words ("Riñón - Superior", "Riñón - Inferior")
    const q = b.toLowerCase();
    if ((id = lookupPoint(a)) && /^(superior|inferior|anterior|posterior|lateral)$/.test(q)) {
      r.point = id; r.qualifiers.push({ superior: 'S', inferior: 'INF', anterior: 'A', posterior: 'P', lateral: 'LAT' }[q]); return;
    }
  }
  // trailing "inferior"/"superior"/"medio" as qualifier ("Tibia inferior")
  const q = s.match(/^(.+?)\s+(inferior|superior)$/i);
  if (q && (id = lookupPoint(q[1]))) { r.point = id; r.qualifiers.push(q[2].toLowerCase() === 'inferior' ? 'INF' : 'S'); return; }
  r.point = null; // unresolved -> caller decides (new point + report)
}
