import { catalogMeta } from '../catalog/load.js';

export function register(router, { cfg, db }) {
  router.get('/health', () => {
    db.get('SELECT 1 AS ok');
    return { status: 'ok', version: cfg.version, catalogVersion: catalogMeta(db)?.version ?? null };
  }, { public: true });
}
