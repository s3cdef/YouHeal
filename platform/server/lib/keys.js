// Master key management: env (YH_MASTER_KEY) or key file (data/keys/master.key, 0600), auto-generated
// on first run. Retired keys (after `npm run rotate-key`) live in data/keys/retired/*.key and are
// loaded for decryption only (old backups, crash recovery during rotation).

import fs from 'node:fs';
import path from 'node:path';
import { Keyring, parseMasterKey, generateMasterKey, deriveKeySet } from './crypto.js';
import { ConfigError } from './config.js';

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, mode); } catch { /* not owner: leave as is */ }
  }
}

function checkPerms(file) {
  if (process.platform === 'win32') return;
  const st = fs.statSync(file);
  if (st.mode & 0o077) {
    throw new ConfigError(`key file ${file} is accessible by group/other (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 "${file}"`);
  }
}

export function readKeyFile(file) {
  checkPerms(file);
  return parseMasterKey(fs.readFileSync(file, 'utf8'));
}

export function writeKeyFile(file, keyBuf, { exclusive = true } = {}) {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, exclusive ? 'wx' : 'w', 0o600);
  try {
    fs.writeSync(fd, keyBuf.toString('base64') + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

export function loadRetiredKeys(keysDir) {
  const dir = path.join(keysDir, 'retired');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.key')).sort()
    .map((f) => readKeyFile(path.join(dir, f)));
}

export function loadKeyring(cfg, log, { allowGenerate = true } = {}) {
  let master, source;
  if (cfg.masterKeyB64) {
    try { master = parseMasterKey(cfg.masterKeyB64); } catch (e) { throw new ConfigError(`YH_MASTER_KEY: ${e.message}`); }
    source = 'env';
  } else if (fs.existsSync(cfg.masterKeyFile)) {
    try { master = readKeyFile(cfg.masterKeyFile); } catch (e) { throw e instanceof ConfigError ? e : new ConfigError(`${cfg.masterKeyFile}: ${e.message}`); }
    source = 'file';
  } else {
    if (!allowGenerate) throw new ConfigError(`no master key: set YH_MASTER_KEY or create ${cfg.masterKeyFile}`);
    master = generateMasterKey();
    writeKeyFile(cfg.masterKeyFile, master);
    source = 'generated';
    log?.loud(`GENERATED A NEW MASTER KEY at ${cfg.masterKeyFile} — BACK IT UP OFFLINE NOW. ` +
      'Without it, encrypted PHI and backups are unrecoverable.', { file: cfg.masterKeyFile, keyId: deriveKeySet(master).keyId });
  }
  const retired = loadRetiredKeys(cfg.keysDir);
  const next = `${cfg.masterKeyFile}.next`;
  if (fs.existsSync(next)) {
    retired.push(readKeyFile(next));
    log?.loud(`INCOMPLETE KEY ROTATION detected (${next} exists). Run "npm run rotate-key" again to finish it.`);
  }
  const keyring = new Keyring(master, retired);
  return { keyring, source };
}
