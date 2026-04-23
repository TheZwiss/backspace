import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Baseline an existing install so Drizzle's migrate() skips the initial
 * migration (tables already exist). Must be called BEFORE migrate().
 *
 * Detects existing installs by checking: users table exists but
 * __drizzle_migrations table does not.
 *
 * Drizzle's __drizzle_migrations table schema (verified SQLite DDL):
 *   "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL
 *   "hash" text NOT NULL      -- SHA-256 hex of the migration SQL file (raw UTF-8)
 *   "created_at" numeric      -- journalEntry.when (ms timestamp from journal)
 *
 * Hash must match Drizzle's exactly: read SQL file as raw UTF-8 string,
 * hash it with SHA-256. Line endings matter — don't normalize \r\n vs \n.
 */
export function baselineExistingInstall(db: Database.Database): void {
  const hasUsers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  ).get();
  const hasJournal = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
  ).get();

  if (!hasUsers || hasJournal) return; // Fresh install or already baselined

  console.log('[migrate] Existing install detected — baselining Drizzle migrations...');

  // Read the journal to get the initial migration metadata
  const migrationsFolder = path.resolve(__dirname, '../../drizzle');
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
  const initialEntry = journal.entries[0];

  if (!initialEntry) {
    throw new Error('No entries found in drizzle migration journal');
  }

  // Compute the hash the same way Drizzle does: SHA-256 of the SQL file content
  const sqlPath = path.join(migrationsFolder, `${initialEntry.tag}.sql`);
  const sqlContent = fs.readFileSync(sqlPath, 'utf-8');
  const hash = crypto.createHash('sha256').update(sqlContent).digest('hex');

  // Create the journal table matching Drizzle's exact SQLite DDL
  db.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "hash" text NOT NULL,
      "created_at" numeric
    )
  `);

  db.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
  ).run(hash, initialEntry.when);

  console.log(`[migrate] Baselined initial migration: ${initialEntry.tag} (hash: ${hash.slice(0, 12)}...)`);
}

/**
 * Heal column drift between an existing install and the 0000_initial
 * schema baseline.
 *
 * The baseline in `baselineExistingInstall` assumes that any existing
 * install's schema already matches 0000_initial.sql. That assumption is
 * usually fine for installs created through the old pre-drizzle manual
 * migration system — but a DB can fall behind if it skipped one of those
 * manual ALTERs (e.g. a dev-env that was paused before the
 * `remote_max_upload_size` migration in 1e4e71a landed). On such DBs,
 * baseline marks 0000 as applied without the columns actually being
 * there, and a later migration that recreates the table (e.g.
 * 0004_cooing_black_knight) crashes trying to SELECT them.
 *
 * Walks every table defined in 0000_snapshot.json; for each that already
 * exists in the DB, ADDs any columns the snapshot declares but the table
 * is missing. Idempotent: on a correctly-migrated DB every column is
 * already present and the loop is a no-op. Columns that SQLite's
 * ALTER TABLE ADD COLUMN cannot express (PRIMARY KEY; NOT NULL without a
 * default) are skipped with a warning rather than corrupting data.
 *
 * Only reconciles against the 0000 baseline — later migrations add their
 * own columns through normal migration SQL and are handled by
 * Drizzle's migrator.
 */
export function healInitialSchemaDrift(db: Database.Database): void {
  const migrationsFolder = path.resolve(__dirname, '../../drizzle');
  const snapshotPath = path.join(migrationsFolder, 'meta', '0000_snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
    tables: Record<string, {
      name: string;
      columns: Record<string, {
        name: string;
        type: string;
        primaryKey: boolean;
        notNull: boolean;
        autoincrement: boolean;
        default?: string | number;
      }>;
    }>;
  };

  for (const table of Object.values(snapshot.tables)) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table.name);
    if (!exists) continue;

    const existingCols = new Set(
      (db.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[])
        .map(c => c.name)
    );

    for (const col of Object.values(table.columns)) {
      if (existingCols.has(col.name)) continue;

      if (col.primaryKey) {
        console.warn(`[migrate] Skipping drift heal for ${table.name}.${col.name}: PRIMARY KEY cannot be added via ALTER TABLE`);
        continue;
      }
      if (col.notNull && col.default === undefined) {
        console.warn(`[migrate] Skipping drift heal for ${table.name}.${col.name}: NOT NULL with no default (would violate existing rows)`);
        continue;
      }

      const parts = [`"${col.name}"`, col.type];
      if (col.notNull) parts.push('NOT NULL');
      if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);

      const sql = `ALTER TABLE "${table.name}" ADD COLUMN ${parts.join(' ')}`;
      console.log(`[migrate] Healing schema drift: ${sql}`);
      db.exec(sql);
    }
  }
}

/**
 * Second-pass heal for pre-drizzle dev DBs whose column drift is not a
 * pure add-column problem.
 *
 * `healInitialSchemaDrift` handles tables that are missing columns — it
 * ALTERs them in. But a pre-drizzle dev DB can also carry *renamed*
 * columns: e.g. `federation_outbox` on some old installs retains the
 * pre-rename `message_id` / `dm_channel_id` columns instead of the
 * current `entity_id` / `context_id`. The missing columns are NOT NULL
 * without a default, so the earlier heal correctly skips them, and the
 * outbox worker then fails every tick with `no such column:
 * federation_outbox.context_id`.
 *
 * For tables whose physical column set is *missing* columns declared by
 * the current-migration-state snapshot (the one matching the highest
 * `__drizzle_migrations` entry — NOT the latest snapshot on disk) *and*
 * which hold zero rows, this pass DROPs the table and rebuilds it from
 * the snapshot's JSON (columns, defaults, foreign keys, composite PKs,
 * unique constraints, indexes). Targeting the current-state snapshot
 * — rather than the latest — is critical: rebuilding to a future
 * snapshot would introduce columns that drizzle's migrator is about
 * to add via ALTER TABLE ADD COLUMN, causing duplicate-column errors.
 * Extra-only drift (leftover columns from pre-drizzle manual migrations
 * that no current code reads) is left alone — the trigger is missing
 * columns, because that's what breaks runtime queries.
 *
 * Non-empty tables are skipped with a warning — data preservation wins
 * over heal, and this path should only ever be hit by a pre-drizzle dev
 * DB that never exercised the affected tables in the first place.
 *
 * Idempotent: on correctly-migrated DBs the column sets already match,
 * so the mismatch check short-circuits for every table and nothing is
 * dropped. Production Pi+VM instances are unaffected.
 */
type SnapshotColumn = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  autoincrement: boolean;
  default?: string | number;
};

type SnapshotTable = {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, { name: string; columns: string[]; isUnique: boolean }>;
  foreignKeys: Record<string, {
    name: string;
    tableFrom: string;
    tableTo: string;
    columnsFrom: string[];
    columnsTo: string[];
    onDelete?: string;
    onUpdate?: string;
  }>;
  compositePrimaryKeys: Record<string, { name?: string; columns: string[] }>;
  uniqueConstraints: Record<string, { name?: string; columns: string[] }>;
};

type DrizzleSnapshot = { tables: Record<string, SnapshotTable> };

function loadSnapshotForCurrentMigrationState(
  db: Database.Database,
  migrationsFolder: string
): DrizzleSnapshot {
  // The rebuild target must be the snapshot that reflects what drizzle
  // has already applied — NOT the latest snapshot on disk. Rebuilding
  // to a future snapshot would introduce columns that pending ALTER
  // TABLE ADD COLUMN migrations are about to add, causing duplicate-
  // column errors when drizzle's migrator runs right after.
  //
  // __drizzle_migrations rows store `created_at` = the journal entry's
  // `when` timestamp. Pick the row with the highest id (most recently
  // applied), match it to a journal entry by that timestamp, then walk
  // backward to find the nearest existing snapshot (some idx values
  // may lack a snapshot if the migration was hand-written outside of
  // `drizzle-kit generate`, e.g. 0002 in this codebase).
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };

  const hasJournal = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
  ).get();
  if (!hasJournal) {
    // No migrations recorded at all — caller is about to run them all
    // from scratch via drizzle's migrate(). Nothing to rebuild against;
    // return an empty snapshot so the heal loop is a no-op.
    return { tables: {} };
  }

  const latest = db.prepare(
    'SELECT created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 1'
  ).get() as { created_at: number } | undefined;
  if (!latest) return { tables: {} };

  const entry = journal.entries.find(e => e.when === latest.created_at);
  if (!entry) {
    throw new Error(
      `__drizzle_migrations.created_at=${latest.created_at} has no matching journal entry`
    );
  }

  const candidates = journal.entries
    .filter(e => e.idx <= entry.idx)
    .sort((a, b) => b.idx - a.idx);
  for (const candidate of candidates) {
    const idxPadded = String(candidate.idx).padStart(4, '0');
    const snapshotPath = path.join(migrationsFolder, 'meta', `${idxPadded}_snapshot.json`);
    if (fs.existsSync(snapshotPath)) {
      return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as DrizzleSnapshot;
    }
  }
  // No snapshot at or below current migration state — shouldn't happen
  // in practice because 0000_snapshot.json always exists, but fall
  // through to a no-op rather than guessing.
  return { tables: {} };
}

function buildCreateTableStatement(table: SnapshotTable): string {
  const lines: string[] = [];
  for (const col of Object.values(table.columns)) {
    const parts = [`\`${col.name}\``, col.type];
    if (col.primaryKey) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);
    lines.push('\t' + parts.join(' '));
  }
  for (const cpk of Object.values(table.compositePrimaryKeys)) {
    lines.push('\tPRIMARY KEY(' + cpk.columns.map(c => `\`${c}\``).join(', ') + ')');
  }
  for (const uc of Object.values(table.uniqueConstraints)) {
    lines.push('\tUNIQUE(' + uc.columns.map(c => `\`${c}\``).join(', ') + ')');
  }
  for (const fk of Object.values(table.foreignKeys)) {
    const from = fk.columnsFrom.map(c => `\`${c}\``).join(', ');
    const to = fk.columnsTo.map(c => `\`${c}\``).join(', ');
    const onUpdate = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '';
    const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '';
    lines.push(`\tFOREIGN KEY (${from}) REFERENCES \`${fk.tableTo}\`(${to})${onUpdate}${onDelete}`);
  }
  return `CREATE TABLE \`${table.name}\` (\n${lines.join(',\n')}\n)`;
}

