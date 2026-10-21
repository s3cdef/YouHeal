// Recovery-codes display shared by MFA enrollment and "Regenerate recovery codes":
// list + copy + print + mandatory "I have saved them" acknowledgement.
import { el } from './dom.js';
import { icon } from './icons.js';
import { alertBox } from './components.js';
import { toast } from './toast.js';
import { t } from '../i18n.js';

/** Print only the codes: a temporary sheet is the sole visible child of <body> while printing. */
function printCodes(codes, email) {
  const sheet = el('div.recovery-print-sheet',
    el('p.recovery-print-title', 'YOU HEAL Clinical — ', t('mfa.recoveryTitle')),
    email ? el('p', email) : null,
    el('p', new Date().toLocaleString()),
    el('ol.recovery-codes', codes.map((c) => el('li', el('code', c)))),
    el('p.small', t('mfa.recoveryWarn')));
  document.body.append(sheet);
  document.body.classList.add('print-recovery');
  const done = () => { document.body.classList.remove('print-recovery'); sheet.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * recoveryCodesBlock(codes, { email, doneLabel, onDone }) → element.
 * The done button stays disabled until the user confirms the codes were saved.
 */
export function recoveryCodesBlock(codes, { email = '', doneLabel = null, onDone = () => {} } = {}) {
  const ack = el('input', { type: 'checkbox', id: `ack-codes-${Math.random().toString(36).slice(2, 8)}` });
  const done = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', disabled: true }, doneLabel || t('common.continue'));
  ack.addEventListener('change', () => { done.disabled = !ack.checked; });
  done.addEventListener('click', () => onDone());
  const copy = el('button.btn.btn-secondary', { type: 'button' }, icon('copy', { size: 18 }), t('mfa.copyCodes'));
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast(t('common.copied'), { tone: 'success' }); } catch { toast(t('common.copyFailed'), { tone: 'warn' }); }
  });
  const print = el('button.btn.btn-secondary', { type: 'button' }, icon('print', { size: 18 }), t('common.print'));
  print.addEventListener('click', () => printCodes(codes, email));
  return el('div.recovery-block.stack',
    alertBox({ tone: 'warn', children: [el('p', t('mfa.recoveryWarn'))] }),
    el('ol.recovery-codes', { aria: { label: t('mfa.recoveryTitle') } }, codes.map((c) => el('li', el('code', c)))),
    el('div.btn-row', copy, print),
    el('label.check', { for: ack.id }, ack, el('span', t('mfa.savedAck'))),
    el('div.form-actions', done));
}
