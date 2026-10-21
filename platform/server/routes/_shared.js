// Helpers shared by route modules.

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const parseJson = (s, def = null) => { if (s === null || s === undefined) return def; try { return JSON.parse(s); } catch { return def; } };

export const DEFAULT_POLARITY = Object.freeze({ negative: '#2563EB', positive: '#DC2626' });
export const LOCALES = ['en', 'es'];
export const THEMES = ['light', 'dark', 'system'];

export function orgView(org, { logo = false } = {}) {
  if (!org) return null;
  const p = parseJson(org.profile, {});
  const out = {
    id: org.id,
    name: org.name,
    legalName: p.legalName ?? null,
    address: p.address ?? null,
    phone: p.phone ?? null,
    email: p.email ?? null,
    website: p.website ?? null,
    license: p.license ?? null,
    reportFooter: p.reportFooter ?? null,
    polarity: { ...DEFAULT_POLARITY, ...(p.polarity || {}) },
    defaultLocale: p.defaultLocale || 'en',
    hasLogo: Boolean(org.logo),
  };
  if (logo) out.logo = org.logo || null;
  return out;
}

// ---------------------------------------------------------------- raster image data URLs (no SVG: script risk)
const IMG_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAGIC = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** Returns { kind, bytes } or an error string. Signature (magic bytes) must match the declared type. */
export function parseImageDataUrl(val, maxBytes) {
  const m = IMG_RE.exec(val);
  if (!m) return 'must be a base64 data:image/png, image/jpeg or image/webp URL';
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > maxBytes) return `must be at most ${Math.round(maxBytes / 1024)} KB`;
  if (!MAGIC[m[1]](bytes)) return 'image content does not match its declared type';
  return { kind: m[1], bytes };
}

export function userView(u) {
  if (!u) return null;
  const codes = parseJson(u.recovery_codes, []);
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale, theme: u.theme,
    mfaEnabled: Boolean(u.mfa_enabled), active: Boolean(u.active),
    locked: Boolean(u.locked_until && Date.parse(u.locked_until) > Date.now()),
    mustChangePassword: Boolean(u.must_change_password),
    recoveryCodesRemaining: u.mfa_enabled ? codes.filter((c) => !c.used).length : 0,
    lastLoginAt: u.last_login_at, createdAt: u.created_at,
  };
}

export function ageAt(dob, at = today()) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ay, am, ad] = at.slice(0, 10).split('-').map(Number);
  let age = ay - y;
  if (am < m || (am === m && ad < d)) age--;
  return age >= 0 ? age : null;
}

export const getOrg = (db, id) => db.get('SELECT * FROM orgs WHERE id = ?', id);
