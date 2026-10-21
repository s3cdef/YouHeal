// Catalog / Reference: pairs, entities, protocols (+ printable protocol card), symptoms, contraindications, glossary.
import { el, mount, clear, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, errorMessage } from '../api.js';
import { t, locText, locNode, getLocale, vocab } from '../i18n.js';
import { loadCore, getPair, getProtocol, getList, protocolPairIds, polarity } from '../state.js';
import { tabs, table, emptyState, categoryChip, ratingsRow, pairPoles, chip, select, skeleton, card, alertBox, toggleSwitch, segmented, CATEGORY_TONES, pairNum } from '../ui/components.js';
import { openModal } from '../ui/modal.js';
import { pageHeader, errorPanel } from './common.js';
import { pairDetailBody, sourceCite } from './pair-detail.js';
import { PROTOCOL_KINDS } from './start-scan.js';

const TABS = ['pairs', 'entities', 'protocols', 'symptoms', 'contraindications', 'glossary'];
const SYSTEMS = ['general', 'respiratory', 'gastrointestinal', 'neurological', 'musculoskeletal', 'urological', 'cardiological', 'gynecological', 'endocrine', 'hematological', 'dermatological', 'ophthalmological', 'auditory', 'immunological', 'psychiatric', 'oncological', 'dental', 'tropical', 'toxicological'];
const CATEGORIES = Object.keys(CATEGORY_TONES);

function setQuery(tab, q) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  history.replaceState(null, '', `#/catalog/${tab}${qs ? '?' + qs : ''}`);
}

export async function openPairSheet(pairId) {
  const core = await loadCore();
  const body = el('div', skeleton(6));
  const summary = core.pairs.get(pairId);
  openModal({ title: summary ? `${pairNum(summary)} · ${locText(summary.name)}` : t('catalog.pair'), size: 'sheet', body, actions: [{ label: t('common.close'), value: null, variant: 'secondary' }] });
  try { mount(body, pairDetailBody(await getPair(pairId), core, { onOpenPair: (pid) => openPairSheet(pid) })); } catch (err) { mount(body, alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })); }
}

export async function renderCatalog({ main, params, query }) {
  const tab = TABS.includes(params.tab) ? params.tab : 'pairs';
  let core;
  try { core = await loadCore(); } catch (err) { mount(main, el('div.page', errorPanel(err))); return null; }
  const tb = tabs({
    label: t('catalog.sections'), active: tab, variant: 'line',
    tabs: TABS.map((id) => ({ id, label: t(`catalog.tab.${id}`) })),
    onChange: (id, panel, user) => {
      clear(panel);
      const q = user ? {} : query;
      if (user) setQuery(id, {});
      const fn = { pairs: pairsTab, entities: entitiesTab, protocols: protocolsTab, symptoms: symptomsTab, contraindications: contraTab, glossary: glossaryTab }[id];
      fn({ panel, core, query: q });
    },
  });
  mount(main, el('div.page.page-catalog',
    pageHeader({ title: t('catalog.title'), subtitle: t('catalog.subtitle') }),
    tb.root, tb.panel));
  return null;
}

