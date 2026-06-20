import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyPassword, hashPassword } from '../utils/auth.js';

type AdminRow = { id: string; password_hash: string };

export async function remediateSeedAdmin(
  db: Database.Database
): Promise<{ action: 'rotated' | 'noop' | 'skipped-no-admin'; newPassword?: string }> {
  // Local admin named 'admin' only — replicated users (home_instance set) are never seed admins.
  const admin = db
    .prepare("SELECT id, password_hash FROM users WHERE username = 'admin' AND home_instance IS NULL AND is_admin = 1")
    .get() as AdminRow | undefined;

  if (!admin) return { action: 'skipped-no-admin' };

  const stillDefault = await verifyPassword('admin123', admin.password_hash);
  if (!stillDefault) return { action: 'noop' };

  const newPassword = crypto.randomBytes(18).toString('base64url'); // 24-char strong password
  const newHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, admin.id);

  return { action: 'rotated', newPassword };
}

// CLI entrypoint: run inside the container via
//   docker exec -w /app/packages/server backspace node --import tsx/esm src/scripts/remediate-seed-admin.ts
const isMain = process.argv[1] && process.argv[1].endsWith('remediate-seed-admin.ts');
if (isMain) {
  const dbPath = process.env.DB_PATH || '/app/data/backspace.db';
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  remediateSeedAdmin(db)
    .then((r) => {
      if (r.action === 'rotated') {
        // No print-once lockout: also persist to a root-owned file next to the DB
        // (on the bind-mount → visible on the host as data/seed-admin-rotated.txt).
        const outFile = path.join(path.dirname(dbPath), 'seed-admin-rotated.txt');
        fs.writeFileSync(outFile, `${r.newPassword}\n`, { mode: 0o600 });
        console.log('Seed admin password ROTATED.');
        console.log(`  New password: ${r.newPassword}`);
        console.log(`  Also written to: ${outFile} (delete after you have stored it)`);
      } else if (r.action === 'noop') {
        console.log('Seed admin password already changed — nothing to do.');
      } else {
        console.log('No local seed admin found — nothing to do.');
      }
      db.close();
    })
    .catch((err) => {
      console.error('Remediation failed:', err);
      db.close();
      process.exit(1);
    });
}
