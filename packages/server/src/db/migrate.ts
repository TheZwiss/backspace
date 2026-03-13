import Database from 'better-sqlite3';
import crypto from 'crypto';
import { DEFAULT_EVERYONE_PERMISSIONS, PermissionBits, ALL_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';

export function runMigrations(db: Database.Database): void {
  console.log('Checking for database migrations...');

  const tables = [
    {
      name: 'messages',
      columns: [
        { name: 'reply_to_id', type: 'TEXT REFERENCES messages(id) ON DELETE SET NULL' }
      ]
    },
    {
      name: 'users',
      columns: [
        { name: 'status', type: "TEXT DEFAULT 'offline'" },
        { name: 'custom_status', type: 'TEXT' }
      ]
    },
    {
      name: 'roles',
      columns: [
        { name: 'permissions', type: 'TEXT' }
      ]
    },
    {
      name: 'dm_messages',
      columns: [
        { name: 'edited_at', type: 'INTEGER' },
        { name: 'reply_to_id', type: 'TEXT' }
      ]
    },
    {
      name: 'attachments',
      columns: [
        { name: 'dm_message_id', type: 'TEXT' }
      ]
    },
    {
      name: 'dm_members',
      columns: [
        { name: 'closed', type: 'INTEGER DEFAULT 0' }
      ]
    },
    {
      name: 'dm_channels',
      columns: [
        { name: 'owner_id', type: 'TEXT' }
      ]
    },
    {
      name: 'users',
      columns: [
        { name: 'is_admin', type: 'INTEGER DEFAULT 0' }
      ]
    },
    {
      name: 'users',
      columns: [
        { name: 'home_instance', type: 'TEXT' },
        { name: 'replicated_instances', type: "TEXT DEFAULT '[]'" },
        { name: 'home_user_id', type: 'TEXT' }
      ]
    },
    {
      name: 'instance_settings',
      columns: [
        { name: 'instance_name', type: "TEXT DEFAULT 'Backspace'" },
        { name: 'worker_id', type: 'INTEGER' },
        { name: 'discovery_enabled', type: 'INTEGER NOT NULL DEFAULT 1' },
        { name: 'registration_open', type: 'INTEGER' }
      ]
    },
    {
      name: 'spaces',
      columns: [
        { name: 'visibility', type: "TEXT DEFAULT 'private'" },
        { name: 'description', type: 'TEXT' }
      ]
    },
    {
      name: 'spaces',
      columns: [
        { name: 'banner', type: 'TEXT' }
      ]
    },
    {
      name: 'users',
      columns: [
        { name: 'banner', type: 'TEXT' },
        { name: 'accent_color', type: 'TEXT' },
        { name: 'bio', type: 'TEXT' },
      ]
    },
    {
      name: 'users',
      columns: [
        { name: 'avatar_color', type: 'TEXT' },
      ]
    },
    {
      name: 'users',
      columns: [
        { name: 'is_deleted', type: 'INTEGER DEFAULT 0' },
      ]
    },
    {
      name: 'spaces',
      columns: [
        { name: 'avatar_color', type: 'TEXT' },
      ]
    },
    {
      name: 'channels',
      columns: [
        { name: 'category_id', type: 'TEXT' },
      ]
    },
    {
      name: 'users',
      columns: [
        { name: 'profile_updated_at', type: 'INTEGER' },
      ]
    }
  ];

  for (const table of tables) {
    const tableInfo = db.pragma(`table_info(${table.name})`) as { name: string }[];
    const existingColumns = new Set(tableInfo.map(c => c.name));

    for (const column of table.columns) {
      if (!existingColumns.has(column.name)) {
        console.log(`Migrating: Adding column ${column.name} to ${table.name}`);
        try {
          db.exec(`ALTER TABLE ${table.name} ADD COLUMN ${column.name} ${column.type}`);
        } catch (error) {
          console.error(`Failed to add column ${column.name} to ${table.name}:`, error);
        }
      }
    }
  }

  // Ensure channel_overrides table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_overrides (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      allow TEXT NOT NULL DEFAULT '0',
      deny TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (channel_id, target_type, target_id)
    );
  `);

  // Ensure bans table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bans (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT,
      banned_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, user_id)
    );
  `);

  // Ensure join_requests table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS join_requests (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
  `);

  // Ensure channel_categories table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_categories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);

  // Ensure voice_restrictions table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_restrictions (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      restriction_type TEXT NOT NULL,
      moderator_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, user_id, restriction_type)
    );
  `);

  // ─── Legacy permissions: convert JSON arrays to decimal strings ───────────
  migrateLegacyPermissions(db);

  // ─── RBAC Migration: Ensure @everyone roles exist for all spaces ─────────
  migrateEveryoneRoles(db);

  // ─── Instance settings: ensure default row exists ──────────────────────────
  migrateInstanceSettings(db);

  // ─── Worker ID: ensure a unique Snowflake worker ID is persisted ───────────
  migrateWorkerId(db);

  // ─── Namespace replicated users: ensure all federated users use user@domain ─
  migrateReplicatedUsernames(db);

  // ─── Admin flag: ensure at least one admin exists (first registered user) ──
  migrateFirstAdmin(db);

  // ─── Remove USE_VOICE_ACTIVITY bit and shift STREAM/DISCONNECT_MEMBERS down ─
  migrateRemoveVoiceActivityBit(db);

  // ─── Clean up corrupted read_states (temp_ IDs leaked from optimistic messages) ─
  migrateCorruptedReadStates(db);

  // ─── Free usernames from already-tombstoned users ───────────────────────────
  migrateDeletedUsernames(db);

  // ─── Clean up orphaned data from deleted users and channels ────────────────
  migrateOrphanedData(db);

  // ─── Lowercase all existing usernames ────────────────────────────────────────
  migrateLowercaseUsernames(db);

  // ─── Convert video channels to voice (video type removed) ─────────────────
  migrateVideoChannels(db);

  // ─── Backfill profile_updated_at from created_at ──────────────────────────
  migrateProfileUpdatedAt(db);

  // ─── Ensure user_space_layout table exists ────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_space_layout (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      layout TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);

  // ─── Add position column to space_folder_members ──────────────────────────
  {
    const sfmColumns = db.pragma('table_info(space_folder_members)') as { name: string }[];
    if (!sfmColumns.some(c => c.name === 'position')) {
      db.exec('ALTER TABLE space_folder_members ADD COLUMN position INTEGER DEFAULT 0');
      console.log('Migrating: Added position column to space_folder_members');
    }
  }

  // ─── Remove FK constraint from space_folder_members (federated spaces) ────
  {
    const tableInfo = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='space_folder_members'"
    ).get() as { sql: string } | undefined;

    if (tableInfo && tableInfo.sql.includes('REFERENCES spaces')) {
      console.log('Migrating: Removing FK constraint from space_folder_members...');
      db.exec(`
        CREATE TABLE space_folder_members_new (
          folder_id TEXT NOT NULL REFERENCES space_folders(id) ON DELETE CASCADE,
          space_id TEXT NOT NULL,
          position INTEGER DEFAULT 0,
          PRIMARY KEY (folder_id, space_id)
        );
        INSERT INTO space_folder_members_new SELECT folder_id, space_id, position FROM space_folder_members;
        DROP TABLE space_folder_members;
        ALTER TABLE space_folder_members_new RENAME TO space_folder_members;
      `);
    }
  }

  console.log('Migrations complete.');
}

