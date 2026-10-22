// Append-only, hash-chained audit log (CONTRACT §7, AU-2/3/9/10).
//   hash = SHA256(prev_hash || canonical_json(row))      (row = every column except prev_hash/hash)
// A keyed anchor (HMAC with the audit subkey) pins the chain head so tail truncation is detected.
// NEVER put PHI values in `detail` — ids, counts and field NAMES only.

import fs from 'node:fs';
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

export function anchorMac(keyringOrSet, lastId, lastHash) {
  const ks = keyringOrSet.current || keyringOrSet;
  return hmacHex(ks.audit, `audit-anchor|${lastId}|${lastHash}`);
}
/**
 * MAC of the in-DB anchor row. It also covers the external-log export point, so a DB writer without the
 * key cannot clear `exported_id` to hide a deleted or rolled-back anchor log (F-16 residual).
 */
export function dbAnchorMac(keyringOrSet, lastId, lastHash, exportedId, exportedHash) {
  const ks = keyringOrSet.current || keyringOrSet;
  return hmacHex(ks.audit, `audit-anchor-db|${lastId}|${lastHash}|${exportedId ?? ''}|${exportedHash ?? ''}`);
}
const anyKeyMac = (keyring, id, hash, mac) => [...keyring.sets.values()].some((ks) => safeEqual(mac, anchorMac(ks, id, hash)));

/** F-16: external, append-only export of the chain head ("<ts> <id> <hash> <mac>" per line). */
export function readAnchorLog(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [ts, id, hash, mac] = l.trim().split(' ');
    return { ts, id: Number(id), hash, mac };
  }).filter((x) => Number.isInteger(x.id) && x.hash && x.mac);
}

/** MAC over the "verified through" checkpoint (incremental /audit/verify). */
export function checkpointMac(keyringOrSet, id, hash) {
  const ks = keyringOrSet.current || keyringOrSet;
  return hmacHex(ks.audit, `audit-verified|${id}|${hash}`);
}