function buildIndexStatements(table: SnapshotTable): string[] {
  return Object.values(table.indexes).map(idx => {
    const unique = idx.isUnique ? 'UNIQUE ' : '';
    const cols = idx.columns.map(c => `\`${c}\``).join(', ');
    return `CREATE ${unique}INDEX \`${idx.name}\` ON \`${table.name}\` (${cols})`;
  });
}

export function healRenamedColumns(db: Database.Database): void {
  const migrationsFolder = path.resolve(__dirname, '../../drizzle');
  const snapshot = loadSnapshotForCurrentMigrationState(db, migrationsFolder);

  for (const table of Object.values(snapshot.tables)) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table.name);
    if (!exists) continue;

    const snapshotCols = new Set(Object.keys(table.columns));
    const physicalCols = new Set(
      (db.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[])
        .map(c => c.name)
    );

    const missingFromPhysical = [...snapshotCols].filter(c => !physicalCols.has(c));
    const extraInPhysical = [...physicalCols].filter(c => !snapshotCols.has(c));

    // Trigger the rebuild only when the physical table is *missing*
    // columns the snapshot declares — that's the runtime-breaking
    // case the app code relies on. Extra-only drift (leftover columns
    // from pre-drizzle manual migrations that no current code reads)
    // is left alone: dropping those would risk losing data the app
    // doesn't care about but the operator might.
    if (missingFromPhysical.length === 0) continue;

    const rowCount = (db.prepare(
      `SELECT COUNT(*) AS c FROM "${table.name}"`
    ).get() as { c: number }).c;

    if (rowCount > 0) {
      console.warn(
        `[migrate] Column drift on ${table.name} (missing: [${missingFromPhysical.join(', ')}], extra: [${extraInPhysical.join(', ')}]) — skipping rebuild: table has ${rowCount} rows, manual data migration required`
      );
      continue;
    }

    console.log(
      `[migrate] Rebuilding empty table ${table.name} to match current-migration-state snapshot (missing: [${missingFromPhysical.join(', ')}], extra: [${extraInPhysical.join(', ')}])`
    );

    const createStmt = buildCreateTableStatement(table);
    const indexStmts = buildIndexStatements(table);

    // Wrap in a transaction so a partial rebuild rolls back cleanly.
    const rebuild = db.transaction(() => {
      db.exec(`DROP TABLE "${table.name}"`);
      db.exec(createStmt);
      for (const stmt of indexStmts) db.exec(stmt);
    });
    rebuild();
  }
}

