// Modal dialogs built on native <dialog> (focus containment + inert background for free).
import { el, nextId } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

/**
 * openModal({ title, body, actions:[{label, value, variant, autofocus, onClick}], dismissible, size, icon, tone })
 * action.onClick(dialogApi) may return false (or a Promise resolving false) to keep the dialog open.
 * Returns { dialog, close(value), result: Promise<value> }.
 */
export function openModal({ title, body, actions = [], dismissible = true, size = 'md', icon: iconName = null, tone = null, describedBy = null, labelledExtra = null }) {
  const titleId = nextId('dlg-title');
  const bodyId = nextId('dlg-body');
  let resolve;
  const result = new Promise((r) => { resolve = r; });
  const opener = document.activeElement;

  const footer = el('div.modal-actions');
  const dialog = el(`dialog.modal.modal-${size}${tone ? '.modal-' + tone : ''}`, { aria: { labelledby: titleId, describedby: describedBy || bodyId } },
    el('div.modal-head',
      iconName ? el('span.modal-icon', icon(iconName, { size: 22 })) : null,
      el('h2.modal-title', { id: titleId }, title),
      labelledExtra,
      dismissible ? el('button.icon-btn.modal-close', { type: 'button', aria: { label: t('common.close') }, onClick: () => api.close(null) }, icon('x')) : null,
    ),
    el('div.modal-body', { id: bodyId }, body),
    actions.length ? footer : null,
  );

  const api = {
    dialog,
    close(value) {
      if (!dialog.isConnected) return;
      dialog.close();
      dialog.remove();
      resolve(value);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    },
    setBusy(on) { for (const b of footer.querySelectorAll('button')) b.disabled = !!on; dialog.classList.toggle('is-busy', !!on); },
  };

  for (const a of actions) {
    const b = el(`button.btn.btn-${a.variant || 'secondary'}`, { type: a.submit ? 'submit' : 'button', autofocus: a.autofocus || null, data: { value: a.value } }, a.icon ? icon(a.icon, { size: 18 }) : null, a.label);
    b.addEventListener('click', async () => {
      if (a.onClick) {
        api.setBusy(true);
        let keep = false;
        try { keep = (await a.onClick(api)) === false; } finally { if (dialog.isConnected) api.setBusy(false); }
        if (keep) return;
      }
      api.close(a.value);
    });
    footer.append(b);
  }

  dialog.addEventListener('cancel', (e) => { e.preventDefault(); if (dismissible) api.close(null); });
  if (dismissible) dialog.addEventListener('click', (e) => { if (e.target === dialog) api.close(null); });
  document.body.append(dialog);
  dialog.showModal();
  const af = dialog.querySelector('[autofocus]') || dialog.querySelector('input,select,textarea');
  if (af) af.focus();
  return { ...api, result };
}

export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = false, icon: ic = null }) {
  const m = openModal({
    title, icon: ic || (danger ? 'alert' : null), tone: danger ? 'danger' : null,
    body: typeof message === 'string' ? el('p', message) : message,
    actions: [
      { label: cancelLabel || t('common.cancel'), value: false, variant: 'ghost' },
      { label: confirmLabel || t('common.confirm'), value: true, variant: danger ? 'danger' : 'primary', autofocus: true },
    ],
  });
  return m.result.then((v) => v === true);
}