// ---------------- Pairs ----------------
function pairsTab({ panel, core, query }) {
  const f = { q: query.q || '', category: query.category || '', level: query.level || '', system: query.system || '', protocol: query.protocol || '', point: query.point || '', cx: query.cx || '' };
  let shown = 100;
  const q = el('input.input', { type: 'search', id: 'pair-q', placeholder: t('catalog.searchPairs'), value: f.q, autocomplete: 'off' });
  const cat = select([{ value: '', label: t('catalog.allCategories') }, ...CATEGORIES.map((c) => ({ value: c, label: vocab("categories", c) }))], { id: 'pair-cat' });
  const lvl = select([{ value: '', label: t('catalog.allLevels') }, { value: '1', label: t('catalog.levelN', { n: 1 }) }, { value: '2', label: t('catalog.levelN', { n: 2 }) }, { value: '0', label: t('catalog.compendium') }], { id: 'pair-level' });
  const sys = select([{ value: '', label: t('catalog.allSystems') }, ...SYSTEMS.map((s) => ({ value: s, label: vocab("systems", s) }))], { id: 'pair-sys' });
  const proto = select([{ value: '', label: t('catalog.allProtocols') }, ...core.protocols.map((p) => ({ value: p.id, label: locText(p.name) }))], { id: 'pair-proto' });
  cat.value = f.category; lvl.value = f.level; sys.value = f.system; proto.value = f.protocol;
  const results = el('div', skeleton(6));
  const count = el('p.results-count', { aria: { live: 'polite' } });
  const pointChip = el('div');
  const cxToggle = toggleSwitch({ label: t('catalog.includeCompendium'), checked: f.cx === '1', onChange: (v) => { f.cx = v ? '1' : ''; load(); } });
  const filt = (label, ctl) => el('div.filter', el('label.label', { for: ctl.id }, label), ctl);
  mount(panel,
    el('div.filters',
      el('div.filter.filter-grow', el('label.label', { for: 'pair-q' }, t('common.search')), el('div.search-field', el('span.search-icon', icon('search', { size: 18 })), q)),
      filt(t('catalog.category'), cat), filt(t('catalog.level'), lvl), filt(t('catalog.system'), sys), filt(t('catalog.protocol'), proto)),
    el('div.filter-row', cxToggle, pointChip), count, results);
  async function load(keepShown = false) {
    if (!keepShown) shown = 100;
    setQuery('pairs', f);
    mount(pointChip, f.point ? el('span.chip.tone-teal.chip-removable', t('catalog.atPoint', { point: core.points.has(f.point) ? locText(core.points.get(f.point).name) : f.point }),
      el('button.chip-x', { type: 'button', aria: { label: t('common.clearFilter') }, onClick: () => { f.point = ''; load(); } }, icon('x', { size: 14 }))) : null);
    let list;
    try { list = items(await api.get('/catalog/pairs', { q: f.q, category: f.category, level: f.level, system: f.system, protocol: f.protocol, point: f.point, limit: 5000 })); } catch (err) { mount(results, errorPanel(err, () => load())); return; }
    // Default view: the numbered guide pairs (levels 1–2). Compendium (level 0, cx-…) on request or when filtering by level 0.
    const hidden = !f.cx && f.level === '' ? list.filter((p) => !p.level).length : 0;
    if (hidden) list = list.filter((p) => p.level);
    count.textContent = `${t('catalog.pairsCount', { count: list.length })}${hidden ? ` · ${t('catalog.compendiumHidden', { n: hidden })}` : ''}`;
    const page = list.slice(0, shown);
    const more = list.length > shown ? el('button.btn.btn-secondary.btn-block.show-more', { type: 'button', onClick: () => { shown += 200; load(true); } }, t('catalog.showMore', { n: Math.min(200, list.length - shown), total: list.length })) : null;
    mount(results, table({
      caption: t('catalog.tab.pairs'), rows: page, dense: true,
      onRowClick: (p) => openPairSheet(p.id), rowLabel: (p) => `${pairNum(p)} ${locText(p.name)}`,
      empty: emptyState({ icon: 'search', title: t('catalog.noPairs'), compact: true }),
      columns: [
        { key: 'number', label: '#', cls: 'mono num-col', render: (p) => (p.number ? String(p.number) : '—') },
        { key: 'name', label: t('catalog.pair'), render: (p) => el('span.cell-stack', locNode(p.name, 'span', 'cell-strong'), pairPoles(p, core.points, { compact: true })) },
        { key: 'cat', label: t('catalog.category'), render: (p) => categoryChip(p.category) },
        { key: 'rel', label: t('pair.relatedTo'), render: (p) => el('span.cell-rel', (p.relations || []).slice(0, 3).map((r) => (r.name ? locText(r.name) : r.entity)).join(', ') + ((p.relations || []).length > 3 ? ` +${p.relations.length - 3}` : '') || '—') },
        { key: 'fpr', label: t('pair.fprShort'), render: (p) => ratingsRow(p.ratings) },
        { key: 'level', label: t('catalog.level'), align: 'right', render: (p) => (p.level ? String(p.level) : el('span.muted.small', 'CX')) },
      ],
    }), more);
  }
  q.addEventListener('input', debounce(() => { f.q = q.value.trim(); load(); }, 250));
  for (const [ctl, k] of [[cat, 'category'], [lvl, 'level'], [sys, 'system'], [proto, 'protocol']]) ctl.addEventListener('change', () => { f[k] = ctl.value; load(); });
  load();
  if (query.open) openPairSheet(query.open);
}

