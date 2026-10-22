// Toasts announced via an aria-live region. Errors use role=alert.
import { el } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

let region = null;
function ensureRegion() {
  if (region && region.isConnected) return region;
  region = el('div.toast-region', { aria: { live: 'polite', relevant: 'additions' } });
  document.body.append(region);
  return region;
}

const ICON = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

/** toast(message, { tone, action:{label,onClick}, timeout }) */
export function toast(message, { tone = 'info', action = null, timeout = null } = {}) {
  const r = ensureRegion();
  const node = el(`div.toast.toast-${tone}`, { role: tone === 'error' ? 'alert' : 'status' },
    el('span.toast-icon', icon(ICON[tone] || 'info', { size: 18 })),
    el('span.toast-msg', message),
  );
  const close = () => { node.classList.add('is-leaving'); setTimeout(() => node.remove(), 180); };
  if (action) node.append(el('button.btn.btn-sm.btn-ghost.toast-action', { type: 'button', onClick: () => { close(); action.onClick(); } }, action.label));
  node.append(el('button.icon-btn.icon-btn-sm.toast-close', { type: 'button', aria: { label: t('common.dismiss') }, onClick: close }, icon('x', { size: 16 })));
  r.append(node);
  const ms = timeout ?? (tone === 'error' ? 8000 : action ? 7000 : 4000);
  if (ms > 0) setTimeout(close, ms);
  return { close };
}

/** Polite screen-reader-only announcement. */
let srRegion = null;
export function announce(msg) {
  if (!srRegion || !srRegion.isConnected) {
    srRegion = el('div.sr-only', { aria: { live: 'polite' }, role: 'status' });
    document.body.append(srRegion);
  }
  srRegion.textContent = '';
  setTimeout(() => { srRegion.textContent = msg; }, 30);
}
