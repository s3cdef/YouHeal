// "Start scan" flow: contraindication gate (absolute = blocking) → new-session dialog → workspace.
import { el, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { combobox } from '../ui/combobox.js';
import { api, items, errorMessage } from '../api.js';
import { t, locNode, locText, fmtDate } from '../i18n.js';
import { navigate } from '../router.js';
import { loadCore, getList } from '../state.js';
import { openModal } from '../ui/modal.js';
import { segmented, field, textarea, alertBox } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { fullName } from './common.js';

export const METHODOLOGIES = ['biomagnetism', 'bioenergetics', 'telebioenergetics'];
export const PROTOCOL_KINDS = ['basic', 'top10', 'top5', 'disease', 'application'];

export async function latestConsent(patientId) {
  try { const list = items(await api.get(`/patients/${encodeURIComponent(patientId)}/consents`)); return list[0] || null; } catch { return null; }
}

export async function startScan(patient, { followUpOf = null } = {}) {
  const consent = await latestConsent(patient.id);
  const absolute = (consent && consent.contraindications && consent.contraindications.absolute) || [];
  if (absolute.length) {
    const all = await getList('/catalog/contraindications').catch(() => []);
    const byId = new Map(all.map((c) => [c.id, c]));
    const m = openModal({
      title: t('scanStart.blockedTitle'), icon: 'alert', tone: 'danger', size: 'md',
      body: el('div.stack',
        el('p', t('scanStart.blockedBody', { name: fullName(patient) })),
        el('ul.contra-list.is-absolute', absolute.map((id) => el('li', byId.has(id) ? locNode(byId.get(id).text) : id))),
        el('p.muted', t('scanStart.blockedHint', { date: fmtDate(consent.signedAt || consent.createdAt) }))),
      actions: [
        { label: t('common.close'), value: null, variant: 'ghost' },
        { label: t('scanStart.reviewIntake'), value: 'intake', variant: 'primary', autofocus: true },
      ],
    });
    if ((await m.result) === 'intake') navigate(`/patients/${patient.id}/intake`);
    return null;
  }
  if (!consent) {
    const m = openModal({
      title: t('scanStart.noIntakeTitle'), icon: 'clipboard', tone: 'warn',
      body: el('p', t('scanStart.noIntakeBody')),
      actions: [
        { label: t('common.cancel'), value: null, variant: 'ghost' },
        { label: t('scanStart.completeIntake'), value: 'intake', variant: 'primary', autofocus: true },
      ],
    });
    if ((await m.result) === 'intake') navigate(`/patients/${patient.id}/intake`);
    return null;
  }
  return newSessionDialog(patient, { consent, followUpOf });
}

async function newSessionDialog(patient, { consent, followUpOf }) {
  let core;
  try { core = await loadCore(); } catch (err) { toast(errorMessage(err), { tone: 'error' }); return null; }
  let methodology = 'biomagnetism';
  const relative = (consent && consent.contraindications && consent.contraindications.relative) || [];
  const chief = textarea({ rows: 2, placeholder: t('scanStart.chiefPlaceholder') });
  if (followUpOf && followUpOf.chiefComplaint) chief.value = t('scanStart.followUpPrefix', { text: followUpOf.chiefComplaint });
  const chosen = new Set(followUpOf ? (followUpOf.protocolIds || []) : []);
  const chosenEl = el('div.chosen-protocols', { aria: { live: 'polite' } });
  const renderChosen = () => {
    mount(chosenEl, chosen.size ? [...chosen].map((id) => {
      const p = core.protocols.find((x) => x.id === id); const name = p ? locText(p.name) : id;
      return el('span.chip.tone-teal.chip-removable', el('span', name), el('button.chip-x', { type: 'button', aria: { label: t('common.removeX', { x: name }) }, onClick: () => { chosen.delete(id); renderChosen(); } }, icon('x', { size: 14 })));
    }) : el('p.muted.small', t('scanStart.noProtocols')));
  };
  renderChosen();
  const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const protoSearch = combobox({
    label: t('scanStart.protocols'), placeholder: t('scan.searchProtocols', { count: core.protocols.length }), iconName: 'list', minChars: 0,
    source: async (q) => core.protocols.filter((p) => !chosen.has(p.id) && (!q || nrm(`${p.name.en || ''} ${p.name.es || ''}`).includes(nrm(q))))
      .sort((x, y) => PROTOCOL_KINDS.indexOf(x.kind) - PROTOCOL_KINDS.indexOf(y.kind) || locText(x.name).localeCompare(locText(y.name)))
      .slice(0, 30).map((p) => ({ id: p.id, label: locText(p.name), sublabel: `${t(`protocolKind.${p.kind}`)}${p.count ? ' · ' + t('catalog.pairsCount', { count: p.count }) : ''}` })),
    onSelect: (it) => { chosen.add(it.id); renderChosen(); },
  });
  protoSearch.input.addEventListener('focus', () => { if (!protoSearch.input.value) protoSearch.input.dispatchEvent(new Event('input')); });
  const protoList = el('div.proto-pick', protoSearch.root, chosenEl);
  const seg = segmented({ name: 'methodology', label: t('scanStart.methodology'), value: methodology, options: METHODOLOGIES.map((m) => ({ value: m, label: t(`methodology.${m}`) })), onChange: (v) => { methodology = v; } });
  const m = openModal({
    title: t('scanStart.title', { name: fullName(patient) }), icon: 'magnet', size: 'lg',
    body: el('div.stack',
      relative.length ? alertBox({ tone: 'warn', title: t('scanStart.relativeTitle'), children: [el('p', t('scanStart.relativeBody', { count: relative.length }))] }) : null,
      el('div.field', el('span.label', { id: 'meth-label' }, t('scanStart.methodology')), seg),
      field({ label: t('session.chiefComplaint'), input: chief, optional: true }),
      el('div.field', el('span.label', t('scanStart.protocols')), el('p.field-hint', t('scanStart.protocolsHint')), protoList)),
    actions: [
      { label: t('common.cancel'), value: null, variant: 'ghost' },
      { label: t('scanStart.begin'), value: 'go', variant: 'primary', icon: 'play', onClick: async () => {
        try {
          const s = await api.post(`/patients/${encodeURIComponent(patient.id)}/sessions`, { methodology, protocolIds: [...chosen], chiefComplaint: chief.value.trim(), symptoms: [] });
          m.created = s;
          return true;
        } catch (err) {
          if (err.code === 'CONSENT_REQUIRED') { m.needsConsent = true; toast(t('scanStart.consentRequired'), { tone: 'warn' }); return true; }
          toast(errorMessage(err), { tone: 'error' }); return false;
        }
      } },
    ],
  });
  const v = await m.result;
  if (m.needsConsent) { navigate(`/patients/${patient.id}/intake`); return null; }
  if (v === 'go' && m.created) { navigate(`/sessions/${m.created.id}`); return m.created; }
  return null;
}
