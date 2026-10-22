import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotp, totp, verifyTotp, base32Encode, base32Decode, otpauthUrl } from '../../server/lib/totp.js';

const SECRET = Buffer.from('12345678901234567890', 'ascii'); // RFC 6238 Appendix B (SHA-1)

test('RFC 6238 Appendix B test vectors (SHA-1, 8 digits)', () => {
  const vectors = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [t, code] of vectors) assert.equal(totp(SECRET, { time: t * 1000, digits: 8 }), code, `T=${t}`);
});

test('RFC 4226 HOTP test vectors', () => {
  const expect = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expect.forEach((code, i) => assert.equal(hotp(SECRET, i), code));
});

test('RFC 4648 base32 vectors and round trip', () => {
  const vec = [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']];
  for (const [plain, enc] of vec) {
    assert.equal(base32Encode(Buffer.from(plain)), enc);
    assert.equal(base32Decode(enc).toString(), plain);
  }
  assert.equal(base32Encode(SECRET, { padding: false }), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.throws(() => base32Decode('1!'), /invalid/);
});

test('verify accepts ±1 step, rejects others, and blocks replay', () => {
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30000);
  const code = totp(SECRET, { time: now });
  assert.equal(verifyTotp(SECRET, code, { time: now }), step);
  assert.equal(verifyTotp(SECRET, totp(SECRET, { time: now - 30000 }), { time: now }), step - 1);
  assert.equal(verifyTotp(SECRET, totp(SECRET, { time: now + 30000 }), { time: now }), step + 1);
  assert.equal(verifyTotp(SECRET, totp(SECRET, { time: now + 60000 }), { time: now }), null);
  assert.equal(verifyTotp(SECRET, code, { time: now, lastStep: step }), null, 'replay of same step');
  assert.equal(verifyTotp(SECRET, totp(SECRET, { time: now - 30000 }), { time: now, lastStep: step }), null, 'older step');
  assert.equal(verifyTotp(SECRET, 'abcdef', { time: now }), null);
  assert.match(otpauthUrl({ secret: SECRET, account: 'a@b.c' }), /^otpauth:\/\/totp\/YOU%20HEAL%20Clinical%3Aa%40b\.c\?secret=GEZDGNBV/);
});
