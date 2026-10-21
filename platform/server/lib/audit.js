// Append-only, hash-chained audit log (CONTRACT §7, AU-2/3/9/10).
//   hash = SHA256(prev_hash || canonical_json(row))      (row = every column except prev_hash/hash)
// A keyed anchor (HMAC with the audit subkey) pins the chain head so tail truncation is detected.
// NEVER put PHI values in `detail` — ids, counts and field NAMES only.

import { sha256hex, hmacHex, canonicalJson, safeEqual } from './crypto.js';

export const GENESIS = '0'.repeat(64);

const rowForHash = (r) => ({
  id: r.id, ts: r.ts, org_id: r.org_id ?? null, actor_id: r.actor_id ?? null, actor_role: r.actor_role ?? null,
  action: r.action, target_type: r.target_type ?? null, target_id: r.target_id ?? null, outcome: r.outcome,
  ip: r.ip ?? null, request_id: r.request_id ?? null, detail: r.detail ?? null,
});

export const computeHash = (prevHash, row) => sha256hex(prevHash + canonicalJson(rowForHash(row)));

function cleanDetail(detail) {
  if (detail === undefined || detail === null) return null;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined) continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => (typeof x === 'string' ? x.slice(0, 100) : x));
    else out[k] = JSON.parse(JSON.stringify(v));
  }
  return JSON.stringify(out);
}

export function anchorMac(keyring, lastId, lastHash) {
  return hmacHex(keyring.current.audit, `audit-anchor|${lastId}|${lastHash}`);
}

export function createAudit(db, keyring, log) {
  function append(e) {
    return db.tx(() => {
      const last = db.get('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
      const row = {
        id: (last?.id ?? 0) + 1,
        ts: new Date().toISOString(),
        org_id: e.orgId ?? null,
        actor_id: e.actorId ?? null,
        actor_role: e.actorRole ?? null,
        action: e.action,
        target_type: e.targetType ?? null,
        target_id: e.targetId != null ? String(e.targetId) : null,
        outcome: e.outcome || 'success',
        ip: e.ip ?? null,
        request_id: e.requestId ?? null,
        detail: cleanDetail(e.detail),
      };
      const prev = last?.hash ?? GENESIS;
      const hash = computeHash(prev, row);
      db.run(`INSERT INTO audit_log (id, ts, org_id, actor_id, actor_role, action, target_type, target_id, outcome, ip, request_id, detail, prev_hash, hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.ts, row.org_id, row.actor_id, row.actor_role, row.action, row.target_type,
      row.target_id, row.outcome, row.ip, row.request_id, row.detail, prev, hash);
      db.run(`INSERT INTO audit_anchor (id, last_id, last_hash, mac, updated_at) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash, mac = excluded.mac, updated_at = excluded.updated_at`,
      row.id, hash, anchorMac(keyring, row.id, hash), row.ts);
      return row.id;
    });
  }

  /** Walk the whole chain. Returns { ok, checked, brokenAt?, reason? }. */
  function verify() {
    let prev = GENESIS, expectedId = 1, checked = 0, lastId = 0, lastHash = GENESIS;
    for (const r of db.iterate('SELECT * FROM audit_log ORDER BY id ASC')) {
      if (r.id !== expectedId) return { ok: false, checked, brokenAt: expectedId, reason: 'missing or reordered row' };
      if (r.prev_hash !== prev) return { ok: false, checked, brokenAt: r.id, reason: 'prev_hash does not link to previous row' };
      if (computeHash(prev, r) !== r.hash) return { ok: false, checked, brokenAt: r.id, reason: 'row content does not match its hash' };
      prev = r.hash; lastId = r.id; lastHash = r.hash; expectedId++; checked++;
    }
    const anchor = db.get('SELECT last_id, last_hash, mac FROM audit_anchor WHERE id = 1');
    if (anchor || checked) {
      if (!anchor) return { ok: false, checked, brokenAt: 1, reason: 'chain anchor missing' };
      if (!safeEqual(anchor.mac, anchorMac(keyring, anchor.last_id, anchor.last_hash))) return { ok: false, checked, brokenAt: anchor.last_id, reason: 'chain anchor signature invalid' };
      if (anchor.last_id !== lastId || anchor.last_hash !== lastHash) return { ok: false, checked, brokenAt: Math.min(anchor.last_id, lastId + 1), reason: 'chain head does not match anchor (truncation?)' };
    }
    return { ok: true, checked };
  }

  function list({ orgId, limit = 50, offset = 0, actor, action, targetType, targetId }) {
    const where = ['(org_id = ? OR org_id IS NULL)'];
    const params = [orgId];
    if (actor) { where.push('actor_id = ?'); params.push(actor); }
    if (action) {
      if (action.endsWith('*')) { where.push('action LIKE ?'); params.push(action.slice(0, -1).replace(/[%_]/g, '') + '%'); }
      else { where.push('action = ?'); params.push(action); }
    }
    if (targetType) { where.push('target_type = ?'); params.push(targetType); }
    if (targetId) { where.push('target_id = ?'); params.push(targetId); }
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE ${w}`, ...params).n;
    const items = db.all(`SELECT a.*, u.email AS actor_email, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ${w.replace(/\b(org_id|actor_id|action|target_type|target_id)\b/g, 'a.$1')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset)
      .map((r) => ({
        id: r.id, ts: r.ts, orgId: r.org_id, actor: r.actor_id ? { id: r.actor_id, email: r.actor_email, name: r.actor_name, role: r.actor_role } : null,
        action: r.action, targetType: r.target_type, targetId: r.target_id, outcome: r.outcome, ip: r.ip, requestId: r.request_id,
        detail: r.detail ? JSON.parse(r.detail) : null, hash: r.hash,
      }));
    return { items, total };
  }

  return { append, verify, list, log };
}
