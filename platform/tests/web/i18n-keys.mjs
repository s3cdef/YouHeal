#!/usr/bin/env node
// UI language-pack checks (CONTRACT §9.1/§9.4). Exit code 1 on any problem.
//   node tests/web/i18n-keys.mjs
// 1. Every data/i18n/packs/<locale>/ui.json has the identical key set, non-empty strings, the same {placeholders}
//    per key, and complete .one/.other plural pairs.
// 2. Every literal t('key') used in web/js exists in the packs.
// 3. Heuristic: no hard-coded user-visible English/Spanish text in web/js (outside the 3D viewer, which ships its
//    own en/es strings). Literal strings and template text are scanned; dev-only text (console/Error), CSS,
//    selectors, keyboard key names, brand and technical tokens are allowed (ALLOW below).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKS = path.join(ROOT, 'data/i18n/packs');
const WEBJS = path.join(ROOT, 'web/js');
const problems = [];
const fail = (msg) => problems.push(msg);

// ------------------------------------------------------------------ 1. pack consistency
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

const packs = new Map();
for (const dir of fs.readdirSync(PACKS)) {
  const file = path.join(PACKS, dir, 'ui.json');
  if (!fs.existsSync(file)) continue;
  try { packs.set(dir, flatten(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch (e) { fail(`${dir}/ui.json: invalid JSON (${e.message})`); }
}
if (!packs.has('en')) fail('data/i18n/packs/en/ui.json is missing');
if (!packs.has('es')) fail('data/i18n/packs/es/ui.json is missing');
const ref = packs.get('en') || new Map();
for (const [loc, keys] of packs) {
  for (const k of ref.keys()) if (!keys.has(k)) fail(`${loc}/ui.json: missing key ${k}`);
  for (const [k, v] of keys) {
    if (!ref.has(k)) fail(`${loc}/ui.json: extra key ${k} (not in en)`);
    if (typeof v !== 'string' || !v.trim()) fail(`${loc}/ui.json: ${k} must be a non-empty string`);
    else if (ref.has(k) && placeholders(v) !== placeholders(ref.get(k))) fail(`${loc}/ui.json: ${k} placeholders {${placeholders(v)}} differ from en {${placeholders(ref.get(k))}}`);
    if (/\.one$/.test(k) && !keys.has(k.replace(/\.one$/, '.other'))) fail(`${loc}/ui.json: ${k} has no .other form`);
  }
}

// ------------------------------------------------------------------ JS literal extraction (small lexer)
function jsFiles(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'viewer3d') continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) jsFiles(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
/** Yields { text, line, kind: 'str'|'tpl', before } for every string literal / template text segment. */
function* literals(src) {
  let i = 0; let line = 1; let lastSig = '';
  const lineStart = () => src.lastIndexOf('\n', i - 1) + 1;
  function* readTemplate() {
    // at char after opening backtick
    let buf = ''; let startLine = line; const before = src.slice(lineStart(), i - 1);
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { buf += src.slice(i, i + 2); i += 2; continue; }
      if (ch === '\n') line++;
      if (ch === '`') { i++; yield { text: buf, line: startLine, kind: 'tpl', before }; return; }
      if (ch === '$' && src[i + 1] === '{') {
        yield { text: buf, line: startLine, kind: 'tpl', before }; buf = ''; i += 2;
        yield* readCode('}');
        startLine = line; continue;
      }
      buf += ch; i++;
    }
  }
  function* readCode(until) {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\n') { line++; i++; continue; }
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); for (const c of src.slice(i, e)) if (c === '\n') line++; i = e + 2; continue; }
      if (ch === '/' && (/[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSig) || /\b(return|typeof|case|in|of)$/.test(lastSig) || lastSig === '')) {
        // regex literal
        i++; let cls = false;
        while (i < src.length) { const c = src[i]; if (c === '\\') { i += 2; continue; } if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; else if (c === '\n') break; i++; }
        i++; while (/[a-z]/i.test(src[i] || '')) i++; lastSig = 'x'; continue;
      }
      if (ch === "'" || ch === '"') {
        const q = ch; const before = src.slice(lineStart(), i); const l0 = line; i++; let buf = '';
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') { buf += src.slice(i, i + 2); i += 2; continue; } if (src[i] === '\n') break; buf += src[i]; i++; }
        i++; lastSig = 'x';
        yield { text: buf, line: l0, kind: 'str', before }; continue;
      }
      if (ch === '`') { i++; yield* readTemplate(); lastSig = 'x'; continue; }
      if (until && ch === '{') depth++;
      if (until && ch === '}') { if (depth === 0) { i++; return; } depth--; }
      if (/[A-Za-z0-9_$]/.test(ch)) { let w = ''; while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) w += src[i++]; lastSig = w; continue; }
      lastSig = ch; i++;
    }
  }
  yield* readCode(null);
}

