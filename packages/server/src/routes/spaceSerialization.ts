import type { Space } from '@backspace/shared';
import type { schema } from '../db/index.js';

export function rowToSpace(row: typeof schema.spaces.$inferSelect): Space {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    banner: row.banner ?? null,
    avatarColor: (row.avatarColor as Space['avatarColor']) ?? null,
    ownerId: row.ownerId,
    ownerTitle: row.ownerTitle,
    inviteCode: row.inviteCode,
    visibility: (row.visibility ?? 'private') as Space['visibility'],
    directoryListed: row.directoryListed === 1,
    description: row.description ?? null,
    createdAt: row.createdAt,
  };
}