/** Convert legacy JSON array permissions (e.g. '["VIEW_CHANNEL"]') to decimal strings */
function migrateLegacyPermissions(db: Database.Database): void {
  const roles = db.prepare('SELECT id, permissions FROM roles WHERE permissions IS NOT NULL').all() as { id: string; permissions: string }[];
  const update = db.prepare('UPDATE roles SET permissions = ? WHERE id = ?');

  for (const role of roles) {
    // Skip if already a valid decimal string
    try { BigInt(role.permissions); continue; } catch {}

    // Try legacy JSON array
    try {
      const parsed = JSON.parse(role.permissions);
      if (Array.isArray(parsed)) {
        let result = 0n;
        for (const key of parsed) {
          const bit = PermissionBits[key as keyof typeof PermissionBits];
          if (bit !== undefined) result |= bit;
        }
        update.run(result.toString(), role.id);
        console.log(`Migrating: Converted legacy permissions for role ${role.id}`);
        continue;
      }
    } catch { /* not JSON either */ }

    // Unrecognized format — set to 0
    update.run('0', role.id);
    console.log(`Migrating: Reset unrecognized permissions for role ${role.id}`);
  }
}

/** Ensure the single-row instance_settings row exists */
function migrateInstanceSettings(db: Database.Database): void {
  const row = db.prepare('SELECT id FROM instance_settings WHERE id = 1').get();
  if (!row) {
    db.prepare(
      'INSERT OR IGNORE INTO instance_settings (id, max_bitrate_kbps, min_bitrate_kbps, bitrate_step_kbps, allowed_resolutions, allowed_framerates, max_resolution, max_framerate, updated_at) VALUES (1, 20000, 500, 500, ?, ?, 1080, 60, ?)'
    ).run('540,720,1080', '30,45,60', Date.now());
    console.log('Migrating: Inserted default instance_settings row');
  }
}