export function createAudit(db, keyring, log, { anchorFile = null, anchorEvery = 100 } = {}) {
  function exportHead(id, hash) {
    if (!anchorFile) return;
    try {
      fs.appendFileSync(anchorFile, `${new Date().toISOString()} ${id} ${hash} ${anchorMac(keyring, id, hash)}\n`, { mode: 0o600 });
      // remember the export point so a missing/rolled-back log is detectable (F-16 residual)
      const a = db.get('SELECT last_id, last_hash, exported_id FROM audit_anchor WHERE id = 1');
      if (a && (a.exported_id == null || a.exported_id < id)) {
        db.run('UPDATE audit_anchor SET exported_id = ?, exported_hash = ?, mac = ? WHERE id = 1',
          id, hash, dbAnchorMac(keyring, a.last_id, a.last_hash, id, hash));
      }
    } catch (e) { log?.warn('audit anchor export failed', { err: e.message }); }
  }
  /** Write the current chain head to the anchor file (on shutdown). */
  function writeHead() {
    const last = db.get('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = readAnchorLog(anchorFile).at(-1);
    if (last && (!prev || prev.id !== last.id)) exportHead(last.id, last.hash);
  }

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
      const exp = db.get('SELECT exported_id, exported_hash FROM audit_anchor WHERE id = 1');
      db.run(`INSERT INTO audit_anchor (id, last_id, last_hash, mac, updated_at) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash, mac = excluded.mac, updated_at = excluded.updated_at`,
      row.id, hash, dbAnchorMac(keyring, row.id, hash, exp?.exported_id, exp?.exported_hash), row.ts);
      if (anchorFile && row.id % anchorEvery === 0) db.afterCommit(() => exportHead(row.id, hash)); // only committed rows
      return row.id;
    });
  }

  /**
   * Walk the whole (global) chain. With `orgId`, `checked` reports only that org's row count and a break
   * located in another tenant's row is reported without its id (F-11).
   * Returns { ok, checked, brokenAt?, reason? }.
   */
  function verify({ orgId, full = true } = {}) {
    let prev = GENESIS, expectedId = 1, total = 0, orgRows = 0, lastId = 0, lastHash = GENESIS;
    let mode = 'full', baseRows = 0, baseOrgRows = 0;
    const hashes = new Map();
    const fail = (id, rowOrg, reason) => {
      const visible = orgId === undefined || rowOrg === orgId;
      return { ok: false, mode, checked: orgId === undefined ? baseRows + total : baseOrgRows + orgRows, brokenAt: visible ? id : null, reason };
    };
    if (!full) {
      // Incremental: trust rows up to a MAC'd checkpoint written by a previous successful verification, but
      // re-verify the checkpoint row itself (its content hash and its link) on every run.
      const cp = db.get('SELECT verified_id, verified_hash, verified_mac FROM audit_anchor WHERE id = 1');
      if (cp?.verified_id) {
        mode = 'incremental';
        if (!safeEqual(cp.verified_mac || '', checkpointMac(keyring, cp.verified_id, cp.verified_hash))) return fail(null, null, 'verification checkpoint signature invalid (run a full verification)');
        const row = db.get('SELECT * FROM audit_log WHERE id = ?', cp.verified_id);
        if (!row || row.hash !== cp.verified_hash || computeHash(row.prev_hash, row) !== row.hash) return fail(cp.verified_id, row?.org_id, 'checkpoint row was altered');
        prev = row.hash; lastId = row.id; lastHash = row.hash; expectedId = row.id + 1;
        baseRows = row.id;
        if (orgId !== undefined) baseOrgRows = db.get('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND id <= ?', orgId, row.id).n;
        if (anchorFile) hashes.set(row.id, row.hash);
      }
    }
    for (const r of db.iterate('SELECT * FROM audit_log WHERE id >= ? ORDER BY id ASC', expectedId)) {
      if (r.id !== expectedId) return fail(expectedId, r.org_id, 'missing or reordered row');
      if (r.prev_hash !== prev) return fail(r.id, r.org_id, 'prev_hash does not link to previous row');
      if (computeHash(prev, r) !== r.hash) return fail(r.id, r.org_id, 'row content does not match its hash');
      if (anchorFile) hashes.set(r.id, r.hash);
      prev = r.hash; lastId = r.id; lastHash = r.hash; expectedId++; total++;
      if (orgId !== undefined && r.org_id === orgId) orgRows++;
    }
    const walked = total;
    total += baseRows; orgRows += baseOrgRows;
    if (mode === 'incremental' && anchorFile) {
      // anchor-log lines behind the checkpoint: compare against the stored row hashes
      for (const a of readAnchorLog(anchorFile)) if (!hashes.has(a.id)) { const h = db.get('SELECT hash FROM audit_log WHERE id = ?', a.id)?.hash; if (h) hashes.set(a.id, h); }
    }
    const checked = orgId === undefined ? total : orgRows;
    const anchor = db.get('SELECT last_id, last_hash, mac, exported_id, exported_hash FROM audit_anchor WHERE id = 1');
    if (anchor || total) {
      if (!anchor) return { ok: false, checked, brokenAt: null, reason: 'chain anchor missing' };
      const macOk = safeEqual(anchor.mac, dbAnchorMac(keyring, anchor.last_id, anchor.last_hash, anchor.exported_id, anchor.exported_hash))
        // pre-2026-10-21 anchors (no export point bound) stay valid until the next audit row rewrites them
        || (anchor.exported_id == null && safeEqual(anchor.mac, anchorMac(keyring, anchor.last_id, anchor.last_hash)));
      if (!macOk) return { ok: false, checked, brokenAt: null, reason: 'chain anchor signature invalid' };
      if (anchor.last_id !== lastId || anchor.last_hash !== lastHash) return { ok: false, checked, brokenAt: null, reason: 'chain head does not match anchor (truncation?)' };
    }
    // F-16: cross-check the external append-only anchor log
    const exported = anchorFile ? db.get('SELECT exported_id, exported_hash FROM audit_anchor WHERE id = 1') : null;
    const logLines = readAnchorLog(anchorFile);
    if (exported?.exported_id) {
      if (!fs.existsSync(anchorFile)) return { ok: false, checked, brokenAt: null, reason: 'anchor log missing' };
      const maxLogged = logLines.reduce((m, a) => Math.max(m, a.id), 0);
      if (maxLogged < exported.exported_id) return { ok: false, checked, brokenAt: null, reason: `anchor log behind DB (log ends at ${maxLogged}, exported through ${exported.exported_id})` };
      const line = logLines.find((a) => a.id === exported.exported_id);
      if (!line || line.hash !== exported.exported_hash) return { ok: false, checked, brokenAt: null, reason: 'anchor log does not contain the recorded export point' };
    }
    for (const a of logLines) {
      if (!anyKeyMac(keyring, a.id, a.hash, a.mac)) return { ok: false, checked, brokenAt: null, reason: `anchor log line for row ${a.id} has an invalid MAC` };
      if (a.id > lastId) return { ok: false, checked, brokenAt: null, reason: `audit log truncated: anchor log records row ${a.id} but the chain ends at ${lastId}` };
      if (hashes.get(a.id) !== a.hash) return { ok: false, checked, brokenAt: null, reason: `row ${a.id} differs from the exported anchor` };
    }
    if (lastId > 0) {
      db.run('UPDATE audit_anchor SET verified_id = ?, verified_hash = ?, verified_mac = ?, verified_at = ? WHERE id = 1',
        lastId, lastHash, checkpointMac(keyring, lastId, lastHash), new Date().toISOString());
    }
    return { ok: true, checked, mode, walked };
  }

  function list({ orgId, limit = 50, offset = 0, actor, action, targetType, targetId }) {
    // F-11: pre-login / org-less rows are platform-operator data, never shown in an org's view
    const where = ['org_id = ?'];
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

  return { append, verify, list, writeHead, log };
}