// ---------------- Entities ----------------
function entitiesTab({ panel, core, query }) {
  const f = { q: query.q || '', kind: query.kind || '' };
  const q = el('input.input', { type: 'search', id: 'ent-q', placeholder: t('catalog.searchEntities'), value: f.q });
  const kind = select([{ value: '', label: t('catalog.allKinds') }, ...['pathogen', 'condition', 'named-pair'].map((k) => ({ value: k, label: t(`entityKind.${k}`) }))], { id: 'ent-kind' });
  kind.value = f.kind;
  const results = el('div.entity-grid', skeleton(4));
  mount(panel, el('div.filters',
    el('div.filter.filter-grow', el('label.label', { for: 'ent-q' }, t('common.search')), el('div.search-field', el('span.search-icon', icon('search', { size: 18 })), q)),
    el('div.filter', el('label.label', { for: 'ent-kind' }, t('catalog.kind')), kind)), results);
  let shown = 60;
  async function load(keep = false) {
    if (!keep) shown = 60;
    setQuery('entities', f);
    let list;
    try { list = items(await api.get('/catalog/entities', { q: f.q, kind: f.kind, limit: 5000 })); } catch (err) { mount(results, errorPanel(err, () => load())); return; }
    if (!list.length) { mount(results, emptyState({ icon: 'search', title: t('catalog.noEntities'), compact: true })); return; }
    const cards = list.slice(0, shown).map((e) => {
      const pairsBox = el('div.entity-pairs');
      const btn = e.pairCount ? el('button.btn.btn-sm.btn-ghost', { type: 'button', aria: { expanded: 'false' } }, icon('chevronDown', { size: 16 }), t('catalog.showPairs', { count: e.pairCount })) : el('p.muted.small', t('catalog.noPairsLinked'));
      if (e.pairCount) btn.addEventListener('click', async () => {
        if (btn.getAttribute('aria-expanded') === 'true') { btn.setAttribute('aria-expanded', 'false'); mount(pairsBox); return; }
        btn.setAttribute('aria-expanded', 'true'); mount(pairsBox, skeleton(2));
        try {
          const d = await api.get(`/catalog/entities/${encodeURIComponent(e.id)}`);
          mount(pairsBox, d.description ? el('p.entity-desc', locNode(d.description)) : null,
            el('ul.chips-inline', (d.pairs || []).map((p) => el('li', el('button.chip.tone-gold.chip-link', { type: 'button', onClick: () => openPairSheet(p.id) }, `${p.number ? '#' + p.number + ' ' : ''}${locText(p.name)}`)))),
            sourceCite(d.source));
        } catch (err) { mount(pairsBox, el('p.muted', errorMessage(err))); }
      });
      return el('article.entity-card',
        el('header.entity-head', el('h3.entity-name', locNode(e.name)), el('div.pd-chips', chip(t(`entityKind.${e.kind}`), 'slate'), e.classification ? categoryChip(e.classification) : null)),
        btn, pairsBox);
    });
    mount(results, cards, list.length > shown ? el('button.btn.btn-secondary.show-more.span-all', { type: 'button', onClick: () => { shown += 120; load(true); } }, t('catalog.showMore', { n: Math.min(120, list.length - shown), total: list.length })) : null);
  }
  q.addEventListener('input', debounce(() => { f.q = q.value.trim(); load(); }, 250));
  kind.addEventListener('change', () => { f.kind = kind.value; load(); });
  load();
}

