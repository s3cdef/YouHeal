// Encrypted backups (CP-9, SC-28). Format of a .yhbak file:
//   "YHBAK1 " + JSON header + "\n"  |  AES-256-GCM( gzip( SQLite snapshot ) )  |  16-byte GCM tag
// The header line is authenticated as AAD. Key = HKDF(master, "youheal:backup:v1"); header names the key id.
// The snapshot is a consistent copy produced by `VACUUM INTO` (SQLite-specific; pg adapter: pg_dump).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable, Transform } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from './keys.js';
import { openDb, migrate } from './db.js';
import { createAudit } from './audit.js';
import { reencryptAll } from './rotate.js';

export const MAGIC = 'YHBAK1 ';
const TAG_LEN = 16;

export const backupFilename = (d = new Date()) => `youheal-backup-${d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.yhbak`;

/** Consistent snapshot of the live DB into a private temp file. Caller must delete it. */
export function snapshotDb(db, tmpDir) {
  ensureDir(tmpDir);
  const tmp = path.join(tmpDir, `.snapshot-${crypto.randomUUID()}.sqlite`);
  db.run('VACUUM INTO ?', tmp);
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
  return tmp;
}

/** Stream an encrypted backup of `db` into writable `out` (ends it). */
export async function writeBackup(db, keyring, { tmpDir, out, appVersion = null }) {
  const tmp = snapshotDb(db, tmpDir);
  try {
    const iv = crypto.randomBytes(12);
    const schema = db.get('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? null;
    const header = { v: 1, alg: 'aes-256-gcm', compression: 'gzip', kdf: 'hkdf-sha256:youheal:backup:v1', keyId: keyring.keyId,
      iv: iv.toString('base64'), createdAt: new Date().toISOString(), app: appVersion, schema, bytes: fs.statSync(tmp).size };
    const headerBuf = Buffer.from(`${MAGIC}${JSON.stringify(header)}\n`, 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', keyring.current.backup, iv);
    cipher.setAAD(headerBuf);
    out.write(headerBuf);
    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), cipher, out, { end: false });
    await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
    return header;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export async function writeBackupFile(db, keyring, file, opts = {}) {
  ensureDir(path.dirname(file));
  const out = fs.createWriteStream(file, { mode: 0o600, flags: 'wx' });
  try {
    return await writeBackup(db, keyring, { ...opts, tmpDir: opts.tmpDir || path.dirname(file), out });
  } catch (e) {
    out.destroy(); fs.rmSync(file, { force: true });
    throw e;
  }
}

export function readBackupHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl < 0 || buf.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) throw new Error('not a YOU HEAL backup file');
    const headerBuf = Buffer.from(buf.subarray(0, nl + 1));
    const header = JSON.parse(headerBuf.subarray(MAGIC.length).toString('utf8'));
    if (header.v !== 1 || header.alg !== 'aes-256-gcm') throw new Error('unsupported backup version');
    return { header, headerBuf };
  } finally { fs.closeSync(fd); }
}

const MAX_SNAPSHOT_BYTES = 1024 ** 4; // 1 TiB sanity bound for the header's byte count

function openDecipher(file, keyring) {
  const { header, headerBuf } = readBackupHeader(file);
  const ks = keyring.get(header.keyId);
  if (!ks) throw new Error(`backup was made with key ${header.keyId}, which is not in the keyring (add it under data/keys/retired/)`);
  if (!Number.isSafeInteger(header.bytes) || header.bytes <= 0 || header.bytes > MAX_SNAPSHOT_BYTES) throw new Error('backup header has an invalid byte count');
  const size = fs.statSync(file).size;
  if (size < headerBuf.length + TAG_LEN) throw new Error('backup file is truncated');
  const tag = Buffer.alloc(TAG_LEN);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN); } finally { fs.closeSync(fd); }
  const make = () => {
    const d = crypto.createDecipheriv('aes-256-gcm', ks.backup, Buffer.from(header.iv, 'base64'), { authTagLength: TAG_LEN });
    d.setAAD(headerBuf);
    d.setAuthTag(tag);
    return { decipher: d, src: fs.createReadStream(file, { start: headerBuf.length, end: size - TAG_LEN - 1 }) };
  };
  return { header, make };
}

