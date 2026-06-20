import Database from 'better-sqlite3';
import { config } from '../config.js';
import { createSnapshot, pruneSnapshots } from '../utils/backup.js';

// Standalone manual-snapshot CLI (run via `./backup.sh` → docker exec). Unlike the
// scheduled worker and the pre-migration hook (which run inside the server process
// where initDatabase() already ran), this is a FRESH node process — getRawDb() would
// be undefined here. Open our own handle. VACUUM INTO takes a consistent read snapshot,
// so this is safe to run concurrently with the live server on the same WAL database.
const db = new Database(config.dbPath);
try {
  const p = createSnapshot(db, 'manual');
  pruneSnapshots();
  console.log('Manual snapshot written: ' + p);
} finally {
  db.close();
}
