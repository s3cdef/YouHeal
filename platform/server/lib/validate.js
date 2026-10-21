// Minimal schema validator. Every route body/query passes through `check(schema, value)`.
// Unknown object keys are rejected by default (strict), strings are trimmed and length-bounded,
// and control characters are refused.

export class ValidationError extends Error {
  constructor(fields, message = 'Request validation failed') {
    super(message);
    this.code = 'VALIDATION';
    this.status = 400;
    this.fields = fields;
  }
}

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function mk(kind, opts, fn) {
  return {
    kind, opts,
    optional() { return mk(kind, { ...opts, optional: true }, fn); },
    nullable() { return mk(kind, { ...opts, nullable: true }, fn); },
    default(d) { return mk(kind, { ...opts, optional: true, def: d }, fn); },
    parse(value, path, errs) {
      if (value === undefined) {
        if (opts.def !== undefined) return typeof opts.def === 'function' ? opts.def() : structuredClone(opts.def);
        if (opts.optional) return undefined;
        errs[path || '_'] = 'is required'; return undefined;
      }
      if (value === null) {
        if (opts.nullable) return null;
        errs[path || '_'] = 'must not be null'; return undefined;
      }
      return fn(value, path, errs, opts);
    },
  };
}

export const v = {
  string: (o = {}) => mk('string', o, (val, p, e, { min = 0, max = 1000, pattern, trim = true, multiline = false, lower = false, oneOf }) => {
    if (typeof val !== 'string') { e[p] = 'must be a string'; return; }
    let s = trim ? val.trim() : val;
    if (lower) s = s.toLowerCase();
    if (CTRL.test(s) || (!multiline && /[\r\n]/.test(s))) { e[p] = 'contains invalid characters'; return; }
    if (s.length < min) { e[p] = min === 1 ? 'must not be empty' : `must be at least ${min} characters`; return; }
    if (s.length > max) { e[p] = `must be at most ${max} characters`; return; }
    if (pattern && !pattern.test(s)) { e[p] = 'has an invalid format'; return; }
    if (oneOf && !oneOf.includes(s)) { e[p] = `must be one of: ${oneOf.join(', ')}`; return; }
    return s;
  }),
  enum: (values, o = {}) => mk('enum', o, (val, p, e) => {
    if (!values.includes(val)) { e[p] = `must be one of: ${values.join(', ')}`; return; }
    return val;
  }),
  email: (o = {}) => mk('email', o, (val, p, e) => {
    if (typeof val !== 'string') { e[p] = 'must be a string'; return; }
    const s = val.trim().toLowerCase();
    if (s.length > 254 || !EMAIL.test(s)) { e[p] = 'must be a valid email address'; return; }
    return s;
  }),
  int: (o = {}) => mk('int', o, (val, p, e, { min = -Infinity, max = Infinity, coerce = false }) => {
    let n = val;
    if (coerce && typeof val === 'string' && /^-?\d+$/.test(val)) n = Number(val);
    if (!Number.isInteger(n)) { e[p] = 'must be an integer'; return; }
    if (n < min || n > max) { e[p] = `must be between ${min} and ${max}`; return; }
    return n;
  }),
  number: (o = {}) => mk('number', o, (val, p, e, { min = -Infinity, max = Infinity }) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) { e[p] = 'must be a number'; return; }
    if (val < min || val > max) { e[p] = `must be between ${min} and ${max}`; return; }
    return val;
  }),
  bool: (o = {}) => mk('bool', o, (val, p, e, { coerce = false }) => {
    if (coerce && (val === '1' || val === 'true')) return true;
    if (coerce && (val === '0' || val === 'false')) return false;
    if (typeof val !== 'boolean') { e[p] = 'must be a boolean'; return; }
    return val;
  }),
  /** Calendar date YYYY-MM-DD (validated as a real date). */
  date: (o = {}) => mk('date', o, (val, p, e, { notFuture = false, minYear = 1880 }) => {
    if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) { e[p] = 'must be a date (YYYY-MM-DD)'; return; }
    const d = new Date(`${val}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== val) { e[p] = 'is not a valid date'; return; }
    if (d.getUTCFullYear() < minYear) { e[p] = 'is out of range'; return; }
    if (notFuture && val > new Date().toISOString().slice(0, 10)) { e[p] = 'must not be in the future'; return; }
    return val;
  }),
  datetime: (o = {}) => mk('datetime', o, (val, p, e) => {
    if (typeof val !== 'string' || val.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(val)) { e[p] = 'must be an ISO-8601 timestamp'; return; }
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) { e[p] = 'is not a valid timestamp'; return; }
    return d.toISOString();
  }),
  array: (item, o = {}) => mk('array', o, (val, p, e, { min = 0, max = 500, unique = false }) => {
    if (!Array.isArray(val)) { e[p] = 'must be an array'; return; }
    if (val.length < min) { e[p] = `must contain at least ${min} item(s)`; return; }
    if (val.length > max) { e[p] = `must contain at most ${max} items`; return; }
    const out = val.map((x, i) => item.parse(x, `${p}[${i}]`, e));
    return unique ? [...new Set(out)] : out;
  }),
  object: (shape, o = {}) => mk('object', o, (val, p, e, { strict = true }) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) { e[p || '_'] = 'must be an object'; return; }
    const out = {};
    for (const [k, s] of Object.entries(shape)) {
      const r = s.parse(val[k], p ? `${p}.${k}` : k, e);
      if (r !== undefined) out[k] = r;
    }
    if (strict) for (const k of Object.keys(val)) if (!(k in shape)) e[p ? `${p}.${k}` : k] = 'is not an allowed field';
    return out;
  }),
  /** Free-form JSON object with bounded size/depth (questionnaire answers, vitals). */
  json: (o = {}) => mk('json', o, (val, p, e, { maxBytes = 32 * 1024, maxDepth = 5, maxNodes = 5000 }) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) { e[p] = 'must be an object'; return; }
    const err = jsonShapeError(val, { maxDepth, maxNodes });
    if (err) { e[p] = err; return; }
    if (Buffer.byteLength(JSON.stringify(val)) > maxBytes) { e[p] = 'is too large'; return; }
    return val;
  }),
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * F-13: iterative (stack-safe) walk — bounded depth, bounded node count, no prototype-ish keys at any level.
 * Returns an error string or null.
 */
export function jsonShapeError(root, { maxDepth = 5, maxNodes = 5000 } = {}) {
  const stack = [[root, 1]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (++nodes > maxNodes) return 'has too many elements';
    if (node === null || typeof node !== 'object') continue;
    if (depth > maxDepth) return 'is nested too deeply';
    if (Array.isArray(node)) {
      if (node.length > maxNodes) return 'has too many elements';
      for (let i = 0; i < node.length; i++) stack.push([node[i], depth + 1]);
    } else {
      for (const k of Object.keys(node)) {
        if (FORBIDDEN_KEYS.has(k)) return 'has a forbidden key';
        stack.push([node[k], depth + 1]);
      }
    }
  }
  return null;
}

export const catalogId = () => v.string({ min: 1, max: 120, pattern: /^[a-z0-9][a-z0-9-]*$/ });
export const uuidStr = () => v.string({ pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ });

export function check(schema, value) {
  const errs = {};
  const out = schema.parse(value, '', errs);
  if (Object.keys(errs).length) throw new ValidationError(errs);
  return out;
}

/** Pagination from a URLSearchParams-like object. */
export function paging(query, { defLimit = 50, maxLimit = 200 } = {}) {
  const lim = query.get('limit'), off = query.get('offset');
  const errs = {};
  const limit = lim === null ? defLimit : Number(lim);
  const offset = off === null ? 0 : Number(off);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) errs.limit = `must be an integer between 1 and ${maxLimit}`;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000_000) errs.offset = 'must be a non-negative integer';
  if (Object.keys(errs).length) throw new ValidationError(errs);
  return { limit, offset };
}
