// Pair detail block: relations ("Related to", never "diagnosed"), category, F/P/R, symptoms by system,
// recommendations, protocols, source citation. Shared by the scan drawer and the catalog.
import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { t, locNode, locText } from '../i18n.js';
import { categoryChip, ratingsRow, pairPoles, chip } from '../ui/components.js';

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
    const ent = r.entity && typeof r.entity === 'object' ? r.entity : { id: r.entity, name: r.name || { es: r.entity } };
    return el('li.relation', el('span.rel-name', locNode(ent.name)), r.ordinal ? el('span.rel-ord', { title: t('catalog.ordinal') }, `(${r.ordinal})`) : null,
      ent.classification ? el('span.rel-class', t(`category.${ent.classification}`)) : null);
  }));
}

export function symptomsBySystem(symptoms) {
  if (!symptoms || !symptoms.length) return null;
  const by = new Map();
  for (const s of symptoms) { if (!by.has(s.system)) by.set(s.system, []); by.get(s.system).push(s); }
  return el('div.sym-groups', [...by.entries()].map(([sys, list]) => el('div.sym-group',
    el('p.sym-system', t(`system.${sys}`)),
    el('ul.sym-list', list.map((s) => el('li', locNode(s.text)))))));
}

/** Full detail body for a pair (from GET /catalog/pairs/:id). */
export function pairDetailBody(pair, points, { role = null } = {}) {
  return el('div.pair-detail',
    el('div.pd-head-row',
      pairPoles(pair, points),
      el('div.pd-chips', categoryChip(pair.category), pair.level ? chip(t('catalog.levelN', { n: pair.level }), 'slate') : null, role ? el(`span.role-tag.role-${role}`, role === 'tracking' ? t('pair.roleTracking') : role === 'impact' ? t('pair.roleImpact') : t('pair.roleBoth')) : null)),
    el('div.pd-section',
      el('p.pd-label', t('pair.ratings')),
      ratingsRow(pair.ratings),
      el('p.pd-legend', t('pair.ratingsLegend'))),
    el('div.pd-section',
      el('p.pd-label', t('pair.relatedTo')),
      relationChips(pair.relations)),
    pair.symptoms && pair.symptoms.length ? el('div.pd-section', el('p.pd-label', t('pair.symptoms')), symptomsBySystem(pair.symptoms)) : null,
    pair.recommendations && pair.recommendations.length ? el('div.pd-section', el('p.pd-label', t('pair.recommendations')), el('ul.rec-list', pair.recommendations.map((r) => el('li', locNode(r))))) : null,
    pair.notes && pair.notes.length ? el('div.pd-section', el('p.pd-label', t('pair.notes')), el('ul.rec-list', pair.notes.map((r) => el('li', locNode(r))))) : null,
    pair.protocols && pair.protocols.length ? el('div.pd-section', el('p.pd-label', t('pair.inProtocols')), el('ul.chips-inline', pair.protocols.map((p) => el('li', el('a.chip.tone-slate.chip-link', { href: `#/catalog/protocols?open=${encodeURIComponent(p.id)}` }, locText(p.name)))))) : null,
    sourceCite(pair.source, pair.sourceInfo),
  );
}
