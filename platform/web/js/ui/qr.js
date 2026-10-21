// Minimal QR Code encoder — byte mode, error-correction level M, versions 1–10 (ISO/IEC 18004).
// Written for otpauth:// enrollment URLs; no dependencies, no network.
import { svgEl } from './dom.js';

// Level M block structure per version: [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
const BLOCKS_M = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// ---- GF(256) arithmetic, primitive polynomial 0x11D ----
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function dataCapacity(v) { return BLOCKS_M[v][1].reduce((s, [n, d]) => s + n * d, 0); }

function encodeBytes(bytes) {
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error('QR payload too long for version 10-M');
  const cap = dataCapacity(version) * 8;
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xEC; codewords.length < cap / 8; pad ^= 0xEC ^ 0x11) codewords.push(pad);
  return { version, codewords };
}

function interleave(version, data) {
  const [ecLen, groups] = BLOCKS_M[version];
  const div = rsDivisor(ecLen);
  const blocks = [];
  let k = 0;
  for (const [n, d] of groups) {
    for (let i = 0; i < n; i++) {
      const dat = data.slice(k, k + d); k += d;
      blocks.push({ dat, ec: rsRemainder(dat, div) });
    }
  }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.dat.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

function buildMatrix(version, allCodewords, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  // timing patterns
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  // finder patterns + separators
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setF(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // alignment patterns
  const al = ALIGN[version];
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // format info (reserve now, real bits drawn after masking)
  drawFormat(m, fn, size, mask, setF);
  // version info (v >= 7)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      setF(a, b, bit); setF(b, a, bit);
    }
  }
  // data placement (zig-zag)
  let i = 0;
  const total = allCodewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) {
          m[y][x] = i < total ? ((allCodewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
          i++;
        }
      }
    }
  }
  // mask
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (fn[y][x]) continue;
    let inv;
    switch (mask) {
      case 0: inv = (x + y) % 2 === 0; break;
      case 1: inv = y % 2 === 0; break;
      case 2: inv = x % 3 === 0; break;
      case 3: inv = (x + y) % 3 === 0; break;
      case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
      case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
      case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
    if (inv) m[y][x] = !m[y][x];
  }
  drawFormat(m, fn, size, mask, setF);
  return m;
}

function drawFormat(m, fn, size, mask, setF) {
  const data = (0 << 3) | mask; // level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const g = (i) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) setF(8, i, g(i));
  setF(8, 7, g(6)); setF(8, 8, g(7)); setF(7, 8, g(8));
  for (let i = 9; i < 15; i++) setF(14 - i, 8, g(i));
  for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, g(i));
  for (let i = 8; i < 15; i++) setF(8, size - 15 + i, g(i));
  setF(8, size - 8, true);
}

function penalty(m) {
  const n = m.length;
  let p = 0;
  const line = (get) => {
    let s = 0; let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) { run++; if (run === 5) s += 3; else if (run > 5) s += 1; } else run = 1;
    }
    // finder-like 1:1:3:1:1 with 4 light modules on a side
    for (let i = 0; i + 10 < n; i++) {
      const seq = Array.from({ length: 11 }, (_, k) => (get(i + k) ? 1 : 0)).join('');
      if (seq === '10111010000' || seq === '00001011101') s += 40;
    }
    return s;
  };
  for (let y = 0; y < n; y++) p += line((i) => m[y][i]);
  for (let x = 0; x < n; x++) p += line((i) => m[i][x]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = n * n;
  p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return p;
}

/** Encode text (UTF-8) → { version, size, modules: boolean[][] } */
export function encodeQR(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const { version, codewords } = encodeBytes(bytes);
  const all = interleave(version, codewords);
  let best = null; let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const mtx = buildMatrix(version, all, mask);
    const sc = penalty(mtx);
    if (sc < bestScore) { bestScore = sc; best = mtx; }
  }
  return { version, size: best.length, modules: best };
}

/** SVG element for the QR code (dark modules as a single path, 4-module quiet zone). */
export function qrSvg(text, { px = 220, label = '' } = {}) {
  const { size, modules } = encodeQR(text);
  const q = 4; const dim = size + q * 2;
  let d = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  return svgEl('svg', { class: 'qr', width: px, height: px, viewBox: `0 0 ${dim} ${dim}`, role: 'img', 'aria-label': label, 'shape-rendering': 'crispEdges' },
    svgEl('rect', { width: dim, height: dim, fill: '#ffffff' }),
    svgEl('path', { d, fill: '#000000' }));
}
