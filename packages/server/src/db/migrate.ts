import Database from 'better-sqlite3';
import { DEFAULT_EVERYONE_PERMISSIONS, PermissionBits, ALL_PERMISSIONS, permissionsToString } from '@opencord/shared/src/permissions.js';

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

  // ─── RBAC Migration: Ensure @everyone roles exist for all servers ─────────
  migrateEveryoneRoles(db);

  // ─── Instance settings: ensure default row exists ──────────────────────────
  migrateInstanceSettings(db);

  // ─── Admin flag: ensure at least one admin exists (first registered user) ──
  migrateFirstAdmin(db);

  console.log('Migrations complete.');
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

/** For each server, ensure an @everyone role exists with id === server.id */
function migrateEveryoneRoles(db: Database.Database): void {
  const servers = db.prepare('SELECT id FROM servers').all() as { id: string }[];
  const now = Date.now();
  const defaultPerms = permissionsToString(DEFAULT_EVERYONE_PERMISSIONS);
  const adminPerms = permissionsToString(ALL_PERMISSIONS);

  const insertRole = db.prepare(
    'INSERT OR IGNORE INTO roles (id, server_id, name, color, position, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  for (const server of servers) {
    // Create @everyone role if it doesn't exist (id = server.id)
    insertRole.run(server.id, server.id, '@everyone', '#b9bbbe', 0, defaultPerms, now);
  }

  // Migrate existing admin members: ensure an Admin role exists and assign it
  const adminMembers = db.prepare(
    "SELECT server_id, user_id FROM server_members WHERE role = 'admin'"
  ).all() as { server_id: string; user_id: string }[];

  if (adminMembers.length > 0) {
    // Group by server
    const serverAdmins = new Map<string, string[]>();
    for (const row of adminMembers) {
      let arr = serverAdmins.get(row.server_id);
      if (!arr) { arr = []; serverAdmins.set(row.server_id, arr); }
      arr.push(row.user_id);
    }

    const checkAdminRole = db.prepare(
      "SELECT id FROM roles WHERE server_id = ? AND name = 'Admin' AND permissions = ?"
    );
    const insertMemberRole = db.prepare(
      'INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)'
    );

    for (const [serverId, userIds] of serverAdmins) {
      // Find or create Admin role for this server
      let adminRole = checkAdminRole.get(serverId, adminPerms) as { id: string } | undefined;
      if (!adminRole) {
        // Generate a simple unique ID for the admin role
        const adminRoleId = `${serverId}-admin`;
        insertRole.run(adminRoleId, serverId, 'Admin', '#e74c3c', 1, adminPerms, now);
        adminRole = { id: adminRoleId };
      }

      for (const userId of userIds) {
        insertMemberRole.run(serverId, userId, adminRole.id);
      }
    }
  }
}