/** Ensure at least one user has is_admin = 1 (the earliest registered user) */
function migrateFirstAdmin(db: Database.Database): void {
  const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!anyAdmin) {
    const firstUser = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get() as { id: string } | undefined;
    if (firstUser) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
      console.log(`Migrating: Set first user ${firstUser.id} as instance admin`);
    }
  }
}

/**
 * Ensure a unique Snowflake worker ID is persisted for this instance.
 * Generated randomly on first boot (0-1023) and never changed.
 * This prevents ID collisions between federated instances that would
 * otherwise share worker_id = 1 when running as Docker PID 1.
 */
function migrateWorkerId(db: Database.Database): void {
  const row = db.prepare('SELECT worker_id FROM instance_settings WHERE id = 1').get() as { worker_id: number | null } | undefined;
  if (!row || row.worker_id === null) {
    const workerId = crypto.randomInt(0, 1024); // 0-1023 (10-bit range)
    db.prepare('UPDATE instance_settings SET worker_id = ? WHERE id = 1').run(workerId);
    console.log(`Migrating: Generated Snowflake worker ID ${workerId} for this instance`);
  }
}

/** For each space, ensure an @everyone role exists with id === space.id */
function migrateEveryoneRoles(db: Database.Database): void {
  const spaces = db.prepare('SELECT id FROM spaces').all() as { id: string }[];
  const now = Date.now();
  const defaultPerms = permissionsToString(DEFAULT_EVERYONE_PERMISSIONS);
  const adminPerms = permissionsToString(ALL_PERMISSIONS);

  const insertRole = db.prepare(
    'INSERT OR IGNORE INTO roles (id, space_id, name, color, position, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  for (const space of spaces) {
    // Create @everyone role if it doesn't exist (id = space.id)
    insertRole.run(space.id, space.id, '@everyone', '#b9bbbe', 0, defaultPerms, now);
  }

  // Migrate existing admin members: ensure an Admin role exists and assign it
  // Only run if the old `role` column still exists on space_members
  const smColumns = db.pragma('table_info(space_members)') as { name: string }[];
  const hasRoleColumn = smColumns.some(c => c.name === 'role');
  const adminMembers = hasRoleColumn
    ? db.prepare("SELECT space_id, user_id FROM space_members WHERE role = 'admin'").all() as { space_id: string; user_id: string }[]
    : [];

  if (adminMembers.length > 0) {
    // Group by space
    const spaceAdmins = new Map<string, string[]>();
    for (const row of adminMembers) {
      let arr = spaceAdmins.get(row.space_id);
      if (!arr) { arr = []; spaceAdmins.set(row.space_id, arr); }
      arr.push(row.user_id);
    }

    const checkAdminRole = db.prepare(
      "SELECT id FROM roles WHERE space_id = ? AND name = 'Admin' AND permissions = ?"
    );
    const insertMemberRole = db.prepare(
      'INSERT OR IGNORE INTO member_roles (space_id, user_id, role_id) VALUES (?, ?, ?)'
    );

    for (const [spaceId, userIds] of spaceAdmins) {
      // Find or create Admin role for this space
      let adminRole = checkAdminRole.get(spaceId, adminPerms) as { id: string } | undefined;
      if (!adminRole) {
        // Generate a simple unique ID for the admin role
        const adminRoleId = `${spaceId}-admin`;
        insertRole.run(adminRoleId, spaceId, 'Admin', '#e74c3c', 1, adminPerms, now);
        adminRole = { id: adminRoleId };
      }

      for (const userId of userIds) {
        insertMemberRole.run(spaceId, userId, adminRole.id);
      }
    }
  }
}