/**
 * Ensure data invariants after schema migration. Idempotent — safe to run
 * on every boot. Uses raw better-sqlite3 handle (not Drizzle ORM).
 */
export function ensureDefaults(db: Database.Database): void {
  // 1. Ensure the single-row instance_settings row exists
  const row = db.prepare('SELECT id FROM instance_settings WHERE id = 1').get();
  if (!row) {
    db.prepare(
      `INSERT OR IGNORE INTO instance_settings
        (id, max_bitrate_kbps, min_bitrate_kbps, bitrate_step_kbps,
         allowed_resolutions, allowed_framerates, max_resolution, max_framerate, updated_at)
       VALUES (1, 20000, 500, 500, ?, ?, 1080, 60, ?)`
    ).run('540,720,1080', '30,45,60', Date.now());
    console.log('[defaults] Inserted default instance_settings row');
  }

  // 2. Ensure a unique Snowflake worker ID is persisted (0-1023)
  const settings = db.prepare('SELECT worker_id FROM instance_settings WHERE id = 1').get() as
    { worker_id: number | null } | undefined;
  if (!settings || settings.worker_id === null) {
    const workerId = crypto.randomInt(0, 1024);
    db.prepare('UPDATE instance_settings SET worker_id = ? WHERE id = 1').run(workerId);
    console.log(`[defaults] Generated Snowflake worker ID: ${workerId}`);
  }

  // 3. Ensure at least one admin exists (promote earliest registered user)
  const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!anyAdmin) {
    const firstUser = db.prepare(
      'SELECT id FROM users ORDER BY created_at ASC LIMIT 1'
    ).get() as { id: string } | undefined;
    if (firstUser) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
      console.log(`[defaults] Promoted first user ${firstUser.id} to admin`);
    }
  }
}
