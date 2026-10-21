// Clinic profile (non-PHI). GET any authenticated user; PATCH admin.

import { v, check } from '../lib/validate.js';
import { PERM } from '../lib/rbac.js';
import { HttpError } from '../lib/http.js';
import { nowIso, orgView, getOrg, parseJson, LOCALES, parseImageDataUrl } from './_shared.js';

export const LOGO_MAX_BYTES = 200 * 1024;

const HEX = /^#[0-9A-Fa-f]{6}$/;
const patchSchema = v.object({
  name: v.string({ min: 1, max: 200 }).optional(),
  legalName: v.string({ max: 200 }).nullable().optional(),
  address: v.string({ max: 500, multiline: true }).nullable().optional(),
  phone: v.string({ max: 50, pattern: /^[0-9+().\s/-]*$/ }).nullable().optional(),
  email: v.email().nullable().optional(),
  website: v.string({ max: 200, pattern: /^https?:\/\/[^\s]+$/ }).nullable().optional(),
  license: v.string({ max: 200 }).nullable().optional(),
  reportFooter: v.string({ max: 1000, multiline: true }).nullable().optional(),
  polarity: v.object({ negative: v.string({ pattern: HEX }), positive: v.string({ pattern: HEX }) }).optional(),
  defaultLocale: v.enum(LOCALES).optional(),
  logo: v.string({ min: 1, max: Math.ceil(LOGO_MAX_BYTES * 4 / 3) + 64 }).nullable().optional(),
});

export function register(router, { db }) {
  router.get('/org', (ctx) => orgView(getOrg(db, ctx.user.org_id), { logo: true }));

  router.patch('/org', (ctx) => {
    const body = check(patchSchema, ctx.body ?? {});
    const org = getOrg(db, ctx.user.org_id);
    const profile = parseJson(org.profile, {});
    const fields = [];
    for (const k of ['legalName', 'address', 'phone', 'email', 'website', 'license', 'reportFooter', 'polarity', 'defaultLocale']) {
      if (body[k] !== undefined) { profile[k] = body[k]; fields.push(k); }
    }
    if (body.name) fields.push('name');
    let logo = org.logo ?? null;
    if (body.logo !== undefined) {
      if (body.logo !== null) {
        const img = parseImageDataUrl(body.logo, LOGO_MAX_BYTES);
        if (typeof img === 'string') throw new HttpError(400, 'VALIDATION', 'Invalid logo', { logo: img });
      }
      logo = body.logo;
      fields.push('logo');
    }
    db.tx(() => {
      db.run('UPDATE orgs SET name = ?, profile = ?, logo = ?, updated_at = ? WHERE id = ?', body.name ?? org.name, JSON.stringify(profile), logo, nowIso(), org.id);
      ctx.audit('org.update', { targetType: 'org', targetId: org.id, detail: { fields } });
    });
    return orgView(getOrg(db, org.id), { logo: true });
  }, { roles: PERM.admin });
}