/**
 * Remove the USE_VOICE_ACTIVITY bit (was bit 25) and shift STREAM (26→25)
 * and DISCONNECT_MEMBERS (27→26) down.
 *
 * Gated behind a persistent `voice_bit_migrated` flag in instance_settings
 * because the old and new bit positions overlap (STREAM moved into the same
 * bit 25 that USE_VOICE_ACTIVITY occupied), making bit-inspection unreliable
 * as an idempotency check. The previous version of this function had exactly
 * that bug — it re-ran on every startup and silently stripped STREAM and
 * DISCONNECT_MEMBERS from every role.
 *
 * On first run with the flag: repairs @everyone roles by re-adding STREAM,
 * then sets the flag so it never runs again.
 */
function migrateRemoveVoiceActivityBit(db: Database.Database): void {
  // Ensure the flag column exists
  const cols = db.pragma('table_info(instance_settings)') as { name: string }[];
  if (!cols.some(c => c.name === 'voice_bit_migrated')) {
    db.exec('ALTER TABLE instance_settings ADD COLUMN voice_bit_migrated INTEGER DEFAULT 0');
  }

  // Check if already migrated
  const row = db.prepare('SELECT voice_bit_migrated FROM instance_settings WHERE id = 1').get() as
    { voice_bit_migrated: number } | undefined;
  if (row && row.voice_bit_migrated === 1) return;

  // The bit-shifting migration already ran (possibly many times) via the old
  // broken code. All roles are already on the new layout (STREAM=25,
  // DISCONNECT_MEMBERS=26). The damage is that repeated re-runs wiped those
  // bits. Repair what we can:

  const STREAM_BIT = 1n << 25n;
  const updateRole = db.prepare('UPDATE roles SET permissions = ? WHERE id = ?');

  // Repair @everyone roles: re-add STREAM where it's missing.
  // @everyone role id === space id, so join on that.
  const spaces = db.prepare('SELECT id FROM spaces').all() as { id: string }[];
  for (const space of spaces) {
    const role = db.prepare('SELECT id, permissions FROM roles WHERE id = ?').get(space.id) as
      { id: string; permissions: string } | undefined;
    if (!role?.permissions) continue;
    try {
      const perms = BigInt(role.permissions);
      if ((perms & STREAM_BIT) === 0n) {
        updateRole.run((perms | STREAM_BIT).toString(), role.id);
        console.log(`Repair: Re-added STREAM to @everyone role for space ${space.id}`);
      }
    } catch { /* skip invalid */ }
  }

  // For non-@everyone roles, warn about potentially lost bits so admins can
  // manually re-enable STREAM / DISCONNECT_MEMBERS if needed.
  const customRoles = db.prepare(
    'SELECT id, space_id, name, permissions FROM roles WHERE id NOT IN (SELECT id FROM spaces) AND permissions IS NOT NULL'
  ).all() as { id: string; space_id: string; name: string; permissions: string }[];

  let warnCount = 0;
  for (const role of customRoles) {
    try {
      const perms = BigInt(role.permissions);
      if ((perms & STREAM_BIT) === 0n) {
        warnCount++;
      }
    } catch { /* skip invalid */ }
  }
  if (warnCount > 0) {
    console.log(
      `Repair: ${warnCount} custom role(s) may be missing STREAM/DISCONNECT_MEMBERS permissions ` +
      `due to a previous migration bug. Admins can re-enable these in Space Settings → Roles.`
    );
  }

  // Set flag so this never runs again
  db.prepare('UPDATE instance_settings SET voice_bit_migrated = 1 WHERE id = 1').run();
  console.log('Migrating: Voice permission bit migration flagged as complete.');
}

