// Minimal DOM builder. Never uses innerHTML: every string becomes a text node.
// el('button.btn.btn-primary#save', { type:'button', onClick: fn, aria:{label:'x'}, data:{id:1} }, 'Save')

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(node, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class' || k === 'className') {
      for (const c of String(v).split(/\s+/)) if (c) node.classList.add(c);
    } else if (k === 'aria') {
      for (const [ak, av] of Object.entries(v)) if (av !== undefined && av !== null) node.setAttribute(`aria-${ak}`, String(av));
    } else if (k === 'data') {
      for (const [dk, dv] of Object.entries(v)) if (dv !== undefined && dv !== null) node.dataset[dk] = String(dv);
    } else if (k === 'style') {
      // CSSOM assignment is CSP-safe (no style attribute parsing).
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, sv);
        else node.style[sk] = sv;
      }
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'text') {
      node.textContent = String(v);
    } else if (k === 'value' && 'value' in node) {
      node.value = v;
    } else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'required' || k === 'multiple' || k === 'readOnly' || k === 'indeterminate') {
      node[k] = !!v;
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
}

export function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** el('tag.cls#id', props?, ...children) */
export function el(spec, props, ...children) {
  if (props instanceof Node || typeof props === 'string' || typeof props === 'number' || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec);
  const tag = (m && m[1]) || 'div';
  const node = document.createElement(tag);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') node.classList.add(part.slice(1));
      else node.id = part.slice(1);
    }
  }
  applyProps(node, props);
  return append(node, children);
}

export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  return append(node, children);
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

let uid = 0;
export function nextId(prefix = 'yh') { uid += 1; return `${prefix}-${uid}`; }

export function debounce(fn, ms = 250) {
  let tmr;
  const d = (...a) => { clearTimeout(tmr); tmr = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(tmr);
  return d;
}

export function show(node, on = true) { node.hidden = !on; return node; }

/** Trap focus inside a container (for dialogs/drawers). Returns a release fn. */
export function trapFocus(container) {
  const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = $$(sel, container).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}

export function isTypingTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