// ---------------- Protocols ----------------
function protocolsTab({ panel, core, query }) {
  const listItems = el('div.proto-list-items');
  const pq = el('input.input', { type: 'search', id: 'proto-q', placeholder: t('scan.searchProtocols', { count: core.protocols.length }), autocomplete: 'off' });
  let kindF = '';
  const kinds = PROTOCOL_KINDS.filter((k) => core.protocols.some((p) => p.kind === k));
  const seg = segmented({ name: 'pk', label: t('scan.protocolKind'), value: '', size: 'xs', options: [{ value: '', label: t('common.all') }, ...kinds.map((k) => ({ value: k, label: t(`protocolKindShort.${k}`) }))], onChange: (v) => { kindF = v; renderList(); } });
  const listEl = el('nav.proto-list', { aria: { label: t('catalog.tab.protocols') } },
    el('label.sr-only', { for: 'proto-q' }, t('common.search')), el('div.search-field', el('span.search-icon', icon('search', { size: 18 })), pq), seg, listItems);
  const detail = el('div.proto-detail');
  mount(panel, el('div.split', listEl, detail));
  let active = query.open || null;
  pq.addEventListener('input', debounce(renderList, 150));
  const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function renderList() {
    const n = nrm(pq.value.trim());
    mount(listItems, PROTOCOL_KINDS.map((k) => {
      if (kindF && k !== kindF) return null;
      const ps = core.protocols.filter((p) => p.kind === k && (!n || nrm(`${p.name.en || ''} ${p.name.es || ''}`).includes(n))).sort((a, b) => locText(a.name).localeCompare(locText(b.name)));
      if (!ps.length) return null;
      return el('details.proto-kind', { open: kindF || n || ps.length <= 12 || ps.some((p) => p.id === active) ? true : null }, el('summary.pd-label', `${t(`protocolKind.${k}`)} · ${ps.length}`), el('ul', ps.map((p) => el('li',
        el('button.proto-item', { type: 'button', aria: { current: active === p.id ? 'true' : null }, onClick: () => { active = p.id; setQuery('protocols', { open: p.id }); renderList(); show(p.id); } },
          el('span', locText(p.name)), el('span.count-pill', String(p.count ?? '')))))));
    }));
  }
  async function show(id) {
    mount(detail, skeleton(6));
    let p;
    try { p = await getProtocol(id); } catch (err) { mount(detail, errorPanel(err)); return; }
    const ids = protocolPairIds(p);
    mount(detail, card({
      title: locText(p.name), icon: 'list', sub: `${t(`protocolKind.${p.kind}`)} · ${t('catalog.pairsCount', { count: ids.length })}`,
      actions: el('a.btn.btn-secondary', { href: `#/catalog/protocols/${encodeURIComponent(p.id)}/card` }, icon('print', { size: 18 }), t('catalog.protocolCard')),
      children: [
        p.recommendation ? alertBox({ tone: 'info', title: t('catalog.recommendation'), children: [el('p', locNode(p.recommendation))] }) : null,
        p.children && p.children.length ? el('p.small.muted', `${t('catalog.includes')}: `, p.children.map((c) => locText(c.name) || c.id).join(' · ')) : null,
        el('ol.proto-pairs', ids.map((pid, i) => {
          const pr = core.pairs.get(pid); if (!pr) return el('li', pid);
          return el('li.proto-pair', el('span.ck-num', String(i + 1)),
            el('button.proto-pair-btn', { type: 'button', onClick: () => openPairSheet(pid) }, el('span.pair-num', pairNum(pr)), locNode(pr.name)),
            pairPoles(pr, core.points, { compact: true }), categoryChip(pr.category));
        })),
        sourceCite(p.source),
      ],
    }));
  }
  renderList();
  if (active) show(active);
  else mount(detail, emptyState({ icon: 'list', title: t('catalog.pickProtocol'), compact: true }));
}