/** Delete corrupted read_states rows where last_read_message_id is not a valid snowflake (numeric string) */
function migrateCorruptedReadStates(db: Database.Database): void {
  const deleted = db.prepare(
    "DELETE FROM read_states WHERE last_read_message_id NOT GLOB '[0-9]*' OR last_read_message_id GLOB '*[^0-9]*'"
  ).run();
  if (deleted.changes > 0) {
    console.log(`Migrating: Cleaned up ${deleted.changes} corrupted read_states rows`);
  }
}

/** Rename already-tombstoned users so their original username can be reused */
function migrateDeletedUsernames(db: Database.Database): void {
  const rows = db.prepare(
    "SELECT id, username FROM users WHERE is_deleted = 1 AND username NOT LIKE '!deleted:%'"
  ).all() as { id: string; username: string }[];

  if (rows.length === 0) return;

  const update = db.prepare('UPDATE users SET username = ? WHERE id = ?');
  for (const row of rows) {
    update.run(`!deleted:${row.id}`, row.id);
    console.log(`Migrating: Freed username "${row.username}" from deleted user ${row.id}`);
  }
}

/**
 * Clean up orphaned data left behind by user deletions and channel removals:
 * 1. DM channels with zero members
 * 2. DM attachments/reactions referencing non-existent dm_messages
 * 3. Read states referencing non-existent channels
 * 4. Stale moderator references (bans.banned_by, voice_restrictions.moderator_id, join_requests.decided_by)
 */
function migrateOrphanedData(db: Database.Database): void {
  // 1. Delete DM channels with zero members (cascade cleans dm_messages)
  const orphanedDms = db.prepare(`
    SELECT dc.id FROM dm_channels dc
    WHERE NOT EXISTS (SELECT 1 FROM dm_members dm WHERE dm.dm_channel_id = dc.id)
  `).all() as { id: string }[];

  if (orphanedDms.length > 0) {
    const deleteAttachments = db.prepare(
      'DELETE FROM attachments WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id = ?)'
    );
    const deleteReactions = db.prepare(
      'DELETE FROM dm_reactions WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id = ?)'
    );
    const deleteDmChannel = db.prepare('DELETE FROM dm_channels WHERE id = ?');

    for (const { id } of orphanedDms) {
      deleteAttachments.run(id);
      deleteReactions.run(id);
      deleteDmChannel.run(id);
    }
    console.log(`Migrating: Cleaned up ${orphanedDms.length} orphaned DM channels`);
  }

  // 2. Delete orphaned DM attachments referencing non-existent dm_messages
  const orphanedAtts = db.prepare(`
    DELETE FROM attachments
    WHERE dm_message_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dm_messages WHERE dm_messages.id = attachments.dm_message_id)
  `).run();
  if (orphanedAtts.changes > 0) {
    console.log(`Migrating: Cleaned up ${orphanedAtts.changes} orphaned DM attachments`);
  }

  // 3. Delete orphaned DM reactions referencing non-existent dm_messages
  const orphanedReactions = db.prepare(`
    DELETE FROM dm_reactions
    WHERE NOT EXISTS (SELECT 1 FROM dm_messages WHERE dm_messages.id = dm_reactions.dm_message_id)
  `).run();
  if (orphanedReactions.changes > 0) {
    console.log(`Migrating: Cleaned up ${orphanedReactions.changes} orphaned DM reactions`);
  }

  // 4. Delete orphaned read_states referencing non-existent channels (or DM channels)
  const orphanedReadStates = db.prepare(`
    DELETE FROM read_states
    WHERE NOT EXISTS (SELECT 1 FROM channels WHERE channels.id = read_states.channel_id)
      AND NOT EXISTS (SELECT 1 FROM dm_channels WHERE dm_channels.id = read_states.channel_id)
  `).run();
  if (orphanedReadStates.changes > 0) {
    console.log(`Migrating: Cleaned up ${orphanedReadStates.changes} orphaned read_states`);
  }

  // 5. Nullify stale moderator references pointing to deleted users
  try {
    const staleBans = db.prepare(`
      UPDATE bans SET banned_by = NULL
      WHERE banned_by IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = bans.banned_by AND users.is_deleted = 0)
    `).run();
    if (staleBans.changes > 0) {
      console.log(`Migrating: Nullified ${staleBans.changes} stale bans.banned_by references`);
    }
  } catch { /* bans table may not exist yet */ }

  try {
    const staleVoice = db.prepare(`
      UPDATE voice_restrictions SET moderator_id = NULL
      WHERE moderator_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = voice_restrictions.moderator_id AND users.is_deleted = 0)
    `).run();
    if (staleVoice.changes > 0) {
      console.log(`Migrating: Nullified ${staleVoice.changes} stale voice_restrictions.moderator_id references`);
    }
  } catch { /* voice_restrictions table may not exist yet */ }

  try {
    const staleJoinReqs = db.prepare(`
      UPDATE join_requests SET decided_by = NULL
      WHERE decided_by IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = join_requests.decided_by AND users.is_deleted = 0)
    `).run();
    if (staleJoinReqs.changes > 0) {
      console.log(`Migrating: Nullified ${staleJoinReqs.changes} stale join_requests.decided_by references`);
    }
  } catch { /* join_requests table may not exist yet */ }
}