// ------------------------------------------------------------------ 2. t('key') usage
const files = jsFiles(WEBJS);
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z][\w.-]*)'/g)) {
    const key = m[1];
    if (ref.has(key) || ref.has(`${key}.one`) || ref.has(`${key}.other`)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    fail(`${path.relative(ROOT, f)}:${line}: t('${key}') is not in the language packs`);
  }
}

// ------------------------------------------------------------------ 3. hard-coded text heuristic
const ALLOW_TEXT = new Set(['YOU HEAL', 'If-None-Match', 'SHA-256', 'F/P/R', 'MRN', 'PB', 'CX', 'ES', 'RTL', 'https://', 'Enter', 'Escape', 'Esc', 'Tab', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Content-Type', 'Accept', 'AbortError']);
const ALLOW_RE = [
  /^[a-z][\w-]*(\.[\w-]+)+$/, // i18n keys / dotted ids
  /^[a-z0-9]*([.#][\w-]+)+(\[[^\]]*\])?(\s*,\s*[\w.#[\]="-]+)*$/i, // selectors
  /\(prefers-/, /^\s*(\d+|bold|normal|\d{3})\s+\S*px/, /\bpx\b/, /translate\(|xMid|rotate\(|scale\(/, // CSS/SVG
  /^[\w./-]+\.(json|js|css|png|jpg|svg|yhb)$/, // file names
  /^(h\d|button|input|select|textarea|a|div|span|li|ul)\b.*[,[]/, // selector lists
];
const ALLOW_FILE_LINES = [/console\.(log|warn|error|info|debug)\(/, /new Error\(/, /throw new /, /new \w+Error\(/, /\.name = '/, /e\.key|\.key ===|key: '/];
const BUILTIN_FILE = path.join(WEBJS, 'i18n.js');
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  for (const lit of literals(src)) {
    const raw = lit.text.replace(/\\./g, ' ');
    const txt = raw.trim();
    if (!txt || !/\p{L}{2,}/u.test(txt)) continue;
    if (ALLOW_TEXT.has(txt) || ALLOW_RE.some((re) => re.test(txt))) continue;
    if (/\bt\(\s*$/.test(lit.before)) continue; // the key itself (literal or template)
    const lineText = lines[lit.line - 1] || '';
    if (ALLOW_FILE_LINES.some((re) => re.test(lineText))) continue;
    if (f === BUILTIN_FILE && /BUILTIN_EN|FALLBACK_PACKS/.test(src.slice(0, src.indexOf(lineText)).split('\n').slice(-40).join('\n'))) continue;
    const words = txt.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
    const sentence = words.length >= 2 && /\p{L}{2,}\s+\p{L}{2,}/u.test(txt);
    const capitalised = /^\p{Lu}\p{Ll}+/u.test(txt);
    if (!sentence && !capitalised) continue;
    if (/^[a-z][\w-]*(\s+[a-z][\w-]*)+$/.test(txt) && !/\b(the|and|of|to|for|with|de|la|el|los|las|del|con|para|y)\b/.test(txt)) continue; // class lists
    fail(`${path.relative(ROOT, f)}:${lit.line}: hard-coded text "${txt.slice(0, 70)}" — use t()`);
  }
}

if (problems.length) {
  console.error(`i18n check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`i18n OK: ${packs.size} UI packs × ${ref.size} keys, identical key sets; ${files.length} JS files scanned, no hard-coded text.`);
