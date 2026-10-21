// npm run create-admin [-- --email you@clinic --name "Dr X" --reset-mfa]
// Creates the first admin (and clinic) or resets an existing account to an active, unlocked admin.
// Password is read from the TTY (hidden, twice). Runs offline against the local database.

import { cliContext, parseArgs, ask, askHidden, requireTty, die } from './_common.js';
import { bootstrap } from '../index.js';
import { hashPassword, uuid } from '../lib/crypto.js';
import { passwordPolicyError } from '../lib/auth.js';
import { createAudit } from '../lib/audit.js';
import { DEFAULT_POLARITY } from '../routes/_shared.js';
import { removeSetupToken } from '../routes/setup.js';

requireTty();
const args = parseArgs();
const { cfg, log } = cliContext();
const { db, keyring } = bootstrap(cfg, log, { loadCatalogFiles: false });
const audit = createAudit(db, keyring, log);
const now = () => new Date().toISOString();

try {
  const email = String(args.email || await ask('Admin email: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die('Invalid email address.');
  const existing = db.get('SELECT * FROM users WHERE email = ?', email);
  const name = existing ? existing.name : String(args.name || await ask('Full name: ')).trim();
  if (!name) die('Name is required.');

  let password;
  for (;;) {
    password = await askHidden('New password (min 12 chars): ');
    const err = passwordPolicyError(password, { email, name });
    if (err) { console.error(`Password ${err}.`); continue; }
    if (password !== await askHidden('Repeat password: ')) { console.error('Passwords do not match.'); continue; }
    break;
  }
  const hash = await hashPassword(password);

  if (existing) {
    const ok = (await ask(`Reset ${email} to an active, unlocked ADMIN with this password? [y/N] `)).toLowerCase() === 'y';
    if (!ok) die('Aborted.', 0);
    db.tx(() => {
      db.run(`UPDATE users SET password_hash = ?, password_changed_at = ?, role = 'admin', active = 1, failed_attempts = 0, locked_until = NULL,
        last_failed_at = NULL, must_change_password = 0, updated_at = ? WHERE id = ?`, hash, now(), now(), existing.id);
      if (args['reset-mfa']) db.run('UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, mfa_pending_enc = NULL, mfa_last_step = NULL, recovery_codes = NULL WHERE id = ?', existing.id);
      db.run('DELETE FROM user_sessions WHERE user_id = ?', existing.id);
      audit.append({ orgId: existing.org_id, actorId: existing.id, actorRole: 'admin', action: 'cli.admin.reset', targetType: 'user', targetId: existing.id, ip: 'local-cli', detail: { resetMfa: Boolean(args['reset-mfa']) } });
    });
    console.log(`Admin ${email} reset.${args['reset-mfa'] ? ' MFA cleared — re-enroll at next login.' : ''}`);
  } else {
    let org = db.get('SELECT * FROM orgs ORDER BY created_at LIMIT 1');
    const orgName = org ? null : String(args.org || await ask('Clinic name: ')).trim();
    if (!org && !orgName) die('Clinic name is required.');
    const userId = uuid();
    db.tx(() => {
      if (!org) {
        const id = uuid();
        db.run('INSERT INTO orgs (id, name, profile, created_at, updated_at) VALUES (?,?,?,?,?)', id, orgName, JSON.stringify({ polarity: DEFAULT_POLARITY, defaultLocale: 'en' }), now(), now());
        org = db.get('SELECT * FROM orgs WHERE id = ?', id);
      }
      db.run(`INSERT INTO users (id, org_id, email, name, role, password_hash, password_changed_at, created_at, updated_at)
        VALUES (?,?,?,?, 'admin', ?,?,?,?)`, userId, org.id, email, name, hash, now(), now(), now());
      audit.append({ orgId: org.id, actorId: userId, actorRole: 'admin', action: 'cli.admin.create', targetType: 'user', targetId: userId, ip: 'local-cli' });
    });
    removeSetupToken(cfg); // the web first-run setup is no longer needed
    console.log(`Admin ${email} created for clinic "${org.name}". MFA enrollment is required at first login.`);
  }
} finally {
  db.close();
}