/**
 * Rename non-namespaced replicated users: e.g. "test" → "test@nova.ddns.net"
 * Frees plain usernames for native user creation and makes all federated users
 * visually consistent. Safe because JWTs validate by userId, not username.
 */
/**
 * Lowercase all existing native usernames. Skips federated users (contain @)
 * and tombstoned users (!deleted: prefix). If lowercasing would cause a collision,
 * skip that user to avoid data loss.
 */
function migrateLowercaseUsernames(db: Database.Database): void {
  const rows = db.prepare(
    "SELECT id, username FROM users WHERE username NOT LIKE '%@%' AND username NOT LIKE '!deleted:%'"
  ).all() as { id: string; username: string }[];

  const needsUpdate = rows.filter(r => r.username !== r.username.toLowerCase());
  if (needsUpdate.length === 0) return;

  const checkExisting = db.prepare('SELECT id FROM users WHERE username = ?');
  const update = db.prepare('UPDATE users SET username = ? WHERE id = ?');

  for (const row of needsUpdate) {
    const lower = row.username.toLowerCase();
    // Check for collision (another user already has the lowercase version)
    const existing = checkExisting.get(lower) as { id: string } | undefined;
    if (existing && existing.id !== row.id) {
      console.log(`Migrating: Skipping lowercase of "${row.username}" — "${lower}" already taken by user ${existing.id}`);
      continue;
    }
    update.run(lower, row.id);
    console.log(`Migrating: Lowercased username "${row.username}" → "${lower}"`);
  }
}

/** Convert any existing video channels to voice (video type removed — voice channels have full video capability) */
function migrateVideoChannels(db: Database.Database): void {
  const result = db.prepare("UPDATE channels SET type = 'voice' WHERE type = 'video'").run();
  if (result.changes > 0) {
    console.log(`Migrating: Converted ${result.changes} video channel(s) to voice`);
  }
}

/** Backfill profile_updated_at from created_at for existing users */
function migrateProfileUpdatedAt(db: Database.Database): void {
  const result = db.prepare(
    'UPDATE users SET profile_updated_at = created_at WHERE profile_updated_at IS NULL'
  ).run();
  if (result.changes > 0) {
    console.log(`Migrating: Backfilled profile_updated_at for ${result.changes} user(s)`);
  }
}

function migrateReplicatedUsernames(db: Database.Database): void {
  const rows = db.prepare(
    "SELECT id, username, home_instance FROM users WHERE home_instance IS NOT NULL AND username NOT LIKE '%@%'"
  ).all() as { id: string; username: string; home_instance: string }[];

  if (rows.length === 0) return;

  const update = db.prepare('UPDATE users SET username = ? WHERE id = ?');
  for (const row of rows) {
    const newUsername = `${row.username}@${row.home_instance}`;
    update.run(newUsername, row.id);
    console.log(`Migrating: Renamed replicated user "${row.username}" → "${newUsername}"`);
  }
}
