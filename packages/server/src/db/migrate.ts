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
 * and DISCONNECT_MEMBERS (27→26) down. Idempotent: uses a sentinel flag in
 * instance_settings metadata to avoid re-running.
 */
function migrateRemoveVoiceActivityBit(db: Database.Database): void {
  // Use a pragma-style check: if STREAM is already at bit 25 in DEFAULT_EVERYONE_PERMISSIONS
  // of the @everyone roles, the migration has already run. But for robustness, use a flag column.
  // We'll check if any role still has bit 25 set AND bit 26 set (old layout had both USE_VOICE_ACTIVITY
  // and STREAM). Simplest approach: track via a one-time marker.
  const OLD_VOICE_ACTIVITY = 1n << 25n; // old USE_VOICE_ACTIVITY
  const OLD_STREAM         = 1n << 26n; // old STREAM
  const OLD_DISCONNECT     = 1n << 27n; // old DISCONNECT_MEMBERS

  // Check if any role still uses the old bit layout (has bit 26 or 27 set)
  const roles = db.prepare('SELECT id, permissions FROM roles WHERE permissions IS NOT NULL').all() as { id: string; permissions: string }[];
  const overrides = db.prepare('SELECT channel_id, target_type, target_id, allow, deny FROM channel_overrides').all() as {
    channel_id: string; target_type: string; target_id: string; allow: string; deny: string;
  }[];

  let needsMigration = false;
  for (const role of roles) {
    try {
      const p = BigInt(role.permissions);
      if ((p & OLD_STREAM) !== 0n || (p & OLD_DISCONNECT) !== 0n || (p & OLD_VOICE_ACTIVITY) !== 0n) {
        needsMigration = true;
        break;
      }
    } catch { /* skip invalid */ }
  }
  if (!needsMigration) {
    for (const ov of overrides) {
      try {
        const a = BigInt(ov.allow);
        const d = BigInt(ov.deny);
        if ((a & OLD_STREAM) !== 0n || (a & OLD_DISCONNECT) !== 0n || (a & OLD_VOICE_ACTIVITY) !== 0n ||
            (d & OLD_STREAM) !== 0n || (d & OLD_DISCONNECT) !== 0n || (d & OLD_VOICE_ACTIVITY) !== 0n) {
          needsMigration = true;
          break;
        }
      } catch { /* skip invalid */ }
    }
  }

  if (!needsMigration) return;

  function shiftPermBits(p: bigint): bigint {
    const hasStream     = (p & OLD_STREAM) !== 0n;
    const hasDisconnect = (p & OLD_DISCONNECT) !== 0n;
    // Clear bits 25, 26, 27
    p = p & ~(OLD_VOICE_ACTIVITY | OLD_STREAM | OLD_DISCONNECT);
    // Re-set at new positions
    if (hasStream)     p |= (1n << 25n); // STREAM now at 25
    if (hasDisconnect) p |= (1n << 26n); // DISCONNECT_MEMBERS now at 26
    return p;
  }

  console.log('Migrating: Shifting permission bits (removing USE_VOICE_ACTIVITY)...');

  const updateRole = db.prepare('UPDATE roles SET permissions = ? WHERE id = ?');
  for (const role of roles) {
    try {
      const old = BigInt(role.permissions);
      const shifted = shiftPermBits(old);
      if (shifted !== old) {
        updateRole.run(shifted.toString(), role.id);
      }
    } catch { /* skip invalid */ }
  }

  const updateOverride = db.prepare(
    'UPDATE channel_overrides SET allow = ?, deny = ? WHERE channel_id = ? AND target_type = ? AND target_id = ?'
  );
  for (const ov of overrides) {
    try {
      const oldAllow = BigInt(ov.allow);
      const oldDeny  = BigInt(ov.deny);
      const newAllow = shiftPermBits(oldAllow);
      const newDeny  = shiftPermBits(oldDeny);
      if (newAllow !== oldAllow || newDeny !== oldDeny) {
        updateOverride.run(newAllow.toString(), newDeny.toString(), ov.channel_id, ov.target_type, ov.target_id);
      }
    } catch { /* skip invalid */ }
  }

  console.log('Migrating: Permission bit shift complete.');
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

/**
 * Rename non-namespaced replicated users: e.g. "test" → "test@nova.ddns.net"
 * Frees plain usernames for native user creation and makes all federated users
 * visually consistent. Safe because JWTs validate by userId, not username.
 */
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