// ---------------- Symptoms ----------------
function symptomsTab({ panel, core, query }) {
  const f = { q: query.q || '', system: query.system || '' };
  const q = el('input.input', { type: 'search', id: 'sym-q', placeholder: t('catalog.searchSymptoms'), value: f.q });
  const sys = select([{ value: '', label: t('catalog.allSystems') }, ...SYSTEMS.map((s) => ({ value: s, label: vocab("systems", s) }))], { id: 'sym-sys' });
  sys.value = f.system;
  const results = el('div', skeleton(4));
  mount(panel, el('div.filters',
    el('div.filter.filter-grow', el('label.label', { for: 'sym-q' }, t('common.search')), el('div.search-field', el('span.search-icon', icon('search', { size: 18 })), q)),
    el('div.filter', el('label.label', { for: 'sym-sys' }, t('catalog.system')), sys)), results);
  async function load() {
    setQuery('symptoms', f);
    let list;
    try { list = items(await api.get('/catalog/symptoms', { q: f.q, system: f.system, limit: 5000 })); } catch (err) { mount(results, errorPanel(err, load)); return; }
    if (!list.length) { mount(results, emptyState({ icon: 'search', title: t('catalog.noSymptoms'), compact: true })); return; }
    const by = new Map(); for (const s of list) { if (!by.has(s.system)) by.set(s.system, []); by.get(s.system).push(s); }
    const pairChip = (pid) => { const p = core.pairs.get(pid); if (!p) return null; return el('button.chip.tone-gold.chip-link.chip-sm', { type: 'button', title: locText(p.name), onClick: () => openPairSheet(pid) }, p.number ? `#${p.number}` : locText(p.name)); };
    const item = (s) => el('li.sym-index-item', el('span.sym-index-name', locNode(s.name)), el('span.chips-inline', (s.pairs || []).slice(0, 8).map(pairChip), (s.pairs || []).length > 8 ? el('span.muted.small', `+${s.pairs.length - 8}`) : null));
    mount(results, el('div.sym-index', [...by.entries()].map(([system, ss]) => el('section.sym-index-group', el('h3.pd-label', vocab('systems', system)), el('ul', ss.map(item))))));
  }
  q.addEventListener('input', debounce(() => { f.q = q.value.trim(); load(); }, 250));
  sys.addEventListener('change', () => { f.system = sys.value; load(); });
  load();
}

// ---------------- Contraindications / Glossary ----------------
async function contraTab({ panel }) {
  mount(panel, skeleton(4));
  let list; try { list = await getList('/catalog/contraindications'); } catch (err) { mount(panel, errorPanel(err)); return; }
  const col = (kind, tone) => card({ title: t(`intake.${kind}`), icon: kind === 'absolute' ? 'alert' : 'info', cls: `contra-card is-${kind}`, sub: t(`intake.${kind}Hint`),
    children: [el(`ul.contra-list${kind === 'absolute' ? '.is-absolute' : ''}`, list.filter((c) => c.kind === kind).map((c) => el('li', locNode(c.text), c.source ? el('span.cite', ` ${c.source.doc} p.${c.source.page}`) : null)))] });
  mount(panel, el('div.grid-2.contra-cols', col('absolute'), col('relative')));
}
async function glossaryTab({ panel }) {
  mount(panel, skeleton(4));
  let gl; let recs;
  try { [gl, recs] = await Promise.all([getList('/catalog/glossary'), getList('/catalog/recommendations')]); } catch (err) { mount(panel, errorPanel(err)); return; }
  mount(panel, el('div.grid-2',
    card({ title: t('catalog.abbreviations'), icon: 'book', children: [el('dl.dl.glossary', gl.map((g) => [el('dt', el('abbr', g.abbr)), el('dd', locNode(g.meaning))]))] }),
    card({ title: t('catalog.generalRecs'), icon: 'heart', children: recs.map((r) => el('div.rec-block', el('h3.rec-title', locNode(r.title)), el('p', locNode(r.body)))) })));
}

