import type { User, ReplicatedInstance } from '@backspace/shared';
import { schema } from '../db/index.js';

export function sanitizeUser(row: typeof schema.users.$inferSelect, isSelf = false): User {
  // Tombstoned (deleted) users — return anonymized profile
  if (row.isDeleted === 1) {
    return {
      id: row.id,
      username: 'Deleted User',
      displayName: null,
      avatar: null,
      banner: null,
      accentColor: null,
      avatarColor: null,
      bio: null,
      status: 'offline',
      customStatus: null,
      isAdmin: false,
      isDeleted: true,
      discoverable: false,
      profileUpdatedAt: 0,
      createdAt: row.createdAt,
      homeInstance: null,
      homeUserId: null,
      replicatedInstances: [],
      ...(isSelf ? { showActivity: false } : {}),
    };
  }

  let replicatedInstances: ReplicatedInstance[] = [];
  if (row.replicatedInstances) {
    try {
      replicatedInstances = JSON.parse(row.replicatedInstances);
    } catch {
      replicatedInstances = [];
    }
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar,
    banner: row.banner ?? null,
    accentColor: row.accentColor ?? null,
    avatarColor: (row.avatarColor as User['avatarColor']) ?? null,
    bio: row.bio ?? null,
    status: (row.status ?? 'offline') as User['status'],
    customStatus: row.customStatus,
    isAdmin: row.isAdmin === 1,
    discoverable: row.discoverable !== 0,
    profileUpdatedAt: row.profileUpdatedAt ?? 0,
    createdAt: row.createdAt,
    homeInstance: row.homeInstance ?? null,
    homeUserId: row.homeUserId ?? null,
    replicatedInstances,
    ...(isSelf ? { showActivity: row.showActivity !== 0 } : {}),
  };
}
