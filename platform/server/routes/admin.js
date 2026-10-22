// Administrative operations: encrypted backup download.

import path from 'node:path';
import { PERM } from '../lib/rbac.js';
import { writeBackup, backupFilename } from '../lib/backup.js';

export function register(router, { db, keyring, cfg, log, RAW }) {
  router.get('/admin/backup', async (ctx) => {
    const name = backupFilename();
    ctx.audit('backup.export', { targetType: 'backup', targetId: name });
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      await writeBackup(db, keyring, { tmpDir: path.join(cfg.backupsDir, 'tmp'), out: res, appVersion: cfg.version });
    } catch (e) {
      log.error('backup stream failed', { reqId: ctx.reqId, err: e.message });
      res.destroy(e);
    }
    return RAW;
  }, { roles: PERM.admin });
}
