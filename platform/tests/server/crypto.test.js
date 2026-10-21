import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Keyring, generateMasterKey, encryptField, decryptField, encryptJson, decryptJson, blindIndex, hashPassword,
  verifyPassword, parsePasswordHash, passwordNeedsRehash, safeEqual, canonicalJson, randomToken, parseMasterKey, ciphertextKeyId,
} from '../../server/lib/crypto.js';
import { passwordPolicyError } from '../../server/lib/auth.js';

const ring = () => new Keyring(generateMasterKey());

test('AES-256-GCM field encryption round-trips with key id and AAD', () => {
  const kr = ring();
  const ct = encryptField(kr, 'María José Núñez', 'patients.first_name:abc');
  assert.match(ct, /^v1:[0-9a-f]{16}:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/);
  assert.equal(ciphertextKeyId(ct), kr.keyId);
  assert.ok(!ct.includes('María'));
  assert.equal(decryptField(kr, ct, 'patients.first_name:abc'), 'María José Núñez');
  assert.notEqual(encryptField(kr, 'x', 'a'), encryptField(kr, 'x', 'a'), 'random IV');
  assert.deepEqual(decryptJson(kr, encryptJson(kr, { a: [1, 2] }, 'j'), 'j'), { a: [1, 2] });
  assert.equal(encryptField(kr, null), null);
});

test('tampering, wrong AAD, wrong key and unknown key id are all rejected', () => {
  const kr = ring();
  const ct = encryptField(kr, 'secret value', 'aad:1');
  const parts = ct.split(':');
  const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  assert.throws(() => decryptField(kr, [...parts.slice(0, 4), flip(parts[4])].join(':'), 'aad:1'), /authentication failed/);
  assert.throws(() => decryptField(kr, [...parts.slice(0, 3), flip(parts[3]), parts[4]].join(':'), 'aad:1'), /authentication failed/);
  assert.throws(() => decryptField(kr, ct, 'aad:2'), /authentication failed/, 'ciphertext moved to another row');
  assert.throws(() => decryptField(ring(), ct, 'aad:1'), /unknown key id/);
  assert.throws(() => decryptField(kr, 'v2:x:y:z:w'), /unsupported/);
  // retired keys still decrypt
  const old = generateMasterKey();
  const oldRing = new Keyring(old);
  const oldCt = encryptField(oldRing, 'legacy', 'a');
  assert.equal(decryptField(new Keyring(generateMasterKey(), [old]), oldCt, 'a'), 'legacy');
});

test('blind index is deterministic over normalized values and key-dependent', () => {
  const kr = ring();
  assert.equal(blindIndex(kr, 'last_name', 'Núñez '), blindIndex(kr, 'last_name', 'nunez'));
  assert.notEqual(blindIndex(kr, 'last_name', 'nunez'), blindIndex(kr, 'mrn', 'nunez'), 'domain separated');
  assert.notEqual(blindIndex(kr, 'last_name', 'nunez'), blindIndex(ring(), 'last_name', 'nunez'));
  assert.equal(blindIndex(kr, 'mrn', 'yh-000001'), blindIndex(kr, 'mrn', 'YH000001'));
  assert.equal(blindIndex(kr, 'last_name', '   '), null);
});

test('scrypt password hashing encodes parameters and verifies', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.match(h, /^scrypt\$N=32768,r=8,p=1\$/);
  const p = parsePasswordHash(h);
  assert.equal(p.salt.length, 32);
  assert.equal(await verifyPassword('correct horse battery staple', h), true);
  assert.equal(await verifyPassword('correct horse battery stapl', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(passwordNeedsRehash(h), false);
  assert.equal(passwordNeedsRehash(h.replace('N=32768', 'N=16384')), true);
});

test('password policy', () => {
  assert.equal(passwordPolicyError('short'), 'must be at least 12 characters');
  assert.match(passwordPolicyError('Password123!'), /common/);
  assert.match(passwordPolicyError('aaaaaaaaaaaaaaaa'), /different characters/);
  assert.match(passwordPolicyError('12345678901234'), /sequence|different/);
  assert.match(passwordPolicyError('drsmith-clinic-2026', { email: 'drsmith@x.org' }), /email/);
  assert.equal(passwordPolicyError('Violet-Harbor-Lantern-42'), null);
});

test('misc primitives', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(Buffer.from(randomToken(32), 'base64url').length, 32);
  assert.throws(() => parseMasterKey('c2hvcnQ='), /32 bytes/);
  assert.equal(parseMasterKey(generateMasterKey().toString('base64')).length, 32);
});
