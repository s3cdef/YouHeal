// Clinical report (CONTRACT §8) rendered from GET /sessions/:id/report (schema youheal.report/v1).
// Print-perfect US Letter; running header/footer via @page margin boxes fed by CSS custom properties.
import { el, mount } from '../ui/dom.js';
import { icon, brandMark } from '../ui/icons.js';
import { api, errorMessage } from '../api.js';
import { t, locText, locNode, fmtDate, fmtDateTime, getLocale, loc, vocab } from '../i18n.js';
import { loadCore, polarity, can, state } from '../state.js';
import { ratingsRow, skeleton, statusBadge, alertBox } from '../ui/components.js';
import { renderSnapshots } from '../bodymap/host.js';
import { fullName, errorPanel, methodologyLabel } from './common.js';
import { toast } from '../ui/toast.js';

const CAT_ORDER = ['virus', 'bacteria', 'fungus', 'parasite', 'prion', 'dysfunctional', 'glandular-dysfunction', 'psychoemotional', 'reservoir', 'complex', 'special', 'temporary', 'uncatalogued'];
const PAGE_VARS = ['--rpt-head-left', '--rpt-head-right', '--rpt-foot-left', '--rpt-page', '--rpt-of'];
function cssString(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`; }

export async function renderReport({ main, params }) {
  mount(main, el('div.page', skeleton(10)));
  let rep; let core;
  try { [rep, core] = await Promise.all([api.get(`/sessions/${encodeURIComponent(params.id)}/report`), loadCore()]); } catch (err) {
    // Auditors may only open signed (final/amended) reports.
    if (err.status === 403 && !can.clinical()) { mount(main, el('div.page', alertBox({ tone: 'info', ic: 'lock', title: t('report.auditorOnlyFinalTitle'), children: [el('p', t('report.auditorOnlyFinal'))] }), el('a.btn.btn-secondary', { href: '#/settings/audit' }, icon('arrowLeft', { size: 18 }), t('common.back')))); return null; }
    mount(main, el('div.page', errorPanel(err, () => renderReport({ main, params })))); return null;
  }

  const status = String(rep.status || 'DRAFT').toLowerCase(); // draft | final | amended
  const isFinal = status !== 'draft';
  const org = rep.org || state.org || {};
  const pt = rep.patient || {};
  const sess = rep.session || {};
  const pol = { ...polarity(), ...(rep.polarity || {}) };
  const printed = new Date();
  const hashFull = rep.hash ? (typeof rep.hash === 'string' ? rep.hash : rep.hash.sha256) : null;
  const hash16 = rep.hash ? (rep.hash.short || String(hashFull).slice(0, 16)) : null;
  const integrity = rep.integrity || null; // 'verified' | 'mismatch' | null (drafts)
  const statusLabel = t(`report.status.${status}`);
  const reportNo = rep.reportNumber || rep.reportId || '';

  const rs = document.documentElement.style;
  rs.setProperty('--rpt-head-left', cssString(`${org.name || 'YOU HEAL'} · ${t('report.title')}`));
  rs.setProperty('--rpt-head-right', cssString(`${pt.fullName || fullName(pt)} · ${reportNo} · ${statusLabel}`));
  rs.setProperty('--rpt-foot-left', cssString(`${hash16 ? `SHA-256 ${hash16} · ${t(`report.integrity.${integrity || 'none'}`)}` : t('report.notFinalShort')} · ${t('report.printed')} ${fmtDateTime(printed.toISOString())}`));
  rs.setProperty('--rpt-page', cssString(`${t('report.page')} `));
  rs.setProperty('--rpt-of', cssString(` ${t('report.of')} `));
  rs.setProperty('--rpt-neg', pol.negative); rs.setProperty('--rpt-pos', pol.positive);
  document.body.classList.add('printing-report');

  const kv = (label, value, cls = '') => el(`div.kv${cls ? '.' + cls : ''}`, el('span.kv-k', label), el('span.kv-v', value || '—'));

  // ---------- header ----------
  const logo = org.logo ? el('img.rpt-logo', { src: org.logo, alt: org.name || '' }) : el('span.rpt-logo-mark', brandMark(40));
  const header = el('header.rpt-header',
    el('div.rpt-org', logo,
      el('div',
        el('p.rpt-org-name', org.name || 'YOU HEAL'),
        org.legalName && org.legalName !== org.name ? el('p.rpt-org-line', org.legalName) : null,
        org.address ? el('p.rpt-org-line', org.address) : null,
        el('p.rpt-org-line', [org.phone, org.email, org.website].filter(Boolean).join(' · ')),
        org.license ? el('p.rpt-org-line', `${t('report.license')} ${org.license}`) : null)),
    el('div.rpt-title-block',
      el('h1.rpt-title', { tabindex: '-1' }, t('report.title')),
      el('p.rpt-id', el('span.kv-k', t('report.reportId')), ' ', el('strong.mono', reportNo || '—')),
      el('p', el(`span.rpt-status.is-${status}`, statusLabel), rep.revision > 1 ? el('span.rpt-rev', ` ${t('report.revision', { n: rep.revision })}`) : null)));

  // ---------- patient + session ----------
  const protocols = (sess.protocols || []).map((p) => locText(p.name) || p.id).filter(Boolean);
  const blocks = el('section.rpt-blocks',
    el('div.rpt-block', el('h2.rpt-block-title', t('report.patient')),
      el('div.kv-grid',
        kv(t('patient.name'), pt.fullName || fullName(pt), 'kv-wide'),
        kv(t('patient.dob'), fmtDate(pt.dob)),
        kv(t('report.age'), pt.age !== null && pt.age !== undefined ? t('patient.ageYears', { age: pt.age }) : '—'),
        kv(t('patient.sex'), pt.sex ? t(`sex.${pt.sex}`) : '—'),
        kv(t('patient.mrn'), pt.mrn))),
    el('div.rpt-block', el('h2.rpt-block-title', t('report.session')),
      el('div.kv-grid',
        kv(t('report.dateTime'), fmtDateTime(sess.date || sess.startedAt), 'kv-wide'),
        kv(t('session.methodology'), methodologyLabel(sess.methodology)),
        kv(t('report.practitioner'), rep.practitioner?.name),
        kv(t('report.protocols'), protocols.join(', ') || t('report.freeScan'), 'kv-wide'),
        sess.chiefComplaint ? kv(t('session.chiefComplaint'), sess.chiefComplaint, 'kv-wide') : null)));

  // ---------- results table grouped by category ----------
  const findings = rep.findings || [];
  const bySeq = new Map(findings.map((f) => [f.seq, f]));
  let groups = (rep.groups || []).map((g) => ({ category: g.category, items: g.seqs.map((n) => bySeq.get(n)).filter(Boolean) }));
  if (!groups.length && findings.length) {
    const m = new Map(); for (const f of findings) { const c = f.category || 'uncatalogued'; if (!m.has(c)) m.set(c, []); m.get(c).push(f); }
    groups = [...m.entries()].map(([category, its]) => ({ category, items: its }));
  }
  groups.sort((a, b) => (CAT_ORDER.indexOf(a.category) + 99) % 199 - (CAT_ORDER.indexOf(b.category) + 99) % 199);
  const sideTxt = (s) => (s && s !== 'C' ? ` (${t(`side.${s}short`)})` : '');
  const qualTxt = (q) => (q && q.length ? ` ${q.map((x) => t(`qualifier.${x}short`)).join('/')}` : '');
  const endTxt = (e) => `${locText(e?.name) || e?.point || '—'}${sideTxt(e?.side)}${qualTxt(e?.qualifiers)}`;
  const totals = rep.totals || { findings: findings.length, byStatus: {} };
  const results = el('section.rpt-section.rpt-results',
    el('h2.rpt-h2', t('report.results'), el('span.rpt-h2-meta', [t('report.resultsCount', { count: totals.findings ?? findings.length }),
      ...['found', 'impacted', 'cleared'].map((k) => (totals.byStatus && totals.byStatus[k] ? `${t(`state.${k}`)} ${totals.byStatus[k]}` : null))].filter(Boolean).join(' · '))),
    findings.length ? el('table.rpt-table',
      el('caption.sr-only', t('report.results')),
      el('thead', el('tr',
        el('th.num', { scope: 'col' }, '#'),
        el('th', { scope: 'col' }, t('report.colPair')),
        el('th', { scope: 'col' }, el('span.th-pole', el('span.mag.mag-neg.mag-xs.rpt-mag', '−'), t('report.colTracking'))),
        el('th', { scope: 'col' }, el('span.th-pole', el('span.mag.mag-pos.mag-xs.rpt-mag', '+'), t('report.colImpact'))),
        el('th', { scope: 'col' }, t('pair.relatedTo')),
        el('th', { scope: 'col' }, 'F/P/R'),
        el('th', { scope: 'col' }, t('session.status')),
        el('th.num', { scope: 'col' }, t('report.colDwell')))),
      groups.map((g) => el('tbody.rpt-group',
        el('tr.rpt-group-row', el('th', { colspan: 8, scope: 'colgroup' }, g.category === 'uncatalogued' ? t('report.uncategorized') : vocab("categories", g.category), el('span.rpt-group-n', ` · ${g.items.length}`))),
        g.items.map((f) => el('tr',
          el('td.num', String(f.seq ?? '')),
          el('td', el('span.rpt-pair', f.pair && f.pair.number ? el('span.rpt-pairnum', `PB ${f.pair.number}`) : null, f.pair ? locNode(f.pair.name) : `${locText(f.tracking?.name)} – ${locText(f.impact?.name)}`),
            (f.phenomena || []).length ? el('span.rpt-flags', f.phenomena.map((p) => el('span.rpt-flag', t(`phenomena.${p}`)))) : null,
            f.notes ? el('span.rpt-note', f.notes) : null),
          el('td', endTxt(f.tracking)),
          el('td', endTxt(f.impact)),
          el('td.rpt-rel', (f.relatedTo || []).map((r) => `${locText(r.name) || r.entity}${r.ordinal ? ` (${r.ordinal})` : ''}`).join(', ') || '—'),
          el('td', f.ratings && (f.ratings.F || f.ratings.P || f.ratings.R) ? ratingsRow(f.ratings) : '—'),
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
        el('p', el('span.mag.mag-neg.rpt-mag', '−'), ' ', t('polarity.trackingNeg')),
        el('p', el('span.mag.mag-pos.rpt-mag', '+'), ' ', t('polarity.impactPos')),
        el('p.muted', t('report.mapKey')))));

  // ---------- symptoms / follow-up / recommendations ----------
  const syms = sess.symptoms || rep.symptoms || [];
  const symptoms = el('section.rpt-section.rpt-keep',
    el('h2.rpt-h2', t('report.symptoms')),
    syms.length ? el('ul.rpt-sym', syms.map((s) => el('li', s.name ? locNode(s.name) : s.id, s.system ? el('span.muted', ` · ${vocab("systems", s.system)}`) : null))) : el('p.muted', t('report.noSymptoms')));
  const fu = rep.followUp || {};
  const follow = el('section.rpt-section.rpt-keep.rpt-follow',
    el('h2.rpt-h2', t('report.followUp')),
    fu.date ? el('p', el('strong', fmtDate(fu.date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))) : el('p.muted', '—'),
    el('p.small', fu.note ? locText(fu.note) : t('report.followUpNote')));
  // General guidance sections can be pages long in the source guides; the report carries a one-sentence summary.
  const excerpt = (body) => {
    const { text, fallback } = loc(body);
    const first = (text.match(/^.{20,220}?[.!?](\s|$)/) || [text.slice(0, 200)])[0].trim();
    const out = first.length < text.length ? `${first.replace(/[.!?]$/, '')}…` : first;
    const n = el('span', out); if (fallback) { n.lang = 'es'; n.append(' ', el('abbr.badge-es', { title: t('common.untranslated'), lang: 'en' }, 'ES')); }
    return n;
  };
  const pairRecs = (rep.recommendations && (rep.recommendations.pairSpecific || rep.recommendations.pairs)) || [];
  // Server pre-filters general sections to those relevant to the found pairs (CONTRACT §5).
  const genRecs = rep.generalRecommendations || (rep.recommendations && rep.recommendations.general) || [];
  const pairLabel = (pid) => {
    const f = findings.find((x) => x.pairId === pid);
    const p = (f && f.pair) || core.pairs.get(pid);
    return p && p.number ? `PB ${p.number}` : p ? locText(p.name) : pid;
  };
  const matchedNote = (r) => {
    const m = r.matchedBy || [];
    if (m.some((x) => x.rule === 'always')) return t('report.matchedAlways');
    const ids = [...new Set(m.flatMap((x) => x.pairIds || []))];
    return ids.length ? t('report.matchedBy', { pairs: ids.map(pairLabel).join(', ') }) : null;
  };
  const recommendations = el('section.rpt-section',
    el('h2.rpt-h2', t('report.recommendations')),
    pairRecs.length ? el('div.rpt-recs', el('h3.rpt-h3', t('report.pairSpecific')), el('ul', pairRecs.map((r) => el('li',
      el('strong', `${r.number ? `PB ${r.number} ` : ''}${locText(r.name || r.pairName)}: `),
      (r.items || [r.text]).map((txt, i) => [i ? el('span.rpt-sep', ' · ') : null, locNode(txt)]))))) : null,
    genRecs.length ? el('div.rpt-recs.rpt-gen', el('h3.rpt-h3', t('report.general')), el('ul', genRecs.map((r) => {
      const note = matchedNote(r);
      return el('li',
        el('strong', `${locText(r.title)}: `), r.summary ? locNode(r.summary) : excerpt(r.body),
        note ? el('span.rpt-matched', ` (${note})`) : null,
        r.body ? el('details.rpt-gen-body.no-print', el('summary', t('report.showFullText')), el('div.rpt-gen-full', locNode(r.body, 'p'))) : null);
    })),
      el('p.muted.small', t('report.generalNote'))) : null,
    !pairRecs.length && !genRecs.length ? el('p.muted', '—') : null);

  // ---------- attestation ----------
  const att = rep.attestation;
  const signature = el('section.rpt-section.rpt-keep.rpt-sign',
    el('h2.rpt-h2', t('report.attestation')),
    el('p', att && att.statement ? locText(att.statement) : t('report.attestationText')),
    el('div.rpt-sign-row',
      el('div.rpt-sign-box', el('p.rpt-sign-name', att ? att.signatureName : ' '), el('p.rpt-sign-line', t('report.signature'))),
      el('div.rpt-sign-box', el('p.rpt-sign-name.rpt-sign-date', att ? fmtDateTime(att.finalizedAt) : ' '), el('p.rpt-sign-line', t('report.signedOn')))),
    att ? el('p.muted.small', t('report.esigned', { name: att.finalizedBy?.name || att.signatureName, date: fmtDateTime(att.finalizedAt) })) : el('p.rpt-unsigned', t('report.unsigned')),
    rep.amendment ? el('p.small', el('strong', `${t('report.amendReason')}: `), rep.amendment.reason || '—', rep.amendment.parentSha256 ? el('span.muted', ` · ${t('report.supersedes', { rev: rep.amendment.parentRevision, hash: String(rep.amendment.parentSha256).slice(0, 16) })}`) : null) : null);

  const discText = (rep.disclaimer && rep.disclaimer[getLocale()]) || t('report.disclaimer');
  const disclaimer = el('section.rpt-disclaimer.rpt-keep', el('p.rpt-disc-title', t('report.scopeTitle')), el('p', discText),
    rep.terminology ? el('p.small.muted', locText(rep.terminology)) : null);
  const sources = (rep.catalog && rep.catalog.sources) || [];
  const integrityEl = el(`span.rpt-integrity.is-${integrity || 'none'}`, icon(integrity === 'verified' ? 'shield' : integrity === 'mismatch' ? 'alert' : 'info', { size: 12 }), t(`report.integrity.${integrity || 'none'}`));
  const footer = el('footer.rpt-footer',
    el('span', org.reportFooter || `${org.name || 'YOU HEAL'}${org.phone ? ' · ' + org.phone : ''}`),
    el('span.mono', hash16 ? `SHA-256 ${hash16}` : t('report.notFinalShort'), ' ', integrityEl),
    el('span', `${t('report.printed')} ${fmtDateTime(printed.toISOString())}`),
    sources.length ? el('span.rpt-sources', `${t('report.catalogSources')}: ${sources.map((s) => s.title + (s.notice ? ` (${s.notice})` : '')).join('; ')}${rep.catalog.version ? ` · ${t('report.catalogVersion')} ${rep.catalog.version}` : ''}`) : null);

  const watermark = !isFinal ? el('div.rpt-watermark', { aria: { hidden: 'true' } }, t('report.watermark')) : null;
  const superseded = rep.supersededBy ? el('div.rpt-superseded', icon('alert', { size: 16 }), el('span', t('report.supersededBanner')), ' ', el('a.no-print', { href: `#/sessions/${rep.supersededBy}/report` }, t('report.openLatest'))) : null;
  const paper = el('article.report', { aria: { label: t('report.title') } }, watermark,
    superseded,
    !isFinal ? el('div.rpt-draft-banner', icon('alert', { size: 16 }), t('report.draftBanner')) : null,
    integrity === 'mismatch' ? el('div.rpt-superseded.is-danger', icon('alert', { size: 16 }), t('report.integrityMismatch')) : null,
    header, blocks, results, maps,
    el('div.rpt-two', symptoms, follow),
    recommendations, signature, disclaimer, footer);
  paper.style.setProperty('--pol-neg', pol.negative);
  paper.style.setProperty('--pol-pos', pol.positive);

  const back2 = status === 'draft' && can.clinical() ? `#/sessions/${params.id}` : pt.id && can.patients() ? `#/patients/${pt.id}/reports` : '#/settings/audit';
  const toolbar = el('div.report-toolbar.no-print',
    el('a.btn.btn-ghost', { href: back2 }, icon('arrowLeft', { size: 18 }), t('common.back')),
    el('div.report-toolbar-mid', statusBadge(status), hash16 ? el('span.mono.muted.small', `SHA-256 ${hash16}…`) : null, integrity ? el(`span.integrity-pill.is-${integrity}`, icon(integrity === 'verified' ? 'shield' : 'alert', { size: 14 }), t(`report.integrity.${integrity}`)) : null),
    el('button.btn.btn-primary', { type: 'button', onClick: () => window.print() }, icon('print', { size: 18 }), t('report.print')));
  mount(main, el('div.page.page-report', toolbar,
    !isFinal ? alertBox({ tone: 'warn', ic: 'alert', title: t('report.draftTitle'), children: [el('p', t('report.draftBody'))] }) : null,
    el('div.paper-wrap', paper)));

  // ---------- body map images: stored → else render live (and store while still a draft) ----------
  (async () => {
    const stored = (rep.bodyMap && rep.bodyMap.images) || rep.images || {};
    let imgs = stored.front && stored.back ? stored : null;
    if (!imgs) {
      const magnets = (rep.bodyMap && rep.bodyMap.magnets) || findings.flatMap((f) => [
        { id: `${f.seq}-n`, pointId: f.tracking.point, side: f.tracking.side, polarity: 'negative', label: String(f.seq) },
        { id: `${f.seq}-p`, pointId: f.impact.point, side: f.impact.side, polarity: 'positive', label: String(f.seq) }]);
      const snaps = await renderSnapshots({ points: core.pointList, regions: core.regions, polarity: pol, locale: getLocale(), magnets, width: 800, height: 1100 });
      if (snaps && snaps.anterior && snaps.posterior) {
        imgs = { front: snaps.anterior, back: snaps.posterior };
        if (status === 'draft' && can.findings()) api.put(`/sessions/${encodeURIComponent(params.id)}/report/images`, imgs).catch((err) => toast(`${t('report.imagesNotSaved')} ${errorMessage(err)}`, { tone: 'warn' }));
      }
    }
    if (!paper.isConnected) return;
    mount(front, imgs ? el('img', { src: imgs.front, alt: t('report.mapAlt', { view: t('viewer.views.anterior') }) }) : el('p.muted', t('viewer.unavailable')));
    mount(back, imgs ? el('img', { src: imgs.back, alt: t('report.mapAlt', { view: t('viewer.views.posterior') }) }) : el('p.muted', t('viewer.unavailable')));
    paper.dataset.ready = 'true';
  })();

  return () => { for (const v of [...PAGE_VARS, '--rpt-neg', '--rpt-pos']) rs.removeProperty(v); document.body.classList.remove('printing-report'); };
}
