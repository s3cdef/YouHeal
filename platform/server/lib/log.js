// Structured JSON logger. NEVER pass PHI, tokens, passwords or request bodies to it.
// Keys that look sensitive are redacted defensively anyway.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE = /pass(word)?|secret|token|cookie|authorization|totp|code|key|ssn|dob|name|email|phone|address|notes?$/i;
const ALLOWED_KEYS = new Set(['reqId', 'method', 'path', 'route', 'status', 'ms', 'ip', 'userId', 'orgId',
  'action', 'event', 'port', 'host', 'tls', 'file', 'count', 'version', 'err', 'stack', 'errCode', 'keyId',
  'dataDir', 'url', 'catalogVersion', 'warnings', 'errors', 'signal', 'migration', 'bytes', 'role']);

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!ALLOWED_KEYS.has(k) && SENSITIVE.test(k)) { out[k] = '[REDACTED]'; continue; }
    out[k] = v instanceof Error ? { message: v.message, code: v.code } : v;
  }
  return out;
}

export function createLogger({ level = 'info', stream = process.stderr, base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...redact(fields) };
    try { stream.write(JSON.stringify(line) + '\n'); } catch { /* never throw from logging */ }
  };
  return {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    /** Loud banner for operator-critical events (key generation, insecure dev flags). */
    loud: (m, f) => {
      if (threshold > LEVELS.error) return;
      const bar = '!'.repeat(78);
      try { stream.write(`${bar}\n!! ${m}\n${bar}\n`); } catch { /* ignore */ }
      emit('warn', m, f);
    },
    child: (extra) => createLogger({ level, stream, base: { ...base, ...extra } }),
  };
}

export const nullLogger = createLogger({ level: 'silent' });
