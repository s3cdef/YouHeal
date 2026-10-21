// Clinic profile (non-PHI). GET any authenticated user; PATCH admin.

import { v, check } from '../lib/validate.js';
import { PERM } from '../lib/rbac.js';
import { nowIso, orgView, getOrg, parseJson, LOCALES } from './_shared.js';

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
});

export function register(router, { db }) {
  router.get('/org', (ctx) => orgView(getOrg(db, ctx.user.org_id)));

  router.patch('/org', (ctx) => {
    const body = check(patchSchema, ctx.body ?? {});
    const org = getOrg(db, ctx.user.org_id);
    const profile = parseJson(org.profile, {});
    const fields = [];
    for (const k of ['legalName', 'address', 'phone', 'email', 'website', 'license', 'reportFooter', 'polarity', 'defaultLocale']) {
      if (body[k] !== undefined) { profile[k] = body[k]; fields.push(k); }
    }
    if (body.name) fields.push('name');
    db.tx(() => {
      db.run('UPDATE orgs SET name = ?, profile = ?, updated_at = ? WHERE id = ?', body.name ?? org.name, JSON.stringify(profile), nowIso(), org.id);
      ctx.audit('org.update', { targetType: 'org', targetId: org.id, detail: { fields } });
    });
    return orgView(getOrg(db, org.id));
  }, { roles: PERM.admin });
}
