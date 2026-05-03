import Database from 'better-sqlite3';
import type { SpawnedInstance } from './twoInstanceHarness.js';

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  bio: string | null;
  customStatus: string | null;
  accentColor: string | null;
  avatarColor: string | null;
  replicatedInstances: string;
  isDeleted: number;
  status: string;
  isAdmin: number;
  homeInstance: string | null;
  homeUserId: string | null;
}

export interface DbInspector {
  user(uid: string): UserRow | null;
  userByUsername(username: string): UserRow | null;
  spaceMembersForUser(uid: string): { spaceId: string; userId: string }[];
  reactionsForUser(uid: string): { messageId: string; userId: string; emoji: string }[];
  dmReactionsForUser(uid: string): { dmMessageId: string; userId: string; emoji: string }[];
  messagesAuthored(uid: string): { id: string; userId: string; content: string }[];
  dmMembership(uid: string): { dmChannelId: string; userId: string }[];
  dmChannelExists(dmChannelId: string): boolean;
  registryRow(userId: string, origin: string): unknown;
  replicatedInstancesArray(userId: string): { origin: string }[];
  close(): void;
}

export function openInspector(instance: SpawnedInstance): DbInspector {
  const db = new Database(instance.dbPath, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  return {
    user: (uid) => db.prepare(`
      SELECT id, username,
        password_hash AS passwordHash,
        display_name AS displayName,
        avatar, banner, bio,
        custom_status AS customStatus,
        accent_color AS accentColor,
        avatar_color AS avatarColor,
        replicated_instances AS replicatedInstances,
        is_deleted AS isDeleted,
        status,
        is_admin AS isAdmin,
        home_instance AS homeInstance,
        home_user_id AS homeUserId
      FROM users WHERE id = ?
    `).get(uid) as UserRow | null,
    userByUsername: (u) => db.prepare(`
      SELECT id, username,
        password_hash AS passwordHash,
        display_name AS displayName,
        avatar, banner, bio,
        custom_status AS customStatus,
        accent_color AS accentColor,
        avatar_color AS avatarColor,
        replicated_instances AS replicatedInstances,
        is_deleted AS isDeleted,
        status,
        is_admin AS isAdmin,
        home_instance AS homeInstance,
        home_user_id AS homeUserId
      FROM users WHERE username = ?
    `).get(u) as UserRow | null,
    spaceMembersForUser: (uid) =>
      db.prepare('SELECT space_id AS spaceId, user_id AS userId FROM space_members WHERE user_id = ?').all(uid) as { spaceId: string; userId: string }[],
    reactionsForUser: (uid) =>
      db.prepare('SELECT message_id AS messageId, user_id AS userId, emoji FROM reactions WHERE user_id = ?').all(uid) as { messageId: string; userId: string; emoji: string }[],
    dmReactionsForUser: (uid) =>
      db.prepare('SELECT dm_message_id AS dmMessageId, user_id AS userId, emoji FROM dm_reactions WHERE user_id = ?').all(uid) as { dmMessageId: string; userId: string; emoji: string }[],
    messagesAuthored: (uid) =>
      db.prepare('SELECT id, user_id AS userId, content FROM messages WHERE user_id = ?').all(uid) as { id: string; userId: string; content: string }[],
    dmMembership: (uid) =>
      db.prepare('SELECT dm_channel_id AS dmChannelId, user_id AS userId FROM dm_members WHERE user_id = ?').all(uid) as { dmChannelId: string; userId: string }[],
    dmChannelExists: (id) => {
      const row = db.prepare('SELECT 1 AS one FROM dm_channels WHERE id = ?').get(id);
      return !!row;
    },
    registryRow: (userId, origin) =>
      db.prepare('SELECT * FROM user_federation_registry WHERE user_id = ? AND origin = ?').get(userId, origin),
    replicatedInstancesArray: (userId) => {
      const row = db.prepare('SELECT replicated_instances AS replicatedInstances FROM users WHERE id = ?').get(userId) as { replicatedInstances: string } | undefined;
      if (!row?.replicatedInstances) return [];
      try { return JSON.parse(row.replicatedInstances); } catch { return []; }
    },
    close: () => db.close(),
  };
}
