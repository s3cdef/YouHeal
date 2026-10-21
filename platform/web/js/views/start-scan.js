// "Start scan" flow: contraindication gate (absolute = blocking) → new-session dialog → workspace.
import { el } from '../ui/dom.js';
import { api, items, errorMessage } from '../api.js';
import { t, locNode, fmtDate } from '../i18n.js';
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
        { label: t('scanStart.continueAnyway'), value: 'go', variant: 'ghost' },
        { label: t('scanStart.completeIntake'), value: 'intake', variant: 'primary', autofocus: true },
      ],
    });
    const v = await m.result;
    if (v === 'intake') { navigate(`/patients/${patient.id}/intake`); return null; }
    if (v !== 'go') return null;
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
  const protoList = el('div.proto-pick', PROTOCOL_KINDS.map((kind) => {
    const ps = core.protocols.filter((p) => p.kind === kind);
    if (!ps.length) return null;
    return el('fieldset.proto-group', el('legend', t(`protocolKind.${kind}`)),
      ps.map((p) => {
        const cb = el('input', { type: 'checkbox', value: p.id, checked: chosen.has(p.id) });
        cb.addEventListener('change', () => { if (cb.checked) chosen.add(p.id); else chosen.delete(p.id); });
        return el('label.check.check-card', cb, el('span.check-text', locNode(p.name), p.count ? el('span.muted', ` · ${t('catalog.pairsCount', { count: p.count })}`) : null));
      }));
  }));
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
        } catch (err) { toast(errorMessage(err), { tone: 'error' }); return false; }
      } },
    ],
  });
  const v = await m.result;
  if (v === 'go' && m.created) { navigate(`/sessions/${m.created.id}`); return m.created; }
  return null;
}