const devNull = () => new Writable({ write(_c, _e, cb) { cb(); } });
/** Errors once more than `cap` bytes pass through (decompression-bomb guard). */
const capStream = (cap) => {
  let n = 0;
  return new Transform({
    transform(chunk, _e, cb) { n += chunk.length; if (n > cap) cb(new Error(`decompressed size exceeds the ${cap} bytes declared in the header`)); else cb(null, chunk); },
  });
};
const authError = (e) => Object.assign(new Error(/auth|tag|Unsupported state/i.test(String(e.message))
  ? 'backup authentication failed (wrong key, corrupted or tampered file)' : `backup could not be decrypted: ${e.message}`), { code: 'BACKUP_INVALID' });

/**
 * F-15: pass 1 authenticates the whole ciphertext (GCM tag) without producing plaintext; only then pass 2
 * decrypts + gunzips with an output cap equal to the header's byte count. Throws (and removes outFile) on failure.
 */
export async function decryptBackup(file, keyring, outFile) {
  const { header, make } = openDecipher(file, keyring);
  const p1 = make();
  try { await pipeline(p1.src, p1.decipher, devNull()); } catch (e) { throw authError(e); }
  if (!outFile) return header;
  const p2 = make();
  try {
    await pipeline(p2.src, p2.decipher, zlib.createGunzip(), capStream(header.bytes), fs.createWriteStream(outFile, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(outFile, { force: true });
    throw authError(e);
  }
  if (fs.statSync(outFile).size !== header.bytes) {
    fs.rmSync(outFile, { force: true });
    throw Object.assign(new Error('restored snapshot size does not match the backup header'), { code: 'BACKUP_INVALID' });
  }
  return header;
}

export const verifyBackup = (file, keyring) => decryptBackup(file, keyring, null);

/** Restore into dbPath. Server must be stopped. Previous DB is kept as <db>.pre-restore-<ts>. */
export async function restoreBackup(file, keyring, dbPath, { log, anchorFile = null } = {}) {
  ensureDir(path.dirname(dbPath));
  const tmp = `${dbPath}.restore-${crypto.randomUUID()}`;
  const header = await decryptBackup(file, keyring, tmp); // tag verified before we touch the live DB
  const sourceSha256 = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  try {
    const check = new DatabaseSync(tmp, { readOnly: true });
    try {
      const ic = check.prepare('PRAGMA integrity_check').get();
      if (Object.values(ic)[0] !== 'ok') throw new Error('restored database failed integrity_check');
      check.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
    } finally { check.close(); }
    const rdb = openDb(tmp, { log });
    try {
      migrate(rdb, { log }); // bring an older snapshot to the current schema
      // A backup taken before a key rotation: bring ciphertexts, blind indexes and the audit anchor
      // under the CURRENT master key so search and audit verification keep working.
      if (header.keyId !== keyring.keyId) {
        reencryptAll(rdb, keyring, keyring.current.master);
        log?.info('restored data re-keyed to the current master key', { keyId: keyring.keyId });
      }
      // F-16: the restore itself is recorded in the restored chain; the external anchor log is rolled over
      // (its later rows no longer exist) and restarted at the new head.
      if (anchorFile && fs.existsSync(anchorFile)) fs.renameSync(anchorFile, `${anchorFile}.pre-restore-${stamp}`);
      const orgs = rdb.all('SELECT id FROM orgs');
      const audit = createAudit(rdb, keyring, log, { anchorFile });
      audit.append({
        orgId: orgs.length === 1 ? orgs[0].id : null, action: 'backup.restore', ip: 'local-cli', targetType: 'backup', targetId: path.basename(file),
        detail: { sourceSha256, backupCreatedAt: header.createdAt, backupKeyId: header.keyId, backupSchema: header.schema, rekeyed: header.keyId !== keyring.keyId },
      });
      audit.writeHead();
      rdb.checkpoint('TRUNCATE');
    } finally { rdb.close(); }
    for (const ext of ['-wal', '-shm']) fs.rmSync(tmp + ext, { force: true });
  } catch (e) {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(tmp + ext, { force: true });
    throw e;
  }
  let previous = null;
  if (fs.existsSync(dbPath)) {
    previous = `${dbPath}.pre-restore-${stamp}`;
    fs.renameSync(dbPath, previous);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, previous + ext);
  }
  fs.renameSync(tmp, dbPath);
  log?.info('backup restored', { file: path.basename(file) });
  return { header, previous, sourceSha256 };
}
