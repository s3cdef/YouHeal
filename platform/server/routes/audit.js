// Audit log read + chain verification (admin, auditor).

import { paging, check, uuidStr } from '../lib/validate.js';
import { badRequest } from '../lib/http.js';
import { PERM } from '../lib/rbac.js';

export function register(router, { audit }) {
  router.get('/audit', (ctx) => {
    const { limit, offset } = paging(ctx.query, { defLimit: 50, maxLimit: 500 });
    const actor = ctx.query.get('actor') || null;
    if (actor) check(uuidStr(), actor);
    const action = ctx.query.get('action') || null;
    if (action && !/^[a-z0-9_.]{1,64}\*?$/.test(action)) throw badRequest('Invalid action filter', { action: 'has an invalid format' });
    const targetType = ctx.query.get('targetType') || null;
    if (targetType && !/^[a-z_]{1,32}$/.test(targetType)) throw badRequest('Invalid targetType', { targetType: 'has an invalid format' });
    const targetId = ctx.query.get('targetId') || null;
    if (targetId && targetId.length > 100) throw badRequest('Invalid targetId', { targetId: 'is too long' });
    const out = audit.list({ orgId: ctx.user.org_id, limit, offset, actor, action, targetType, targetId });
    ctx.audit('audit.read', { targetType: 'audit', detail: { returned: out.items.length } });
    return out;
  }, { roles: PERM.auditRead });

  router.get('/audit/verify', (ctx) => {
    const r = audit.verify({ orgId: ctx.user.org_id });
    ctx.audit('audit.verify', { targetType: 'audit', outcome: r.ok ? 'success' : 'failure', detail: { checked: r.checked, brokenAt: r.brokenAt } });
    return r;
  }, { roles: PERM.auditRead });
}