// ---------------- Printable protocol card ----------------
export async function renderProtocolCard({ main, params }) {
  mount(main, el('div.page', skeleton(8)));
  let core; let proto;
  try { [core, proto] = await Promise.all([loadCore(), getProtocol(params.id)]); } catch (err) { mount(main, el('div.page', errorPanel(err))); return null; }
  const ids = protocolPairIds(proto);
  const pairs = ids.map((id) => core.pairs.get(id)).filter(Boolean);
  const sidesFor = (p) => {
    const same = p.tracking.point === p.impact.point && core.points.get(p.tracking.point)?.laterality === 'bilateral';
    const m = (s, w) => (s === 'RL' ? (same ? (w === 't' ? 'R' : 'L') : 'R') : s || 'C');
    return { t: m(p.tracking.side, 't'), i: m(p.impact.side, 'i') };
  };
  const magnets = pairs.flatMap((p) => { const s = sidesFor(p); return [
    { id: `${p.id}-n`, pointId: p.tracking.point, side: s.t, polarity: 'negative' },
    { id: `${p.id}-p`, pointId: p.impact.point, side: s.i, polarity: 'positive' }]; });
  const isBack = (p) => core.points.get(p.tracking.point)?.view === 'posterior';
  const details = await Promise.all(pairs.map((p) => getPair(p.id).catch(() => p)));
  // v1.1 application protocols carry a per-item label (e.g. "Detoxification"); otherwise use the relations.
  const itemLabel = new Map((proto.items || []).filter((i) => i.pair && i.label).map((i) => [i.pair, i.label]));
  const label = (p, d) => el('li.pc-label',
    el('p.pc-pair', el('span.pc-neg', locText(core.points.get(p.tracking.point)?.name) || p.tracking.point), ' – ', el('span.pc-pos', locText(core.points.get(p.impact.point)?.name) || p.impact.point)),
    itemLabel.has(p.id) ? el('p.pc-rel', locText(itemLabel.get(p.id)))
      : d.relations && d.relations.length ? el('p.pc-rel', d.relations.slice(0, 2).map((r) => locText((r.entity && r.entity.name) || r.name)).join(' · ')) : null);
  const dose = (k) => {
    const d = proto.dosage && proto.dosage[k]; if (!d) return null;
    const mins = Array.isArray(d.minutes) ? d.minutes.join('–') : d.minutes;
    return el('p', t(`catalog.dosage.${k}`, { min: mins, freq: d.frequency ? locText(d.frequency) : '' }));
  };
  const recBlock = proto.dosage ? el('div.pc-rec', el('p.pc-rec-title', `${t('catalog.recommendation')}:`), dose('acute'), dose('chronic'))
    : proto.recommendation ? el('div.pc-rec', el('p.pc-rec-title', `${t('catalog.recommendation')}:`), el('p', locNode(proto.recommendation))) : el('div');
  const notes = (proto.notes || []).map((n) => locText(n)).filter(Boolean);
  const front = el('figure.pc-fig', el('div.pc-img', skeleton(6)), el('figcaption.sr-only', t('viewer.views.anterior')));
  const back = el('figure.pc-fig', el('div.pc-img', skeleton(6)), el('figcaption.sr-only', t('viewer.views.posterior')));
  const sheet = el('article.protocol-card',
    el('header.pc-title', el('h2', locText(proto.name))),
    el('div.pc-body',
      el('ul.pc-labels.pc-left', pairs.map((p, i) => (isBack(p) ? null : label(p, details[i])))),
      front, back,
      el('ul.pc-labels.pc-right', pairs.map((p, i) => (isBack(p) ? label(p, details[i]) : null)))),
    el('footer.pc-foot',
      recBlock,
      el('div.pc-legend', el('span.legend-item', el('span.mag.mag-neg', '−'), t('polarity.trackingNeg')), el('span.legend-item', el('span.mag.mag-pos', '+'), t('polarity.impactPos'))),
      el('div.pc-important', el('p.pc-imp-title', t('catalog.important')), notes.length ? notes.map((n) => el('p', n)) : el('p', t('catalog.importantBody')))),
    el('p.pc-source', sourceCite(proto.source)));
  mount(main, el('div.page.page-card',
    el('div.no-print', pageHeader({ title: locText(proto.name), subtitle: t('catalog.cardSub'), back: { href: `#/catalog/protocols?open=${encodeURIComponent(proto.id)}`, label: t('catalog.tab.protocols') },
      actions: [el('button.btn.btn-primary', { type: 'button', onClick: () => window.print() }, icon('print', { size: 18 }), t('report.print'))] })),
    sheet));
  document.body.classList.add('print-landscape');
  const { renderSnapshots } = await import('../bodymap/host.js'); // only the protocol card needs the body renderer
  const snaps = await renderSnapshots({ points: core.pointList, regions: core.regions, polarity: polarity(), locale: getLocale(), magnets, width: 1000, height: 1200 });
  for (const [fig, v] of [[front, 'anterior'], [back, 'posterior']]) {
    const box = fig.querySelector('.pc-img');
    mount(box, snaps && snaps[v] ? el('img', { src: snaps[v], alt: t('catalog.cardImgAlt', { view: t(`viewer.views.${v}`), name: locText(proto.name) }) }) : el('p.muted', t('viewer.unavailable')));
  }
  return () => document.body.classList.remove('print-landscape');
}

