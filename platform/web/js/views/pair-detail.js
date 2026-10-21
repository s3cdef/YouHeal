// Pair detail block: relations ("Related to", never "diagnosed"), category, F/P/R, symptoms by system,
// recommendations, protocols, see-also, source citation. Shared by the scan drawer and the catalog.
import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { t, locNode, locText, vocab, loc } from '../i18n.js';
import { categoryChip, ratingsRow, pairPoles, chip, pole } from '../ui/components.js';

export function sourceCite(source, sourceInfo) {
  if (!source) return null;
  const title = sourceInfo ? sourceInfo.title : source.doc;
  return el('p.cite-line', icon('book', { size: 14 }),
    el('span', t('catalog.source'), ': '),
    el('cite', title),
    source.page ? el('span', ` · ${t('catalog.page', { page: source.page })}`) : null,
    sourceInfo && sourceInfo.license_status ? el('span.cite-license', ` · ${t(`license.${sourceInfo.license_status}`)}`) : null);
}

export function relationChips(relations) {
  if (!relations || !relations.length) return el('p.muted', t('catalog.noRelations'));
  return el('ul.relations', relations.map((r) => {
    const ent = r.entity && typeof r.entity === 'object' ? r.entity : { id: r.entity, name: r.name || { es: r.entity }, classification: r.classification, kind: r.kind };
    return el('li.relation', el('span.rel-name', locNode(ent.name)), r.ordinal ? el('span.rel-ord', { title: t('catalog.ordinal') }, `(${r.ordinal})`) : null,
      ent.classification ? el('span.rel-class', vocab('categories', ent.classification)) : ent.kind ? el('span.rel-class', t(`entityKind.${ent.kind}`)) : null);
  }));
}

/** Symptom text: prefer the canonical symptom vocabulary (has `en`) over the pair's es-only text. */
export function symptomText(s, symptoms) {
  const canon = s.symptom && symptoms && symptoms.get(s.symptom);
  if (canon && canon.name && !loc(canon.name).fallback) return canon.name;
  return s.text || (canon && canon.name) || { es: s.symptom || '' };
}

export function symptomsBySystem(list, symptoms) {
  if (!list || !list.length) return null;
  const by = new Map();
  for (const s of list) { if (!by.has(s.system)) by.set(s.system, []); by.get(s.system).push(s); }
  return el('div.sym-groups', [...by.entries()].map(([sys, items]) => el('div.sym-group',
    el('p.sym-system', vocab('systems', sys)),
    el('ul.sym-list', items.map((s) => el('li', locNode(symptomText(s, symptoms))))))));
}

/** Full detail body for a pair (from GET /catalog/pairs/:id). core = { points, pairs, symptoms, protocols } */
export function pairDetailBody(pair, core, { role = null, onOpenPair = null } = {}) {
  const points = core.points;
  const pairLink = (pid) => {
    const p = core.pairs && core.pairs.get(pid);
    const label = p ? `${p.number ? '#' + p.number + ' ' : ''}${locText(p.name)}` : pid;
    return onOpenPair ? el('button.chip.tone-gold.chip-link', { type: 'button', onClick: () => onOpenPair(pid) }, label) : el('a.chip.tone-gold.chip-link', { href: `#/catalog/pairs?open=${encodeURIComponent(pid)}` }, label);
  };
  const protoName = (id) => { const p = core.protocols && core.protocols.find((x) => x.id === id); return p ? locText(p.name) : id; };
  const magnets = Array.isArray(pair.magnets) && pair.magnets.length ? [...pair.magnets].sort((a, b) => (a.order || 0) - (b.order || 0)) : null;
  return el('div.pair-detail',
    el('div.pd-head-row',
      magnets ? el('ol.multi-magnets', { aria: { label: t('pair.magnetSequence') } }, magnets.map((m) => el('li', pole(m.polarity, { small: true }),
        el('span.pp-name', points.get(m.point) ? locText(points.get(m.point).name) : m.point), m.side && m.side !== 'C' ? el('span.side-tag', t(`side.${m.side}short`)) : null)))
        : pairPoles(pair, points),
      el('div.pd-chips', categoryChip(pair.category), pair.level ? chip(t('catalog.levelN', { n: pair.level }), 'slate') : chip(t('catalog.compendium'), 'slate'),
        magnets ? chip(t('pair.multiMagnet', { n: magnets.length }), 'violet') : null,
        role ? el(`span.role-tag.role-${role}`, role === 'tracking' ? t('pair.roleTracking') : role === 'impact' ? t('pair.roleImpact') : t('pair.roleBoth')) : null),
      pair.altNames && pair.altNames.length ? el('p.pd-alt', `${t('pair.altNames')}: `, pair.altNames.map((n) => locText(n)).join(' · ')) : null),
    el('div.pd-section',
      el('p.pd-label', t('pair.ratings')),
      ratingsRow(pair.ratings),
      el('p.pd-legend', t('pair.ratingsLegend'))),
    el('div.pd-section',
      el('p.pd-label', t('pair.relatedTo')),
      relationChips(pair.relations)),
    pair.symptoms && pair.symptoms.length ? el('div.pd-section', el('p.pd-label', t('pair.symptoms')), symptomsBySystem(pair.symptoms, core.symptoms)) : null,
    pair.recommendations && pair.recommendations.length ? el('div.pd-section', el('p.pd-label', t('pair.recommendations')), el('ul.rec-list', pair.recommendations.map((r) => el('li', locNode(r))))) : null,
    pair.notes && pair.notes.length ? el('div.pd-section', el('p.pd-label', t('pair.notes')), el('ul.rec-list', pair.notes.map((r) => el('li', locNode(r))))) : null,
    pair.variants && pair.variants.length ? el('div.pd-section', el('p.pd-label', t('pair.variants')), el('ul.rec-list', pair.variants.map((v) => el('li', typeof v === 'string' ? v : v.name ? locNode(v.name) : v.pairId ? pairLink(v.pairId) : JSON.stringify(v))))) : null,
    pair.samePoints && pair.samePoints.length ? el('div.pd-section', el('p.pd-label', t('pair.seeAlso')), el('p.pd-legend', t('pair.seeAlsoHint')), el('ul.chips-inline', pair.samePoints.map((pid) => el('li', pairLink(pid))))) : null,
    pair.protocols && pair.protocols.length ? el('div.pd-section', el('p.pd-label', t('pair.inProtocols')), el('ul.chips-inline', pair.protocols.map((p) => el('li', el('a.chip.tone-slate.chip-link', { href: `#/catalog/protocols?open=${encodeURIComponent(p.id)}` }, locText(p.name)))))) : null,
    pair.relatedProtocols && pair.relatedProtocols.length ? el('div.pd-section', el('p.pd-label', t('pair.relatedProtocols')), el('ul.chips-inline', pair.relatedProtocols.map((id) => el('li', el('a.chip.tone-slate.chip-link', { href: `#/catalog/protocols?open=${encodeURIComponent(id)}` }, protoName(id)))))) : null,
    sourceCite(pair.source, pair.sourceInfo),
  );
}
