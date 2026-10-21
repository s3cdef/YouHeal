// Clinical report (CONTRACT §8): print-perfect US Letter, running header/footer via @page margin boxes.
import { el, mount } from '../ui/dom.js';
import { icon, brandMark } from '../ui/icons.js';
import { api, errorMessage } from '../api.js';
import { t, locText, locNode, fmtDate, fmtDateTime, ageFrom, getLocale, loc } from '../i18n.js';
import { loadCore, polarity, can } from '../state.js';
import { categoryChip, ratingsRow, skeleton, statusBadge, alertBox } from '../ui/components.js';
import { renderSnapshots } from '../bodymap/host.js';
import { fullName, errorPanel, methodologyLabel } from './common.js';
import { toast } from '../ui/toast.js';

const CAT_ORDER = ['virus', 'bacteria', 'fungus', 'parasite', 'prion', 'dysfunctional', 'glandular-dysfunction', 'psychoemotional', 'reservoir', 'complex', 'special', 'temporary'];

function cssString(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`; }
const PAGE_VARS = ['--rpt-head-left', '--rpt-head-right', '--rpt-foot-left', '--rpt-page', '--rpt-of'];

export async function renderReport({ main, params }) {
  mount(main, el('div.page', skeleton(10)));
  let rep; let core;
  try { [rep, core] = await Promise.all([api.get(`/sessions/${encodeURIComponent(params.id)}/report`), loadCore()]); } catch (err) { mount(main, el('div.page', errorPanel(err, () => renderReport({ main, params })))); return null; }

  const isFinal = rep.status === 'final' || rep.status === 'amended';
  const org = rep.org || {};
  const pt = rep.patient || {};
  const sess = rep.session || {};
  const printed = new Date();
  const hash16 = rep.hash ? rep.hash.slice(0, 16) : null;
  const statusLabel = t(`report.status.${rep.status}`);

  // running header/footer (Chromium @page margin boxes read these variables)
  const rs = document.documentElement.style;
  rs.setProperty('--rpt-head-left', cssString(`${org.name || 'YOU HEAL'} · ${t('report.title')}`));
  rs.setProperty('--rpt-head-right', cssString(`${fullName(pt)} · ${rep.reportId || ''} · ${statusLabel}`));
  rs.setProperty('--rpt-foot-left', cssString(`${hash16 ? `${t('report.hash')} ${hash16}` : t('report.notFinalShort')} · ${t('report.printed')} ${fmtDateTime(printed.toISOString())}`));
  rs.setProperty('--rpt-page', cssString(`${t('report.page')} `));
  rs.setProperty('--rpt-of', cssString(` ${t('report.of')} `));
  document.body.classList.add('printing-report');

  const age = ageFrom(pt.dob, sess.startedAt ? new Date(sess.startedAt) : new Date());
  const kv = (label, value, cls = '') => el(`div.kv${cls ? '.' + cls : ''}`, el('span.kv-k', label), el('span.kv-v', value || '—'));

  // ---------- header ----------
  const logo = org.logo ? el('img.rpt-logo', { src: org.logo, alt: org.name || '' }) : el('span.rpt-logo-mark', brandMark(40));
  const header = el('header.rpt-header',
    el('div.rpt-org', logo,
      el('div',
        el('p.rpt-org-name', org.name || 'YOU HEAL'),
        el('p.rpt-org-line', [org.address].filter(Boolean).join('')),
        el('p.rpt-org-line', [org.phone, org.email, org.website].filter(Boolean).join(' · ')),
        org.license ? el('p.rpt-org-line', `${t('report.license')} ${org.license}`) : null)),
    el('div.rpt-title-block',
      el('h1.rpt-title', { tabindex: '-1' }, t('report.title')),
      el('p.rpt-id', el('span.kv-k', t('report.reportId')), ' ', el('strong.mono', rep.reportId || '—')),
      el('p', el(`span.rpt-status.is-${rep.status}`, statusLabel), rep.revision > 1 ? el('span.rpt-rev', ` ${t('report.revision', { n: rep.revision })}`) : null)));

  // ---------- patient + session blocks ----------
  const blocks = el('section.rpt-blocks',
    el('div.rpt-block', el('h2.rpt-block-title', t('report.patient')),
      el('div.kv-grid',
        kv(t('patient.name'), fullName(pt), 'kv-wide'),
        kv(t('patient.dob'), fmtDate(pt.dob)),
        kv(t('report.age'), age !== null ? t('patient.ageYears', { age }) : '—'),
        kv(t('patient.sex'), pt.sex ? t(`sex.${pt.sex}`) : '—'),
        kv(t('patient.mrn'), pt.mrn))),
    el('div.rpt-block', el('h2.rpt-block-title', t('report.session')),
      el('div.kv-grid',
        kv(t('report.dateTime'), fmtDateTime(sess.startedAt), 'kv-wide'),
        kv(t('session.methodology'), methodologyLabel(sess.methodology)),
        kv(t('report.practitioner'), rep.practitioner?.name),
        kv(t('report.protocols'), (sess.protocols || []).map((p) => locText(p.name)).join(', ') || t('report.freeScan'), 'kv-wide'),
        sess.chiefComplaint ? kv(t('session.chiefComplaint'), sess.chiefComplaint, 'kv-wide') : null)));

  // ---------- results table grouped by category ----------
  const findings = rep.findings || [];
  const groups = new Map();
  for (const f of findings) { const c = f.pair?.category || 'other'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(f); }
  const cats = [...groups.keys()].sort((a, b) => (CAT_ORDER.indexOf(a) + 99) % 199 - (CAT_ORDER.indexOf(b) + 99) % 199);
  const sideTxt = (s) => (s && s !== 'C' ? ` (${t(`side.${s}short`)})` : '');
  const ptName = (p) => (p ? locText(p.name) : '—');
  const results = el('section.rpt-section.rpt-results',
    el('h2.rpt-h2', t('report.results'), el('span.rpt-h2-meta', t('report.resultsCount', { count: findings.length }))),
    findings.length ? el('table.rpt-table',
      el('caption.sr-only', t('report.results')),
      el('thead', el('tr',
        el('th.num', { scope: 'col' }, '#'),
        el('th', { scope: 'col' }, t('report.colPair')),
        el('th', { scope: 'col' }, el('span.th-pole', el('span.mag.mag-neg.mag-xs', '−'), t('report.colTracking'))),
        el('th', { scope: 'col' }, el('span.th-pole', el('span.mag.mag-pos.mag-xs', '+'), t('report.colImpact'))),
        el('th', { scope: 'col' }, t('pair.relatedTo')),
        el('th', { scope: 'col' }, 'F/P/R'),
        el('th', { scope: 'col' }, t('session.status')),
        el('th.num', { scope: 'col' }, t('report.colDwell')))),
      cats.map((c) => el('tbody.rpt-group',
        el('tr.rpt-group-row', el('th', { colspan: 8, scope: 'colgroup' }, c === 'other' ? t('report.uncategorized') : t(`category.${c}`), el('span.rpt-group-n', ` · ${groups.get(c).length}`))),
        groups.get(c).map((f) => el('tr',
          el('td.num', String(f.n)),
          el('td', el('span.rpt-pair', f.pair ? el('span.rpt-pairnum', `PB ${f.pair.number}`) : null, f.pair ? locNode(f.pair.name) : `${ptName(f.trackingPoint)} – ${ptName(f.impactPoint)}`),
            (f.phenomena || []).length || (f.qualifiers || []).length ? el('span.rpt-flags', [...(f.qualifiers || []).map((q) => t(`qualifier.${q}`)), ...(f.phenomena || []).map((p) => t(`phenomena.${p}`))].map((x) => el('span.rpt-flag', x))) : null,
            f.notes ? el('span.rpt-note', f.notes) : null),
          el('td', ptName(f.trackingPoint), sideTxt(f.trackingSide)),
          el('td', ptName(f.impactPoint), sideTxt(f.impactSide)),
          el('td.rpt-rel', (f.pair?.relations || []).map((r) => `${locText(r.entity?.name || r.name)}${r.ordinal ? ` (${r.ordinal})` : ''}`).join(', ') || '—'),
          el('td', f.pair ? ratingsRow(f.pair.ratings) : '—'),
          el('td', el(`span.rpt-state.state-${f.status}`, t(`state.${f.status}`))),
          el('td.num', f.dwellMinutes ? t('report.min', { n: f.dwellMinutes }) : '—')))))) : el('p.rpt-empty', t('report.noFindings')),
    el('p.rpt-legend', t('report.legend')));

  // ---------- body maps ----------
  const front = el('div.rpt-map-img', skeleton(4));
  const back = el('div.rpt-map-img', skeleton(4));
  const maps = el('section.rpt-section.rpt-maps',
    el('h2.rpt-h2', t('report.bodyMaps')),
    el('div.rpt-map-row',
      el('figure.rpt-map', front, el('figcaption', t('viewer.views.anterior'))),
      el('figure.rpt-map', back, el('figcaption', t('viewer.views.posterior'))),
      el('div.rpt-map-key',
        el('p', el('span.mag.mag-neg', '−'), ' ', t('polarity.trackingNeg')),
        el('p', el('span.mag.mag-pos', '+'), ' ', t('polarity.impactPos')),
        el('p.muted', t('report.mapKey')))));

  // ---------- symptoms / recommendations / follow-up ----------
  const syms = rep.symptoms || [];
  const symptoms = el('section.rpt-section.rpt-keep',
    el('h2.rpt-h2', t('report.symptoms')),
    syms.length || rep.symptomsText ? el('div',
      syms.length ? el('ul.rpt-sym', syms.map((s) => el('li', locNode(s.name), el('span.muted', ` · ${t(`system.${s.system}`)}`)))) : null,
      rep.symptomsText ? el('p.rpt-free', rep.symptomsText) : null) : el('p.muted', t('report.noSymptoms')));
  const pairRecs = (rep.recommendations && rep.recommendations.pairs) || [];
  const genRecs = (rep.recommendations && rep.recommendations.general) || [];
  const recommendations = el('section.rpt-section',
    el('h2.rpt-h2', t('report.recommendations')),
    pairRecs.length ? el('div.rpt-recs', el('h3.rpt-h3', t('report.pairSpecific')), el('ul', pairRecs.map((r) => el('li', el('strong', `${locText(r.pairName)}: `), locNode(r.text))))) : null,
    genRecs.length ? el('div.rpt-recs', el('h3.rpt-h3', t('report.general')), el('ul', genRecs.map((r) => el('li', el('strong', `${locText(r.title)}: `), locNode(r.body))))) : null);
  const follow = el('section.rpt-section.rpt-keep.rpt-follow',
    el('h2.rpt-h2', t('report.followUp')),
    el('p', el('strong', fmtDate(rep.followUpDate, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })), ' — ', t('report.followUpNote')));

  // ---------- signature / attestation ----------
  const sig = rep.signature;
  const signature = el('section.rpt-section.rpt-keep.rpt-sign',
    el('h2.rpt-h2', t('report.attestation')),
    el('p', t('report.attestationText')),
    el('div.rpt-sign-row',
      el('div.rpt-sign-box', el('p.rpt-sign-name', sig ? sig.name : ' '), el('p.rpt-sign-line', t('report.signature'))),
      el('div.rpt-sign-box', el('p.rpt-sign-name', sig ? fmtDateTime(sig.signedAt) : ' '), el('p.rpt-sign-line', t('report.signedOn')))),
    sig ? el('p.muted.small', t('report.esigned', { name: sig.name, date: fmtDateTime(sig.signedAt) })) : el('p.rpt-unsigned', t('report.unsigned')),
    rep.amendReason ? el('p.small', el('strong', `${t('report.amendReason')}: `), rep.amendReason) : null);

  const disclaimerText = loc(rep.disclaimer || {}).text || t('report.disclaimer');
  const disclaimer = el('section.rpt-disclaimer.rpt-keep', el('p.rpt-disc-title', t('report.scopeTitle')), el('p', t('report.disclaimer')),
    getLocale() !== 'en' && rep.disclaimer && disclaimerText !== t('report.disclaimer') ? el('p.muted.small', disclaimerText) : null);
  const footer = el('footer.rpt-footer',
    el('span', org.reportFooter || `${org.name || 'YOU HEAL'}${org.phone ? ' · ' + org.phone : ''}`),
    el('span.mono', hash16 ? `${t('report.hash')} ${hash16}` : t('report.notFinalShort')),
    el('span', `${t('report.printed')} ${fmtDateTime(printed.toISOString())}`));

  const watermark = !isFinal ? el('div.rpt-watermark', { aria: { hidden: 'true' } }, t('report.watermark')) : null;
  const paper = el('article.report', { aria: { label: t('report.title') } }, watermark,
    !isFinal ? el('div.rpt-draft-banner', icon('alert', { size: 16 }), t('report.draftBanner')) : null,
    header, blocks, results, maps,
    el('div.rpt-two', symptoms, follow),
    recommendations, signature, disclaimer, footer);

  const toolbar = el('div.report-toolbar.no-print',
    el('a.btn.btn-ghost', { href: rep.status === 'draft' ? `#/sessions/${params.id}` : `#/patients/${pt.id}/reports` }, icon('arrowLeft', { size: 18 }), t('common.back')),
    el('div.report-toolbar-mid', statusBadge(rep.status), hash16 ? el('span.mono.muted.small', `SHA-256 ${hash16}…`) : null),
    el('button.btn.btn-primary', { type: 'button', onClick: () => window.print() }, icon('print', { size: 18 }), t('report.print')));
  mount(main, el('div.page.page-report', toolbar,
    !isFinal ? alertBox({ tone: 'warn', ic: 'alert', title: t('report.draftTitle'), children: [el('p', t('report.draftBody'))] }) : null,
    el('div.paper-wrap', paper)));

  // ---------- body map images ----------
  (async () => {
    let imgs = rep.images && rep.images.front && rep.images.back ? rep.images : null;
    if (!imgs) {
      const magnets = findings.flatMap((f) => [
        { id: `${f.id}-n`, pointId: f.trackingPoint?.id || f.trackingPoint, side: f.trackingSide, polarity: 'negative', label: String(f.n) },
        { id: `${f.id}-p`, pointId: f.impactPoint?.id || f.impactPoint, side: f.impactSide, polarity: 'positive', label: String(f.n) }]);
      const snaps = await renderSnapshots({ points: core.pointList, regions: core.regions, polarity: polarity(), locale: getLocale(), magnets, width: 800, height: 1100 });
      if (snaps && snaps.anterior && snaps.posterior) {
        imgs = { front: snaps.anterior, back: snaps.posterior };
        if (can.findings()) api.put(`/sessions/${encodeURIComponent(params.id)}/report/images`, imgs).catch((err) => toast(`${t('report.imagesNotSaved')} ${errorMessage(err)}`, { tone: 'warn' }));
      }
    }
    if (!paper.isConnected) return;
    mount(front, imgs ? el('img', { src: imgs.front, alt: t('report.mapAlt', { view: t('viewer.views.anterior') }) }) : el('p.muted', t('viewer.unavailable')));
    mount(back, imgs ? el('img', { src: imgs.back, alt: t('report.mapAlt', { view: t('viewer.views.posterior') }) }) : el('p.muted', t('viewer.unavailable')));
    paper.dataset.ready = 'true';
  })();

  void categoryChip; void core;
  return () => { for (const v of PAGE_VARS) rs.removeProperty(v); document.body.classList.remove('printing-report'); };
}
