import type { User, ReplicatedInstance } from '@backspace/shared';
import { schema } from '../db/index.js';

export function sanitizeUser(row: typeof schema.users.$inferSelect): User {
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
    status: (row.status ?? 'offline') as User['status'],
    customStatus: row.customStatus,
    isAdmin: row.isAdmin === 1,
    createdAt: row.createdAt,
    homeInstance: row.homeInstance ?? null,
    homeUserId: row.homeUserId ?? null,
    replicatedInstances,
  };
}
