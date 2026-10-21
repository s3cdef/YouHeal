// Assembles the catalog (CONTRACT §4) from the three parsed sources.
import { slug, slugKeep } from './slug.js';
import { clean, joinWrapped } from './layout.js';
import * as G from './goiz.js';
import * as BM from './backmatter.js';
import { parseLeal, TYPE_CODES, CLASS_CODES, CLASS_CODE_NAMES } from './leal.js';
import { parsePointRef, pointTable, lookupPoint } from './points.js';
import * as T from './i18n.js';
import { SYMPTOM_ALIASES, SYMPTOM_NAMES } from './symptom-aliases.js';

const REGULAR = new Set(['virus', 'bacteria', 'fungus', 'parasite']);
const SECTION_CATEGORY = { 'Virus': 'virus', 'Bacterias': 'bacteria', 'Hongos': 'fungus', 'Parásitos': 'parasite', 'Especiales': null };
const SYSTEM_WORDS = [
  [/^generales?$/i, 'general'], [/^respiratori[oa]s?$/i, 'respiratory'], [/^gastrointestinal(es)?$/i, 'gastrointestinal'],
  [/^neurol[oó]gic[oa]s?$/i, 'neurological'], [/^osteomuscular(es)?$/i, 'musculoskeletal'], [/^urol[oó]gic[oa]s?$/i, 'urological'],
  [/^cardiol[oó]gic[oa]s?$/i, 'cardiological'], [/^ginecol[oó]gic[oa]s?$/i, 'gynecological'], [/^endocrinol[oó]gic[oa]s?$/i, 'endocrine'],
  [/^hematol[oó]gic[oa]s?$/i, 'hematological'], [/^dermatol[oó]gic[oa]s?$/i, 'dermatological'], [/^oftalmol[oó]gic[oa]s?$/i, 'ophthalmological'],
  [/^auditiv[oa]s?$/i, 'auditory'], [/^inmunol[oó]gic[oa]s?$/i, 'immunological'], [/^psiqui[aá]tric[oa]s?$/i, 'psychiatric'],
  [/^oncol[oó]gic[oa]s?$/i, 'oncological'], [/^odontol[oó]gic[oa]s?$/i, 'dental'], [/^tropical(es)?$/i, 'tropical'],
  [/^toxicol[oó]gic[oa]s?$/i, 'toxicological'], [/^por intoxicaci[oó]n$/i, 'toxicological'],
];
export const systemOf = word => (SYSTEM_WORDS.find(([re]) => re.test(word.trim())) || [])[1] || null;

const src = (doc, page) => ({ doc, page });
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const uniq = a => [...new Set(a)];
const L = (es, en) => (en ? { es, en } : { es });

