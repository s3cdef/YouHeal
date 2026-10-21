// Accessible typeahead (ARIA 1.2 combobox + listbox, aria-activedescendant).
import { el, nextId, clear, debounce } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

/**
 * combobox({ label, placeholder, source: async q => [{id,label,sublabel,badge,value}], onSelect(item),
 *            onEnterText(q), clearOnSelect=true, minChars=1, id, iconName='search', size })
 * Returns { root, input, focus(), setValue(v), close() }.
 */
export function combobox(opts) {
  const {
    label, placeholder = '', source, onSelect, onEnterText = null, clearOnSelect = true, minChars = 1,
    iconName = 'search', hideLabel = true, size = '', emptyText = null,
  } = opts;
  const inputId = opts.id || nextId('cb');
  const listId = nextId('cb-list');
  let results = [];
  let active = -1;
  let seq = 0;

  const input = el('input.input.combo-input', {
    id: inputId, type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: 'false', placeholder,
    aria: { autocomplete: 'list', expanded: 'false', controls: listId },
  });
  const list = el('ul.combo-list', { id: listId, role: 'listbox', hidden: true, aria: { label } });
  const root = el(`div.combo${size ? '.combo-' + size : ''}`,
    el(`label.label${hideLabel ? '.sr-only' : ''}`, { for: inputId }, label),
    el('div.combo-field', el('span.combo-icon', icon(iconName, { size: 18 })), input),
    list,
  );

  function setActive(i) {
    const opts2 = list.querySelectorAll('[role=option]');
    opts2.forEach((o, idx) => o.setAttribute('aria-selected', idx === i ? 'true' : 'false'));
    active = i;
    if (i >= 0 && opts2[i]) { input.setAttribute('aria-activedescendant', opts2[i].id); opts2[i].scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function open(on) {
    list.hidden = !on;
    input.setAttribute('aria-expanded', on ? 'true' : 'false');
    root.classList.toggle('is-open', on);
  }
  function choose(i) {
    const item = results[i]; if (!item) return;
    if (clearOnSelect) input.value = ''; else input.value = item.label;
    open(false); setActive(-1);
    onSelect && onSelect(item);
  }
  function render(q) {
    clear(list);
    if (!results.length) {
      list.append(el('li.combo-empty', { role: 'presentation' }, emptyText ? emptyText(q) : t('common.noMatches')));
      return;
    }
    results.forEach((item, i) => {
      const li = el('li.combo-option', { id: `${listId}-${i}`, role: 'option', aria: { selected: 'false' } },
        el('span.combo-option-main', el('span.combo-option-label', item.label), item.badge ? item.badge : null),
        item.sublabel ? el('span.combo-option-sub', item.sublabel) : null,
      );
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => choose(i));
      list.append(li);
    });
  }
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < minChars) { results = []; open(false); return; }
    const my = ++seq;
    let r = [];
    try { r = await source(q); } catch { r = []; }
    if (my !== seq) return;
    results = r || [];
    render(q); open(true); setActive(results.length ? 0 : -1);
  }, 160);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (input.value.trim().length >= minChars && results.length) open(true); });
  input.addEventListener('blur', () => setTimeout(() => open(false), 120));
  input.addEventListener('keydown', (e) => {
    const n = results.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) { run(); return; } setActive(n ? (active + 1) % n : -1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(n ? (active - 1 + n) % n : -1); }
    else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0) { e.preventDefault(); choose(active); }
      else if (onEnterText && input.value.trim()) { e.preventDefault(); const v = input.value.trim(); input.value = ''; open(false); onEnterText(v); }
    } else if (e.key === 'Escape') { if (!list.hidden) { e.stopPropagation(); open(false); } }
  });

  return {
    root, input,
    focus: () => input.focus(),
    setValue: (v) => { input.value = v; },
    close: () => open(false),
  };
}