export function build({ pdf, overrides, sourcesMeta }) {
  const report = { warnings: [], unresolved: [], overridesApplied: [], spot: [], indexMismatches: [], categoryMethod: {} };
  const warn = m => report.warnings.push(m);
  const usedOverride = m => report.overridesApplied.push(m);
  const pointUse = new Map(); // id -> Set(sides)
  // Records that a point is used; `lateralEvidence` = the Goiz guides mark it with (D)/(I)/(D/I), which makes the point bilateral.
  // (Compendium side words such as "Duodeno (lado derecho)" locate a magnet on a central organ and do not change laterality.)
  const notePoint = (ref, lateralEvidence = false) => {
    for (const id of [ref.point, ref.altPoint].filter(Boolean)) {
      if (!pointUse.has(id)) pointUse.set(id, new Set());
      if (lateralEvidence && /\((D|I|D\/I|I\/D)\)|\bD\/I\b/.test(ref.raw || '')) pointUse.get(id).add('lateral');
    }
  };
  const newPoints = new Map(); // unresolved names that became points
  const resolveRef = (raw, ctx) => {
    const ov = overrides.pointRefs?.[clean(raw)];
    let r = parsePointRef(ov?.as ?? raw);
    if (ov) { if (ov.side) r.side = ov.side; if (ov.notes) r.notes.push(...ov.notes); usedOverride(`pointRefs["${clean(raw)}"] (${ctx})`); }
    if (!r.point) {
      const id = slug(r.name);
      if (!pointTable.has(id)) pointTable.set(id, { id, es: r.name, en: null, laterality: 'central', aliases: new Set([r.name]) });
      newPoints.set(id, (newPoints.get(id) || []).concat(ctx));
      r.point = id;
    }
    return r;
  };
  const endpoint = r => ({ point: r.point, side: r.side, qualifiers: uniq(r.qualifiers) , ...(r.altPoint ? { altPoint: r.altPoint } : {}) });

  // ======================================================== Goiz guides ====
  const LEVELS = [
    { doc: 'goiz-n1', level: 1, pages: pdf['goiz-n1'], off: 0, index: [5, 10], body: [25, 95], lists: [105, 112], symptomLists: [113, 118], recs: [96, 104], contra: [130, 132] },
    { doc: 'goiz-n2', level: 2, pages: pdf['goiz-n2'], off: 140, index: [5, 8], body: [25, 63], lists: [73, 75], diabetes: [76, 76], disease: [78, 96], diseaseIndex: [9, 13], contra: [106, 108], intake: [108, 110], psychoList: [104, 104], reservoirList: [105, 105], recs: [64, 72] },
  ];
  const pairs = new Map();       // id -> pair
  const relationRefs = [];       // {pairId, name, ordinal}
  const indexByNum = new Map();
  for (const lv of LEVELS) {
    const idx = G.parseIndex(lv.pages, { from: lv.index[0], to: lv.index[1], pageOffset: lv.off, doc: lv.doc });
    for (const e of idx) indexByNum.set(e.n, e);
    const { blocks, warnings } = G.parsePairBlocks(lv.pages, { from: lv.body[0], to: lv.body[1], pageOffset: lv.off, doc: lv.doc, expected: new Set(idx.map(e => e.n)) });
    warnings.forEach(warn);
    for (const b of blocks) {
      const fix = (overrides.blockFixes || []).find(f => f.doc === lv.doc && f.page === b.page && f.titleNumber === b.n && (!f.relation || clean(G.interpretBlock(b).relationText || '') === f.relation));
      if (fix) { usedOverride(`blockFixes: ${lv.doc} p.${b.page} title "${b.n}." -> pair ${fix.number} (${fix.reason})`); b.n = fix.number; if (fix.title) { b.title = fix.title; b.titleExtra = []; } }
      const ix = indexByNum.get(b.n);
      const x = G.interpretBlock(b);
      const ov = overrides.pairs?.[String(b.n)] || {};
      // ---- title
      let title = b.title, alt = [];
      const extras = [...b.titleExtra];
      if (extras.length && (!/\s[–-]\s/.test(title) || /[–-]$/.test(title))) title = `${title.replace(/\s*[–-]$/, '')} – ${extras.shift()}`;
      alt = extras.filter(e => /\s[–-]\s/.test(e));
      if (ov.title) { title = ov.title; usedOverride(`pairs.${b.n}.title ("${b.title}" -> "${ov.title}")`); }
      title = title.replace(/\s+-\s+/g, ' – ');
      const { parts } = G.splitPairTitle(title);
      // ---- relation
      let relationText = clean(x.relationText || '').replace(/^(Relación\s+)+/i, '');
      if (/^\d{1,3}\.\s/.test(relationText) && ix) { warn(`pb-${b.n}: "Relación" line repeats the pair title ("${relationText}"); using index relation "${G.splitPairTitle(ix.text).relation}"`); relationText = G.splitPairTitle(ix.text).relation; }
      if (ov.relation) { relationText = ov.relation; usedOverride(`pairs.${b.n}.relation ("${clean(x.relationText || '')}" -> "${ov.relation}")`); }
      if (relationText.length < 3 && ix) { warn(`pb-${b.n}: relation "${relationText}" unusable, using index relation "${G.splitPairTitle(ix.text).relation}"`); relationText = G.splitPairTitle(ix.text).relation; }
      const id = `pb-${String(b.n).padStart(3, '0')}`;
      if (pairs.has(id)) { warn(`duplicate pair block ${id} (${lv.doc} p.${b.page})`); continue; }
      const tr = resolveRef(parts[0], id), im = resolveRef(parts[parts.length - 1], id);
      const notes = [];
      for (const [role, r] of [['tracking', tr], ['impact', im]]) for (const n of r.notes) notes.push(L(`${role === 'tracking' ? 'Punto de rastreo' : 'Punto de impacto'} (${r.raw}): ${n}`));
      const pair = {
        _mods: [tr.notes.join(' '), im.notes.join(' ')],
        id, number: b.n, level: lv.level,
        name: { es: title, en: null },
        tracking: endpoint(tr), impact: endpoint(im),
        category: null,
        relations: [],
        ratings: {},
        symptoms: [], recommendations: [], notes,
        source: src(lv.doc, b.page),
      };
      if (alt.length) pair.altNames = alt.map(a => L(a));
      if (ix) {
        const ixParts = G.splitPairTitle(ix.text).parts.map(p => parsePointRef(p).point);
        const tParts = parts.map(p => parsePointRef(p).point);
        if (ixParts.join('|') !== tParts.join('|')) {
          report.indexMismatches.push(`${id}: block title "${title}" vs index "${ix.text}" (p.${ix.page})`);
          pair.altNames = [...(pair.altNames || []), L(G.splitPairTitle(ix.text).parts.join(' – '))];
          notes.push(L(`El índice de la guía nombra este par "${G.splitPairTitle(ix.text).parts.join(' – ')}".`));
        }
        pair._section = ix.section; pair._indexRelation = G.splitPairTitle(ix.text).relation;
      }
      if (parts.length > 2) pair._multi = parts;
      for (const k of ['F', 'P', 'R']) if (x.ratings[k]) pair.ratings[k] = Math.min(3, x.ratings[k]);
      pair._relationText = relationText;
      pair._symLines = x.symptomLines; pair._recLines = x.recLines.length ? x.recLines : x.other.filter(o => o.mode === 'rel');
      for (const r of [tr, im]) notePoint(r, true);
      for (const role of ['tracking', 'impact']) if (ov[role]) { Object.assign(pair[role], ov[role]); usedOverride(`pairs.${b.n}.${role} ${JSON.stringify(ov[role])}`); }
      if (ov.magnets) { pair.magnets = ov.magnets.map(m => ({ ...m })); usedOverride(`pairs.${b.n}.magnets`); for (const m of ov.magnets) notePoint({ point: m.point, side: m.side || 'C' }); }
      if (ov.notes) { pair.notes.push(...ov.notes.map(n => L(n))); }
      pairs.set(id, pair);
    }
  }

  // ---- relation parsing -> relation refs
  const numberedName = n => (overrides.typeNumberedEntities || []).some(p => slug(n) === slug(p));
  for (const p of pairs.values()) {
    const parts = p._relationText.split(/\s+–\s+|\s+o\s+(?=[A-Z])/).map(s => clean(s)).filter(Boolean);
    for (let raw of parts) {
      raw = raw.replace(/\s*\((virus)\)\s*/i, ' ').trim();
      let name = raw, ordinal = null, m;
      if ((m = raw.match(/^(.*?)\s*\((\d+)\)$/)) || (m = raw.match(/^(.*?\D)\s+(\d+)$/))) {
        if (numberedName(m[1])) name = `${m[1]} ${m[2]}`; else { name = m[1]; ordinal = +m[2]; }
      }
      name = clean(name);
      relationRefs.push({ pairId: p.id, name, ordinal });
    }
  }

  // ======================================================== Leal ==========
  const leal = parseLeal(pdf['leal-2018']);
  leal.warnings.forEach(w => warn(`leal: ${w}`));

  // ======================================================== Entities ======
  const entities = new Map();
  const entityAlias = new Map(Object.entries(overrides.entityAliases || {}).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [slug(k), v]));
  // Leal entry ids: slug(name); entries whose names only differ by a parenthetical (e.g. "Rabia" vs
  // "Rabia (Reservorio)") keep the parenthetical in the id (slugKeep) so that they stay distinct.
  const lealSlugCount = new Map();
  for (const e of leal.entries) lealSlugCount.set(slug(e.name), (lealSlugCount.get(slug(e.name)) || 0) + 1);
  const lealIdFor = name => ((lealSlugCount.get(slug(name)) > 1 && /\(/.test(name)) || /\(Reservorio\)/i.test(name) ? slugKeep(name) : slug(name));
  const entityIdFor = name => { const s = slug(name); return entityAlias.get(s) || entityAlias.get(slugKeep(name)) || s; };
  const ensureEntity = (id, init) => { if (!entities.has(id)) entities.set(id, { id, ...init, polePairs: [], protocols: [] }); return entities.get(id); };

  for (const e of leal.entries) {
    const id = entityAlias.get(slugKeep(e.name)) || lealIdFor(e.name);
    const classification = CLASS_CODES[e.cls] || null;
    if (!classification) warn(`leal: unknown classification code ${e.cls} for ${e.name}`);
    const prev = entities.get(id);
    if (prev && prev.source.doc === 'leal-2018') {
      warn(`leal: two entries map to entity id ${id} ("${prev.name.es}" p.${prev.source.page} and "${e.name}" p.${e.page}); merged`);
    }
    const ent = ensureEntity(id, { name: { es: e.name }, kind: TYPE_CODES[e.type], classification, source: src('leal-2018', e.page) });
    if (e.contagion.length) ent.contagion = { es: e.contagion.reduce((a, t) => (a ? joinWrapped(a, t.replace(/\n/g, ' ')) : t.replace(/\n/g, ' ')), '') };
    if (e.description.length) ent.description = { es: e.description.reduce((a, t) => (a ? joinWrapped(a, t.replace(/\n/g, ' ')) : t.replace(/\n/g, ' ')), '').replace(/(\p{L})- (\p{Ll})/gu, '$1$2') };
    ent.typeCode = `${e.type}-${e.cls}`;
    ent._leal = e;
  }
  // Goiz relation entities
  for (const r of relationRefs) {
    const id = entityIdFor(r.name);
    const p = pairs.get(r.pairId);
    let ent = entities.get(id);
    if (!ent) ent = ensureEntity(id, { name: { es: r.name }, kind: null, classification: null, source: p.source });
    else if (ent.source.doc === 'leal-2018' && !ent.alsoIn) ent.alsoIn = [];
    if (ent.alsoIn && !ent.alsoIn.some(s => s.doc === p.source.doc && s.page === p.source.page)) ent.alsoIn.push(p.source);
    if (slug(ent.name.es) !== slug(r.name)) (ent.aliases ||= []).includes(r.name) || ent.aliases.push(r.name);
    p.relations.push({ entity: id, ...(r.ordinal != null ? { ordinal: r.ordinal } : {}) });
  }

  for (const [k, v] of entityAlias) if (!entities.has(v)) warn(`entityAliases: target "${v}" (for "${k}") is not a compendium entity`);
  // ======================================================== Categories ====
  // list rows with their page reference ("P.195" is a separate text line on the same baseline)
  const listRows = pg => { const ls = LEVELS[1].pages[pg - 1].lines; return ls.filter(l => /\s–\s/.test(l.text)).map(l => { const pr = ls.find(o => /^P\.\s*\d+$/.test(o.text.trim()) && Math.abs((o.y0 + o.y1) / 2 - (l.y0 + l.y1) / 2) < 6); return { text: clean(l.text) + (pr ? ' ' + pr.text.trim() : '') }; }); };
  const psychoRows = listRows(104).filter(r => /^\(/.test(r.text));
  const reservoirRows = listRows(105);
  const listMatch = (rowsIn) => {
    const ids = new Set();
    for (const r of rowsIn) {
      const m = r.text.match(/^(?:\((.*?)\)\s*)?(.+?)(?:\s+P\.\s*(\d+))?$/);
      if (!m) continue;
      const pts = m[2].split(/\s+–\s+/).map(x => parsePointRef(x).point);
      let cand = [...pairs.values()].filter(p => p.tracking.point === pts[0] && p.impact.point === pts[pts.length - 1]);
      if (cand.length > 1 && m[3]) cand = cand.filter(p => p.source.page === +m[3]);
      if (cand.length > 1 && m[1]) { const byRel = cand.filter(p => p.relations.some(x => x.entity === entityIdFor(m[1])) || slug(p._relationText).includes(slug(m[1])) || slug(p._indexRelation || '').includes(slug(m[1]))); if (byRel.length) cand = byRel; }
      if (cand.length === 1) ids.add(cand[0].id); else warn(`category list item "${r.text}" matched ${cand.length} pairs${cand.length ? ': ' + cand.map(c => c.id).join(', ') : ''}`);
    }
    return ids;
  };
  const psychoSet = listMatch(psychoRows), reservoirSet = listMatch(reservoirRows);
  for (const p of pairs.values()) {
    const ov = overrides.pairs?.[String(p.number)]?.category || overrides.categoryByPair?.[String(p.number)];
    if (ov) usedOverride(`category pb-${p.number} = ${ov}`);
    let cat = null, how;
    const relText = `${p._relationText} ${p._indexRelation || ''}`;
    if (ov) { cat = ov; how = 'override'; }
    else if (p.level === 1 && SECTION_CATEGORY[p._section]) { cat = SECTION_CATEGORY[p._section]; how = `index section "${p._section}"`; }
    else if (psychoSet.has(p.id)) { cat = 'psychoemotional'; how = 'L2 list "Pares Biomagnéticos Psicoemocionales" (p.244)'; }
    else if (reservoirSet.has(p.id)) { cat = 'reservoir'; how = 'L2 list "Pares Biomagnéticos Reservorios" (p.245)'; }
    else if (/disfunci[oó]n|deficiencia/i.test(relText)) { cat = 'dysfunctional'; how = 'relation names a dysfunction'; }
    else if (/reservorio/i.test(relText)) { cat = 'reservoir'; how = 'relation names a reservoir'; }
    else {
      const cls = p.relations.map(r => entities.get(r.entity)?.classification).find(c => c && c !== 'special');
      if (cls && (REGULAR.has(cls) || ['psychoemotional', 'reservoir', 'complex', 'prion'].includes(cls))) { cat = cls; how = 'classification of related compendium entity'; }
      else if (cls === 'glandular-dysfunction') { cat = 'dysfunctional'; how = 'classification of related compendium entity (DG)'; }
      else { cat = 'complex'; how = 'default for special pairs'; }
    }
    p.category = cat;
    report.categoryMethod[how] = (report.categoryMethod[how] || 0) + 1;
  }
  // Goiz-only entities: kind/classification from the pair
  for (const ent of entities.values()) {
    if (ent.kind) continue;
    const ps = [...pairs.values()].filter(p => p.relations.some(r => r.entity === ent.id));
    const cat = ps[0]?.category;
    ent.classification = cat === 'dysfunctional' ? 'glandular-dysfunction' : cat;
    ent.kind = REGULAR.has(cat) || cat === 'prion' ? 'pathogen' : 'condition';
  }

  // ======================================================== Symptoms per pair ====
  // Vocabulary seeded from the Level 1 "Listas de Síntomas" (p.113–118, with definitions), then extended with
  // every symptom term used by a pair. Spelling variants/typos are folded with lib/symptom-aliases.js.
  const vocab = new Map(); // id -> {id, system, name:{es}, definition?, pairs:Set, source}
  const symId = term => { const s0 = slug(term); return SYMPTOM_ALIASES[s0] || s0; };
  const isSystemWord = t => !!systemOf(t.replace(/^S[ií]ntomas\s+/i, '')) || /^renoureteral(es)?$/i.test(t);
  for (const lv of [LEVELS[0]]) {
    for (const g of BM.parseSymptomLists(BM.rangeRows(lv.pages, lv.symptomLists[0] + 1, lv.symptomLists[1], lv.off))) {
      const system = systemOf(g.header);
      for (const it of g.items) {
        const k = it.text.indexOf(' (');
        const term = clean(k > 0 ? it.text.slice(0, k) : it.text), def = k > 0 ? clean(it.text.slice(k + 2).replace(/\)$/, '')) : null;
        if (!term || isSystemWord(term) || /^S[ií]ntomas\s/i.test(term)) continue;
        const id = symId(term);
        if (!vocab.has(id)) vocab.set(id, { id, system, name: { es: term }, ...(def ? { definition: { es: def } } : {}), pairs: new Set(), source: src(lv.doc, it.page), systems: new Set([system]) });
        else vocab.get(id).systems.add(system);
      }
    }
  }
  const SYM_HEADER = /^(?:S[ií]ntomas\s+)?(Generales?|Respiratori[oa]s?|Gastrointestinal(?:es)?|Neurol[oó]gic[oa]s?|Osteomuscular(?:es)?|Urol[oó]gic[oa]s?|Cardiol[oó]gic[oa]s?|Ginecol[oó]gic[oa]s?|Endocrinol[oó]gic[oa]s?|Hematol[oó]gic[oa]s?|Dermatol[oó]gic[oa]s?|Oftalmol[oó]gic[oa]s?|Auditiv[oa]s?|Inmunol[oó]gic[oa]s?|Psiqui[aá]tric[oa]s?|Oncol[oó]gic[oa]s?|Odontol[oó]gic[oa]s?|Tropical(?:es)?|Toxicol[oó]gic[oa]s?|por [Ii]ntoxica?ci[oó]n|Renoureteral(?:es)?)\s*(?:\((.+)\))?:?$/;
  const splitSym = t => {
    const ov = overrides.symptomSplits?.[t];
    if (ov) { usedOverride(`symptomSplits["${t}"]`); return ov; }
    // "Cefalea, mareo y vómito", "Congestión nasal - Rinorrea", "Tos, Disnea": split when every part is a known term
    if (/\(/.test(t)) return [t];
    const parts = t.split(/\s*,\s*|\s+y\s+|\s+-\s+/).map(clean).filter(Boolean);
    if (parts.length > 1 && parts.every(x => vocab.has(symId(x)))) return parts.map(cap);
    return [t];
  };
  for (const p of pairs.values()) {
    const items = G.groupLines(p._symLines);
    let sys = null, parent = null;
    const push = (system, t, lookup = false) => { for (const x of splitSym(cap(t))) p.symptoms.push({ system: lookup ? (vocab.get(symId(clean(x.replace(/\s*\(.*\)$/, ''))))?.system || system) : system, text: { es: x } }); };
    items.forEach((it, i) => {
      const t = clean(it.text);
      const h = t.match(SYM_HEADER);
      const nextIsBullet = items[i + 1] && items[i + 1].bullet;
      if (h && !it.bullet) {
        const system = /^renoureteral/i.test(h[1]) ? 'urological' : systemOf(h[1]);
        parent = null;
        if (h[2] && isSystemWord(h[2])) { p.symptoms.push({ system, text: { es: cap(t) }, group: true }); sys = null; }
        else if (h[2]) { push(system, h[2]); sys = null; }
        else if (nextIsBullet) sys = system;
        else { p.symptoms.push({ system, text: { es: cap(t) }, group: true }); sys = null; }
        return;
      }
      if (it.bullet && sys) { push(sys, t); return; }
      if (it.bullet && parent) { parent.sub.push(t.toLowerCase().replace(/^(\p{Lu}{2,}.*)$/u, m => m)); return; }
      sys = null;
      const term = clean(t.replace(/\s*\(.*\)$/, ''));
      const v = vocab.get(symId(term));
      if (nextIsBullet) { parent = { system: v?.system || 'general', text: cap(t), sub: [] }; p.symptoms.push(parent); return; }
      parent = null;
      push(v?.system || 'general', t, true);
    });
    // fold "Parent" + "- sub" bullets into one item: "Multisistémico (neurológico, dermatológico, …)"
    p.symptoms = p.symptoms.map(x => x.sub ? { system: x.system, text: { es: x.sub.length ? `${x.text} (${x.sub.join(', ')})` : x.text } } : x);
    // link to vocabulary
    for (const s of p.symptoms) {
      const term = clean(s.text.es.replace(/\s*\(.*?\)\s*$/, ''));
      if (!term || term.split(' ').length > 6 || /\bPB\b/.test(term)) continue;
      if (s.group || /^S[ií]ntomas\s/i.test(term)) {
        const known = SYM_HEADER.test(term);
        const gid = known ? `sintomas-${s.system}` : symId(term);
        if (!vocab.has(gid)) vocab.set(gid, { id: gid, system: s.system, name: { es: known ? `Síntomas ${T.SYSTEM_ES[s.system] || s.system}` : cap(term) }, pairs: new Set(), source: p.source, systems: new Set([s.system]), group: true });
        vocab.get(gid).pairs.add(p.id); s.symptom = gid; delete s.group; continue;
      }
      const id = symId(term);
      if (!id) continue;
      if (!vocab.has(id)) vocab.set(id, { id, system: s.system, name: { es: SYMPTOM_NAMES[id] || term }, pairs: new Set(), source: p.source, systems: new Set([s.system]) });
      const v = vocab.get(id); v.pairs.add(p.id); v.systems.add(s.system); s.symptom = id;
    }
    for (const s of p.symptoms) delete s.group;
  }

  // ======================================================== Recommendations per pair ====
  const REC_SETS = [[/^Generales?$/i, 'general-full'], [/^Enf\.?\s*Tropicales$/i, 'tropical'], [/^Enf\.?\s*Parasitarias$/i, 'parasitic'], [/^(ITS|Enf\.?\s*de Transmisión Sexual|Infecciones de Transmisión Sexual)$/i, 'sti']];
  for (const p of pairs.values()) {
    const items = G.groupLines(p._recLines || []);
    let header = null;
    p.recommendationSets = [];
    for (const it of items) {
      const t = clean(it.text);
      const set = REC_SETS.find(([re]) => re.test(t));
      if (set && !it.bullet) { p.recommendationSets.push(set[1]); continue; }
      if (!it.bullet && /:$/.test(t)) { header = t; continue; }
      if (it.bullet && header) { p.recommendations.push({ es: `${header} ${t}` }); continue; }
      if (!it.bullet) header = null;
      p.recommendations.push({ es: t });
    }
    if (header && !p.recommendations.some(r => r.es.startsWith(header))) p.recommendations.push({ es: header.replace(/:$/, '') });
    p.recommendationSets = uniq(p.recommendationSets);
  }

  // ======================================================== Compendium pole pairs -> pairs ====
  const pairIndex = new Map(); // "trk|imp" -> [pair]
  const keyOf = (a, b) => `${a}|${b}`;
  const indexPair = p => { const k = keyOf(p.tracking.point, p.impact.point); if (!pairIndex.has(k)) pairIndex.set(k, []); pairIndex.get(k).push(p); };
  for (const p of pairs.values()) { indexPair(p); if (p.tracking.altPoint || p.impact.altPoint) for (const a of [p.tracking.altPoint || p.tracking.point]) for (const b of [p.impact.altPoint || p.impact.point]) { const k = keyOf(a, b); if (!pairIndex.has(k)) pairIndex.set(k, []); pairIndex.get(k).push(p); } }
  const sideOk = (want, have) => !want || want === 'C' || want === 'RL' || !have || have === 'RL' || have === 'C' || want === have;
  // Several numbered pairs can share the same two points (e.g. Vejiga – Vejiga: 74 Streptococcus G, 194 Disfunción
  // Vejiga). Preference: related entity > side agreement > category suggested by the context > lowest number.
  const matchPair = (tr, im, entityId, preferCats = []) => {
    const cands = (pairIndex.get(keyOf(tr.point, im.point)) || []).filter(p => p.level > 0 || p.id.startsWith('pb-'));
    if (!cands.length) return { pair: null, n: 0, pool: [] };
    let pool = cands.filter(p => p.id.startsWith('pb-'));
    if (!pool.length) pool = cands;
    const all = [...pool];
    const bySide = pool.filter(p => sideOk(tr.side, p.tracking.side) && sideOk(im.side, p.impact.side));
    if (bySide.length) pool = bySide;
    const modOf = n => /contralateral/.test(n) ? 'contra' : /ipsilateral/.test(n) ? 'ipsi' : '';
    const want = [modOf(tr.notes.join(' ')), modOf(im.notes.join(' '))];
    if (want.some(Boolean)) { const byMod = pool.filter(p => p._mods && want.every((w, i) => !w || modOf(p._mods[i]) === w)); if (byMod.length) pool = byMod; }
    if (entityId) { const byEnt = pool.filter(p => p.relations.some(r => r.entity === entityId)); if (byEnt.length) pool = byEnt; }
    if (pool.length > 1 && preferCats.length) { const byCat = pool.filter(p => preferCats.includes(p.category)); if (byCat.length) pool = byCat; }
    return { pair: pool[0], n: pool.length, pool: all };
  };
  const CONTEXT_CATS = [
    [/reservorio/, ['reservoir']], [/disfuncional|endocrinolog|nutricional|regularizacion|diabetogen|hiperglicem/, ['dysfunctional']],
    [/psicoemocional|psiquiatr/, ['psychoemotional']], [/desparasitacion|tropical/, ['parasite', 'virus']],
    [/patogenico|oncogenico|respiratorio|urologico|ginecologico|dermatologico|hematologico|inmunologico|cardiologico|gastro|hepatobiliar|conjuntivitis|infeccion|odontologico|postquirurgico|animales/, ['virus', 'bacteria', 'fungus', 'parasite']],
  ];
  const contextCats = id => (CONTEXT_CATS.find(([re]) => re.test(id)) || [, []])[1];
  let ambiguous = 0;
  const cxPairs = new Map();
  const cxPairFor = (tr, im, ctx) => {
    const id = `cx-${tr.point}--${im.point}`;
    if (!cxPairs.has(id)) {
      const p = {
        id, number: null, level: 0,
        name: { es: `${pointTable.get(tr.point).es} – ${pointTable.get(im.point).es}`, en: null },
        tracking: endpoint(tr), impact: endpoint(im), category: ctx.category || 'complex', relations: [], ratings: {},
        symptoms: [], recommendations: [], notes: [], source: ctx.source,
      };
      cxPairs.set(id, p); pairs.set(id, p); indexPair(p);
      notePoint(tr); notePoint(im);
    }
    return cxPairs.get(id);
  };
  for (const ent of entities.values()) {
    const e = ent._leal;
    if (!e) continue;
    for (const pole of e.poles) {
      const tr = resolveRef(pole.neg, `leal ${e.name}`), im = resolveRef(pole.pos, `leal ${e.name}`);
      notePoint(tr); notePoint(im);
      let { pair, n } = matchPair(tr, im, ent.id);
      if (n > 1) ambiguous++;
      if (!pair) {
        const cat = ent.classification === 'glandular-dysfunction' ? 'glandular-dysfunction' : ent.classification || 'complex';
        pair = cxPairFor(tr, im, { category: cat, source: src('leal-2018', pole.page) });
      }
      if (pair.level === 0 && !pair.relations.some(r => r.entity === ent.id)) pair.relations.push({ entity: ent.id });
      const pp = { neg: tr.point, pos: im.point, pairId: pair.id };
      if (tr.side !== 'C') pp.negSide = tr.side;
      if (im.side !== 'C') pp.posSide = im.side;
      const nn = [...tr.notes.map(x => `−: ${x}`), ...im.notes.map(x => `+: ${x}`)];
      if (nn.length) pp.notes = nn;
      if (clean(pole.neg) !== pointTable.get(tr.point).es || clean(pole.pos) !== pointTable.get(im.point).es) pp.raw = { neg: clean(pole.neg), pos: clean(pole.pos) };
      if (!ent.polePairs.some(x => x.neg === pp.neg && x.pos === pp.pos && x.pairId === pp.pairId && x.negSide === pp.negSide && x.posSide === pp.posSide)) ent.polePairs.push(pp);
    }
  }
  report.ambiguousPoleMatches = ambiguous;
  // pole pairs implied by Goiz relations
  for (const p of pairs.values()) {
    if (!p.id.startsWith('pb-')) continue;
    for (const r of p.relations) {
      const ent = entities.get(r.entity);
      if (!ent.polePairs.some(x => x.pairId === p.id)) ent.polePairs.push({ neg: p.tracking.point, pos: p.impact.point, pairId: p.id, ...(p.tracking.side !== 'C' ? { negSide: p.tracking.side } : {}), ...(p.impact.side !== 'C' ? { posSide: p.impact.side } : {}) });
    }
  }

  // ======================================================== Protocols =====
  const protocols = new Map();
  const protoAlias = new Map();
  const protoKind = title => /^Top\s+5/i.test(title) ? 'top5' : /^Top\s+10|^Top Top/i.test(title) ? 'top10' : 'basic';
  const protoId = title => {
    const t = clean(title);
    if (overrides.protocolIds?.[t]) return overrides.protocolIds[t];
    if (/^Top Top 10$/i.test(t)) return 'top10-top';
    let m;
    if ((m = t.match(/^Top\s+(10|5)\s+(.+)$/i))) return `top${m[1]}-${slugKeep(m[2])}`;
    if ((m = t.match(/^Protocolo Básico\s*\((.+)\)$/i))) return `basic-${slug(m[1]) === 'corto' ? 'short' : slug(m[1]) === 'extendido' ? 'extended' : slug(m[1])}`;
    if ((m = t.match(/^(.+?)\s+Básicos?$/i))) return `basic-${slugKeep(m[1])}`;
    return slugKeep(t);
  };
  const addProtoAlias = (name, id) => { for (const k of [slugKeep(name), slug(name)]) if (k && !protoAlias.has(k)) protoAlias.set(k, id); };
  for (const [a, id] of Object.entries(overrides.protocolAliases || {})) addProtoAlias(a, id);
  const rawLists = [];
  for (const lv of LEVELS) {
    for (const l of BM.parseNumberedLists(BM.rangeRows(lv.pages, lv.lists[0], lv.lists[1], lv.off), { doc: lv.doc })) rawLists.push(l);
  }
  // diabetes lists (L2 p.216): "Pares Biomagnéticos Diabetogénicos/Hiperglicémicos" bullet lists
  {
    const rowsD = BM.rangeRowsSingle(LEVELS[1].pages, 76, 76, 140);
    let cur = null;
    for (const r of rowsD) {
      const m = r.text.match(/^Pares Biomagnéticos (Diabetogénicos|Hiperglicémicos)$/);
      if (m) { cur = { title: `PB´s ${m[1]}`, items: [], page: r.page, doc: 'goiz-n2', kind: 'basic', idOverride: `basic-pb-${slug(m[1])}` }; rawLists.push(cur); continue; }
      const b = r.text.match(/^•\s*(.+)$/);
      if (cur && b) cur.items.push({ n: cur.items.length + 1, text: b[1], page: r.page });
    }
  }
  for (const l of rawLists) {
    const id = l.idOverride || protoId(l.title);
    let pr = protocols.get(id);
    if (!pr) {
      pr = { id, kind: l.kind || protoKind(l.title), name: { es: clean(l.title).replace(/\s*\(([^)]+)\)/, (m, x) => ` (${x})`) }, items: [], source: src(l.doc, l.page), _raw: [] };
      protocols.set(id, pr);
    } else {
      (pr.alsoIn ||= []).push(src(l.doc, l.page));
    }
    addProtoAlias(l.title, id);
    pr._raw.push(...l.items.map(i => ({ ...i, doc: l.doc })));
  }
  // disease protocols
  const diseaseIndex = new Map();
  for (const r of BM.rangeRowsSingle(LEVELS[1].pages, 9, 13, 140)) {
    const m = r.text.match(/^(\d{1,3})\.\s+(.+?)(?:\s+P\.\s*(\d+))?$/);
    if (m && !/\s[–-]\s/.test(m[2]) && !/\.{4,}/.test(m[2]) && +m[1] <= 200) diseaseIndex.set(+m[1], clean(m[2]));
  }
  const diseases = BM.parseDiseaseProtocols(BM.rangeRows(LEVELS[1].pages, 78, 96, 140), { doc: 'goiz-n2' });
  for (const d of diseases) {
    if (overrides.diseaseNames?.[String(d.n)]) { usedOverride(`diseaseNames.${d.n}: "${d.name}" -> "${overrides.diseaseNames[String(d.n)]}"`); d.name = overrides.diseaseNames[String(d.n)]; }
    const idxName = diseaseIndex.get(d.n);
    if (idxName && slug(idxName) !== slug(d.name)) {
      if (slug(idxName).startsWith(slug(d.name)) && d.items[0] && slug(`${d.name} ${d.items[0].text}`) === slug(idxName)) { d.name = `${d.name} ${d.items.shift().text}`; }
      else report.indexMismatches.push(`disease ${d.n}: "${d.name}" vs index "${idxName}"`);
    }
    const id = `disease-${slug(d.name)}`;
    if (protocols.has(id)) { warn(`duplicate disease protocol ${id}`); continue; }
    protocols.set(id, { id, kind: 'disease', number: d.n, name: { es: clean(d.name) }, items: [], source: src('goiz-n2', d.page), _raw: d.items.map((i, k) => ({ n: k + 1, text: i.text, page: i.page, doc: 'goiz-n2' })) });
  }
  // resolve protocol items
  const findProtocols = text => {
    let t = clean(text).replace(/\s*\(pg\.?\s*\d+\)$/i, '');
    const keys = [t, t.replace(/^Top\s+(10|5)\s*-\s*/i, 'Top $1 '), t.replace(/\(Enf\.\s*/i, '(Enfermedades ')];
    for (const k of keys) { const id = protoAlias.get(slugKeep(k)) || protoAlias.get(slug(k)) || (protocols.has(protoId(k)) ? protoId(k) : null); if (id) return [].concat(id); }
    // "Top 10 Neurológico" without qualifier -> all matching variants
    const m = t.match(/^Top\s+(10|5)\s+(.+)$/i);
    if (m) { const pref = `top${m[1]}-${slug(m[2])}`; const hits = [...protocols.keys()].filter(k => k.startsWith(pref)); if (hits.length) return hits; }
    return null;
  };
  const relatedPairs = term => {
    // "PB´s relacionados a Hepatitis" -> pairs whose relation entity starts with the term, or that use the point
    let t = clean(term).replace(/^M\.\s*/i, 'Mycobacterium ').replace(/^Yersini\s/i, 'Yersinia ').replace(/s$/, '');
    const s = slug(t);
    const ps = [...pairs.values()].filter(p => p.id.startsWith('pb-') && p.relations.some(r => r.entity === s || r.entity.startsWith(s + '-') || r.entity.startsWith(s)));
    if (ps.length) return { pairs: ps, by: 'relation' };
    const pt = lookupPoint(t);
    if (pt) return { pairs: [...pairs.values()].filter(p => p.id.startsWith('pb-') && (p.tracking.point === pt || p.impact.point === pt)), by: 'point' };
    const cat = { virus: 'virus', bacteria: 'bacteria', 'bacterias-patogenica': 'bacteria', 'virus-patogenico': 'virus' }[s];
    if (cat) return { category: cat };
    return null;
  };
  const resolveItem = (raw, pr) => {
    let t = clean(raw.text).replace(/\s*\(pg\.?\s*\d+\)$/i, '');
    const out = { items: [], notes: [] };
    if (/^[-–]?$/.test(t)) return out;
    // explicit overrides
    const ov = overrides.protocolItems?.[t];
    if (ov) { usedOverride(`protocolItems["${t}"]`); return { items: ov.items || [], notes: (ov.notes || []).map(n => L(n)) }; }
    // protocol reference
    const pids = findProtocols(t) || (pr.id === 'top10-top' ? findProtocols(`Top 10 ${t.replace(/\s*\(.*\)$/, '')}`) || findProtocols(`Top 5 ${t}`) : null);
    if (pids) { out.items.push(...pids.map(id => ({ protocol: id }))); return out; }
    let m;
    if ((m = t.match(/^PB´?s\s+relacionados\s+a\s+(.+)$/i))) {
      const rp = relatedPairs(m[1]);
      if (rp?.pairs?.length) { out.items.push(...rp.pairs.map(p => ({ pair: p.id }))); out.notes.push(L(`${t} (expandido a ${rp.pairs.length} pares por ${rp.by === 'relation' ? 'relación' : 'punto'})`)); return out; }
      out.notes.push(L(t)); report.unresolved.push({ where: pr.id, item: t, reason: rp?.category ? `category-wide reference (${rp.category}); kept as note` : 'no matching pairs' }); return out;
    }
    if ((m = t.match(/^PB´?s\s+(Diabetogénicos|Hiperglicémicos)$/i))) { out.items.push({ protocol: `basic-pb-${slug(m[1])}` }); return out; }
    // pair text, possibly "A – B / C – D" alternatives, possibly with "(hint)" and "+ extra"
    const segs = t.split(/\s+\/\s+/);
    const alts = segs.length > 1 && segs.every(x => /\s[–-]\s/.test(x)) ? segs : [t];
    for (let a of alts) {
      let hint = null;
      a = a.replace(/\s*\+\s*(.+)$/, (x, y) => { out.notes.push(L(`${a.replace(/\s*\+.*$/, '')}: + ${y}`)); return ''; });
      const hm = a.match(/^(.*\S)\s+\(([^()]+)\)$/);
      if (hm && !G.isSideMarker(hm[2]) && /\s–\s/.test(hm[1])) {
        // trailing relation hint only if the part after the last dash already has its own content
        const lastPart = hm[1].split(/\s+–\s+/).pop();
        if (lastPart) { hint = hm[2]; a = hm[1]; }
      }
      const parts = a.split(/\s+[–-]\s+/);
      if (parts.length < 2) { out.notes.push(L(t)); report.unresolved.push({ where: pr.id, item: t, reason: 'not a pair or protocol reference' }); return out; }
      if (parts.length === 4 && parts.every(x => slug(x) === 'pancreas')) { out.items.push({ pair: 'pb-282' }); continue; }
      const tr = resolveRef(parts[0], `protocol ${pr.id}`), im = resolveRef(parts[parts.length - 1], `protocol ${pr.id}`);
      const hintEnt = hint ? entityIdFor(hint) : null;
      let { pair, n, pool } = matchPair(tr, im, hintEnt, contextCats(pr.id));
      if (pair && pool.length > 1 && !hintEnt) report.spot.push(`protocol ${pr.id}: "${a}" matches ${pool.map(p => p.id).join(', ')}; chose ${pair.id} (${pair.category})`);
      if (!pair) {
        pair = cxPairFor(tr, im, { category: overrides.cxCategory?.[`${tr.point}--${im.point}`] || 'complex', source: src(raw.doc, raw.page) });
        report.unresolved.push({ where: pr.id, item: a, reason: `no numbered pair; mapped to ${pair.id}` });
      }
      notePoint(tr, true); notePoint(im, true);
      const item = { pair: pair.id };
      if (pool?.length > 1) item.samePoints = pool.map(p => p.id).filter(x => x !== pair.id);
      const sideNote = [tr.side !== 'C' && tr.side !== pair.tracking.side ? `−${tr.side}` : null, im.side !== 'C' && im.side !== pair.impact.side ? `+${im.side}` : null].filter(Boolean);
      if (sideNote.length) item.sides = { tracking: tr.side, impact: im.side };
      if (hint) item.note = { es: hint };
      out.items.push(item);
    }
    return out;
  };
  for (const pr of protocols.values()) {
    const seen = new Set();
    for (const raw of pr._raw) {
      const { items, notes } = resolveItem(raw, pr);
      for (const it of items) { const k = it.pair || `p:${it.protocol}`; if (seen.has(k)) continue; seen.add(k); pr.items.push(it); }
      if (notes.length) (pr.notes ||= []).push(...notes);
    }
    delete pr._raw;
  }
  // entity -> protocols (Leal "Protocolo / Top" column)
  for (const ent of entities.values()) {
    const e = ent._leal;
    if (!e) continue;
    const lines = [];
    for (const l of e.protocols) { if (lines.length && (/^[a-záéíóúñ(]/.test(l) || /\($/.test(lines[lines.length - 1]) || (lines[lines.length - 1].match(/\(/g) || []).length > (lines[lines.length - 1].match(/\)/g) || []).length)) lines[lines.length - 1] = joinWrapped(lines[lines.length - 1], l); else lines.push(l); }
    for (const l of lines) {
      const ids = findProtocols(l.replace(/\s*[–-]\s*/, ' '));
      if (ids) ent.protocols.push(...ids.filter(x => !ent.protocols.includes(x)));
      else report.unresolved.push({ where: `entity ${ent.id}`, item: l, reason: 'protocol name not found' });
    }
    delete ent._leal;
  }
  // pair -> related protocols from recommendation lines
  for (const p of pairs.values()) {
    const rel = [];
    for (const r of p.recommendations) { const ids = /^Top\s/.test(r.es) ? findProtocols(r.es) : null; if (ids) rel.push(...ids); }
    if (rel.length) p.relatedProtocols = uniq(rel);
  }

  // ======================================================== Points =========
  const points = [];
  for (const [id, sides] of [...pointUse.entries()].sort()) {
    const t = pointTable.get(id);
    const usedSides = [...sides];
    const lat = usedSides.includes('lateral') ? 'bilateral' : t.laterality;
    points.push({ id, name: L(t.es, t.en), aliases: [...t.aliases].sort((a, b) => a.localeCompare(b, 'es')), laterality: lat });
  }
  for (const [id, ctx] of newPoints) report.unresolved.push({ where: 'points', item: `${pointTable.get(id).es} (${id})`, reason: `not in point-aliases.js; used by ${uniq(ctx).slice(0, 5).join(', ')}` });

  // ======================================================== English names ==
  const pointShortEn = id => (pointTable.get(id).en || pointTable.get(id).es).replace(/\s*\(.*?\)/g, '');
  const SIDE_EN = { D: 'R', I: 'L', 'D/I': 'R/L', C: 'C', S: 'sup.', Inf: 'inf.', A: 'ant.', P: 'post.', Post: 'post.', Lat: 'lat.', lat: 'lat.', Contralateral: 'contralateral', contralateral: 'contralateral', Ipsilateral: 'ipsilateral', ipsilateral: 'ipsilateral', 'C/D/I': 'C/R/L', Cualquiera: 'any' };
  const titleEn = (title, refs) => {
    const parts = G.splitPairTitle(title).parts;
    return parts.map((p, i) => {
      const r = refs[i] || parsePointRef(p);
      const markers = [...p.matchAll(/\(([^()]+)\)/g)].map(m => m[1].trim()).filter(x => G.isSideMarker(x)).map(x => SIDE_EN[x] || x);
      return `${pointShortEn(r.point || lookupPoint(r.name))}${markers.length ? ` (${markers.join(', ')})` : ''}`;
    }).join(' – ');
  };
  for (const p of pairs.values()) {
    if (p.id.startsWith('pb-')) {
      const parts = G.splitPairTitle(p.name.es).parts;
      const refs = parts.map(x => parsePointRef(x));
      p.name.en = titleEn(p.name.es, refs);
    } else {
      const sideEn = s => ({ R: ' (R)', L: ' (L)', RL: ' (R/L)' }[s] || '');
      p.name.en = `${pointShortEn(p.tracking.point)}${sideEn(p.tracking.side)} – ${pointShortEn(p.impact.point)}${sideEn(p.impact.side)}`;
      const sideEs = s => ({ R: ' (D)', L: ' (I)', RL: ' (D/I)' }[s] || '');
      p.name.es = `${pointTable.get(p.tracking.point).es}${sideEs(p.tracking.side)} – ${pointTable.get(p.impact.point).es}${sideEs(p.impact.side)}`;
    }
  }
  for (const ent of entities.values()) { const en = T.entityEn(ent); if (en) ent.name.en = en; else report.missingEn = (report.missingEn || 0) + 1; }
  for (const pr of protocols.values()) { const en = T.protocolEn(pr); if (en) pr.name.en = en; else report.unresolved.push({ where: 'protocols', item: pr.name.es, reason: 'no English name' }); }
  for (const v of vocab.values()) { const m = v.id.match(/^sintomas-(.+)$/); if (m && T.SYSTEM_ES[m[1]]) v.name.es = `Síntomas ${T.SYSTEM_ES[m[1]]}`; if (SYMPTOM_NAMES[v.id]) v.name.es = SYMPTOM_NAMES[v.id]; }
  const symptoms = [...vocab.values()].map(v => ({ id: v.id, system: v.system, ...(v.systems.size > 1 ? { systems: [...v.systems].filter(Boolean).sort() } : {}), name: L(v.name.es, T.symptomEn(v.id, v.name.es)), ...(v.definition ? { definition: v.definition } : {}), pairs: [...v.pairs].sort(), source: v.source }));

  // ======================================================== Other files ====
  const contraindications = [];
  const contraSeen = new Map();
  for (const [lv, rng] of [[LEVELS[0], [130, 132]], [LEVELS[1], [106, 108]]]) {
    const c = BM.parseContraindications(lv.pages, rng[0], rng[1], lv.off);
    for (const kind of ['relative', 'absolute']) for (const it of c[kind]) {
      const id = `${kind === 'relative' ? 'rel' : 'abs'}-${String(it.n).padStart(2, '0')}`;
      const prev = contraSeen.get(id);
      if (prev) {
        if (!prev.alsoIn?.some(s => s.doc === lv.doc)) (prev.alsoIn ||= []).push(src(lv.doc, it.page));
        if (slug(prev.text.es) !== slug(it.text)) { (prev.variants ||= []).push({ es: it.text, source: src(lv.doc, it.page) }); warn(`contraindication ${id} wording differs between guides: "${prev.text.es}" vs "${it.text}" (${lv.doc})`); }
        continue;
      }
      const rec = { id, kind, number: it.n, text: L(it.text, T.contraEn(it.text)), source: src(lv.doc, it.page) };
      contraSeen.set(id, rec); contraindications.push(rec);
    }
  }
  const recTitles = ['Tipos de Recomendación', 'Recomendaciones Generales (Versión Completa)', 'Recomendaciones Generales (Versión Corta)', 'Recomendaciones para Enfermedades Parasitarias', 'Recomendaciones para Enfermedades Tropicales', 'Recomendaciones para Infecciones de Transmisión Sexual (ITS)', 'Recomendaciones Legales', 'Recomendaciones para Crisis Curativa', 'Recomendaciones del buen comer', 'Recomendaciones del buen dormir', 'Recomendaciones del buen ir al baño', 'Recomendaciones para la realización de Ejercicio Terapéutico', 'Recomendaciones para manejo del estrés'];
  const recommendations = [];
  for (const lv of LEVELS) {
    for (const s of BM.parseRecommendationSections(BM.rangeRowsSingle(lv.pages, lv.recs[0], lv.recs[1], lv.off), recTitles)) {
      const id = T.REC_IDS[s.title];
      if (!id) continue;
      const prev = recommendations.find(r => r.id === id);
      if (prev) { (prev.alsoIn ||= []).push(src(lv.doc, s.page)); continue; }
      const body = [...s.intro, ...s.items.map(i => `${i.n}. ${i.text}`), ...(s.outro || [])].join('\n');
      recommendations.push({ id, title: L(s.title, T.REC_EN[id]), body: { es: body }, items: s.items.map(i => ({ es: i.text })), source: src(lv.doc, s.page) });
    }
  }
  const intake = BM.parseIntakeForm(LEVELS[1].pages, 108, 110, 140);
  recommendations.push(T.intakeRecord(intake, src('goiz-n2', 248)));
  // glossary
  const glossary = [];
  const gseen = new Set();
  for (const lv of LEVELS) for (const a of BM.parseAbbreviations(lv.pages[3])) {
    if (gseen.has(a.abbr)) continue; gseen.add(a.abbr);
    glossary.push({ abbr: a.abbr, meaning: L(a.meaning, T.abbrEn(a.abbr, a.meaning)), source: src(lv.doc, 4 + lv.off) });
  }
  for (const [code, kind] of Object.entries({ Pt: 'Patógeno', Pr: 'Par', Pd: 'Padecimiento' })) glossary.push({ abbr: code, meaning: L(kind, T.abbrEn(code, kind)), group: 'leal-type', source: src('leal-2018', 16) });
  for (const [code, name] of Object.entries(CLASS_CODE_NAMES)) glossary.push({ abbr: code, meaning: L(name, T.abbrEn(code, name)), group: 'leal-classification', category: CLASS_CODES[code], source: src('leal-2018', 17) });
  glossary.push({ abbr: 'Est', meaning: L('Estado (código no definido en el glosario; usado en 15 entradas)', 'State (code not defined in the glossary; used by 15 entries)'), group: 'leal-type', source: src('leal-2018', 95) });

  // ======================================================== finalize =======
  const pairList = [...pairs.values()].map(p => {
    const o = { id: p.id, number: p.number, level: p.level, name: p.name, ...(p.altNames ? { altNames: p.altNames } : {}), tracking: p.tracking, impact: p.impact,
      ...(p.magnets ? { magnets: p.magnets } : {}), category: p.category, relations: p.relations, ratings: p.ratings, symptoms: p.symptoms,
      recommendations: p.recommendations, ...(p.recommendationSets?.length ? { recommendationSets: p.recommendationSets } : {}),
      ...(p.relatedProtocols ? { relatedProtocols: p.relatedProtocols } : {}), notes: p.notes, source: p.source };
    return o;
  }).sort((a, b) => (a.level === 0) - (b.level === 0) || (a.number ?? 0) - (b.number ?? 0) || byId(a, b));
  const entityList = [...entities.values()].map(e => {
    const { id, name, kind, classification, typeCode, aliases, contagion, description, polePairs, protocols: prs, source, alsoIn } = e;
    return { id, name, kind, classification, ...(typeCode ? { typeCode } : {}), ...(aliases ? { aliases } : {}), ...(contagion ? { contagion } : {}), ...(description ? { description } : {}), polePairs, protocols: prs, source, ...(alsoIn?.length ? { alsoIn } : {}) };
  }).sort(byId);
  const protocolList = [...protocols.values()].map(p => ({ id: p.id, kind: p.kind, ...(p.number ? { number: p.number } : {}), name: p.name, items: p.items, ...(p.notes ? { notes: p.notes } : {}), source: p.source, ...(p.alsoIn ? { alsoIn: p.alsoIn } : {}) }))
    .sort((a, b) => ['basic', 'top10', 'top5', 'disease', 'application'].indexOf(a.kind) - ['basic', 'top10', 'top5', 'disease', 'application'].indexOf(b.kind) || (a.number ?? 0) - (b.number ?? 0) || byId(a, b));

  const dedupe = a => { const seen = new Set(); return a.filter(x => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  report.unresolved = dedupe(report.unresolved); report.spot = dedupe(report.spot); report.overridesApplied = dedupe(report.overridesApplied); report.warnings = dedupe(report.warnings);
  return {
    data: {
      sources: sourcesMeta,
      points: points.sort(byId),
      pairs: pairList,
      entities: entityList,
      protocols: protocolList,
      symptoms: symptoms.sort(byId),
      contraindications: contraindications.sort((a, b) => a.kind.localeCompare(b.kind) * -1 || a.number - b.number),
      recommendations,
      glossary,
    },
    report,
    leal,
  };
}

function cap(s) { s = clean(s); return s ? s[0].toUpperCase() + s.slice(1) : s; }
