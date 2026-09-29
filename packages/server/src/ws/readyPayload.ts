import type { ActiveCallInfo, Activity, Channel, ChannelCategory, DmChannel, MemberWithUser, PresenceIdentity, ReadState, Space, SpaceFolder, SpaceLayoutItem, SpaceWithChannelsAndMembers, User } from '@backspace/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { listNotificationSettings } from '../routes/notificationSettings.js';
import { computePermissions, PermissionBits, permissionsToString } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { channelUnreadCounts, dmUnreadCounts } from './channelUnreadCounts.js';
import { loadOpenDmChannels } from '../utils/dmChannelWire.js';
import { presenceIdentityOf, snapshotActivities } from './presenceEvent.js';
import { connectionManager } from './handler.js';
import { type DmRoomMeta } from './voiceRoomTypes.js';

// SQLite's SQLITE_MAX_VARIABLE_NUMBER default is 999.
// Chunk inArray() calls to stay safely under this limit.
const BATCH_CHUNK_SIZE = 500;

function batchInArray<TId, TResult>(ids: TId[], queryFn: (chunk: TId[]) => TResult[]): TResult[] {
  if (ids.length <= BATCH_CHUNK_SIZE) return queryFn(ids);
  const results: TResult[] = [];
  for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
    results.push(...queryFn(ids.slice(i, i + BATCH_CHUNK_SIZE)));
  }
  return results;
}


function buildReadySpaces(userId: string) {
  const db = getDb();
  // Get user's space memberships
  const memberships = db.select()
    .from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.userId, userId))
    .all();

  const spaceIds = memberships.map(m => m.spaceId);

  const visibleChannelIdSet = new Set<string>();
  const spaces: SpaceWithChannelsAndMembers[] = [];

  if (spaceIds.length > 0) {
    const spaceRows = db.select()
      .from(schema.spaces)
      .where(inArray(schema.spaces.id, spaceIds))
      .all();

    // Batch: all channels for all spaces (1 query instead of N)
    const allChannels = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channels).where(inArray(schema.channels.spaceId, ids)).all(),
    );
    const channelsBySpace = new Map<string, (typeof allChannels)>();
    for (const ch of allChannels) {
      let arr = channelsBySpace.get(ch.spaceId);
      if (!arr) { arr = []; channelsBySpace.set(ch.spaceId, arr); }
      arr.push(ch);
    }

    // Batch: determine which channels are private (VIEW_CHANNEL denied on @everyone)
    // @everyone role ID equals the space ID, so we query for overrides targeting role = spaceId
    const allEveroneOverrides = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channelOverrides).where(
        and(
          eq(schema.channelOverrides.targetType, 'role'),
          inArray(schema.channelOverrides.targetId, ids),
        )
      ).all(),
    );
    const privateChannelIds = new Set<string>();
    for (const o of allEveroneOverrides) {
      const denyBits = BigInt(o.deny || '0');
      if ((denyBits & PermissionBits.VIEW_CHANNEL) !== 0n) {
        privateChannelIds.add(o.channelId);
      }
    }

    // Batch: all categories for all spaces (1 query instead of N)
    const allCategories = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channelCategories).where(inArray(schema.channelCategories.spaceId, ids)).all(),
    );
    const categoriesBySpace = new Map<string, ChannelCategory[]>();
    for (const cat of allCategories) {
      let arr = categoriesBySpace.get(cat.spaceId);
      if (!arr) { arr = []; categoriesBySpace.set(cat.spaceId, arr); }
      arr.push({
        id: cat.id,
        spaceId: cat.spaceId,
        name: cat.name,
        position: cat.position ?? 0,
        createdAt: cat.createdAt,
      });
    }

    // Batch: last message ID per channel (1 query instead of N×C)
    const allChannelIds = allChannels.map(ch => ch.id);
    const lastMsgMap = new Map<string, string>();
    if (allChannelIds.length > 0) {
      const lastMsgRows = batchInArray(
        allChannelIds,
        ids => db.select({
          channelId: schema.messages.channelId,
          lastId: sql<string>`max(${schema.messages.id})`,
        }).from(schema.messages).where(and(inArray(schema.messages.channelId, ids), eq(schema.messages.type, 'user'))).groupBy(schema.messages.channelId).all(),
      );
      for (const row of lastMsgRows) {
        if (row.lastId) lastMsgMap.set(row.channelId, row.lastId);
      }
    }

    for (const spaceRow of spaceRows) {
      const channels = channelsBySpace.get(spaceRow.id) ?? [];

      const roles = db.select()
        .from(schema.roles)
        .where(eq(schema.roles.spaceId, spaceRow.id))
        .orderBy(schema.roles.position)
        .all();

      const memberRows = db.select()
        .from(schema.spaceMembers)
        .where(eq(schema.spaceMembers.spaceId, spaceRow.id))
        .all();

      const memberUserIds = memberRows.map(m => m.userId);
      const users = memberUserIds.length > 0
        ? batchInArray(memberUserIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
        : [];
      const userMap = new Map(users.map(u => [u.id, u]));

      const memberRoleRows = db.select()
        .from(schema.memberRoles)
        .where(eq(schema.memberRoles.spaceId, spaceRow.id))
        .all();

      const members: MemberWithUser[] = memberRows
        .map(m => {
          const u = userMap.get(m.userId);
          if (!u) return null;

          const assignedRoleIds = memberRoleRows
            .filter(mr => mr.userId === m.userId)
            .map(mr => mr.roleId);

          const memberRoles = roles
            .filter(r => assignedRoleIds.includes(r.id))
            .map(r => ({
              id: r.id,
              spaceId: r.spaceId,
              name: r.name,
              color: r.color ?? '#b9bbbe',
              position: r.position ?? 0,
              createdAt: r.createdAt,
            }));

          return {
            spaceId: m.spaceId,
            userId: m.userId,
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            user: sanitizeUser(u),
            roles: memberRoles,
          };
        })
        .filter((m): m is MemberWithUser => m !== null);

      // Compute space-level permissions for this user
      const spacePerms = computePermissions(userId, spaceRow.id);

      // Filter channels by VIEW_CHANNEL and attach per-channel permissions
      const visibleChannels: Channel[] = [];
      for (const ch of channels) {
        const chPerms = computePermissions(userId, spaceRow.id, ch.id);
        const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
        if (hasView) {
          visibleChannelIdSet.add(ch.id);
          visibleChannels.push({
            id: ch.id,
            spaceId: ch.spaceId,
            name: ch.name,
            type: ch.type as Channel['type'],
            topic: ch.topic,
            position: ch.position ?? 0,
            categoryId: ch.categoryId ?? null,
            isPrivate: privateChannelIds.has(ch.id),
            createdAt: ch.createdAt,
            lastMessageId: lastMsgMap.get(ch.id) ?? null,
            myPermissions: permissionsToString(chPerms),
          });
        }
      }

      spaces.push({
        id: spaceRow.id,
        name: spaceRow.name,
        icon: spaceRow.icon,
        banner: spaceRow.banner ?? null,
        avatarColor: (spaceRow.avatarColor as Space['avatarColor']) ?? null,
        ownerId: spaceRow.ownerId,
        ownerTitle: spaceRow.ownerTitle,
        inviteCode: spaceRow.inviteCode,
        visibility: (spaceRow.visibility ?? 'private') as SpaceWithChannelsAndMembers['visibility'],
        directoryListed: spaceRow.directoryListed === 1,
        description: spaceRow.description ?? null,
        createdAt: spaceRow.createdAt,
        channels: visibleChannels,
        categories: categoriesBySpace.get(spaceRow.id) ?? [],
        members,
        roles: roles.map(r => ({
          id: r.id,
          spaceId: r.spaceId,
          name: r.name,
          color: r.color ?? '#b9bbbe',
          position: r.position ?? 0,
          permissions: r.permissions ?? undefined,
          isEveryone: r.id === spaceRow.id,
          createdAt: r.createdAt,
        })),
        myPermissions: permissionsToString(spacePerms),
      });
    }
  }

  // Store user's space IDs for broadcasting
  connectionManager.setUserSpaces(userId, spaceIds);

  return { spaces, visibleChannelIdSet };
}

function buildReadyDmChannels(userId: string) {
  const db = getDb();
  const dmMemberships = db.select()
    .from(schema.dmMembers)
    .where(and(eq(schema.dmMembers.userId, userId), eq(schema.dmMembers.closed, 0)))
    .all();

  const dmChannels = loadOpenDmChannels(db, userId, dmMemberships);
  return { dmChannels, dmMemberships };
}

export function buildReadyPayload(userId: string): {
  user: User;
  spaces: SpaceWithChannelsAndMembers[];
  dmChannels: DmChannel[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  layoutUpdatedAt: number | null;
  voiceStates: Record<string, string[]>;
  voiceChannelElapsedSeconds: Record<string, number>;
  voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }>;
  notificationSettings: import("@backspace/shared").NotificationSetting[];
  unreadCounts: Record<string, number>;
  supportsPoke: boolean;
  readStates: ReadState[];
  activeCalls: ActiveCallInfo[];
  userActivities: Record<string, Activity[]>;
  userActivityIdentities?: Record<string, PresenceIdentity>;
  rejectedPeerOrigins: string[];
  awaitingApprovalPeerOrigins: string[];
  activePeerOrigins: string[];
  pendingApprovalCount: number;
} {
  const db = getDb();

  // Get user
  const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!userRow) {
    throw new Error('User not found');
  }
  const user = sanitizeUser(userRow, true);
  const isFederated = !!userRow.homeInstance;

  // Cache showActivity and status for Rich Presence
  connectionManager.setUserShowActivity(userId, userRow.showActivity !== 0);
  connectionManager.setUserStatus(userId, (userRow.status ?? 'offline') as string);

  const { spaces, visibleChannelIdSet } = buildReadySpaces(userId);

  const { dmChannels, dmMemberships } = buildReadyDmChannels(userId);
  // Include DM channel IDs in the visible set for read state filtering
  for (const dm of dmChannels) {
    visibleChannelIdSet.add(dm.id);
  }

  // Get Space Folders
  const folderRows = db.select()
    .from(schema.spaceFolders)
    .where(eq(schema.spaceFolders.userId, userId))
    .orderBy(schema.spaceFolders.position)
    .all();

  const folders: SpaceFolder[] = [];
  for (const folder of folderRows) {
    const folderSpaceIds = db.select()
      .from(schema.spaceFolderMembers)
      .where(eq(schema.spaceFolderMembers.folderId, folder.id))
      .orderBy(schema.spaceFolderMembers.position)
      .all()
      .map(m => m.spaceId);

    folders.push({
      id: folder.id,
      userId: folder.userId,
      name: folder.name,
      color: folder.color,
      position: folder.position ?? 0,
      spaceIds: folderSpaceIds,
    });
  }

  // Get user space layout
  const layoutRow = db.select().from(schema.userSpaceLayout)
    .where(eq(schema.userSpaceLayout.userId, userId)).get();
  const spaceLayout: SpaceLayoutItem[] | null = layoutRow ? JSON.parse(layoutRow.layout) : null;
  const layoutUpdatedAt: number | null = layoutRow?.updatedAt ?? null;

  // Build voice states — who is currently in voice channels, plus space mute/
  // deafen and permission-mute, across all the user's spaces. Delegates to the
  // shared per-space helper (also used for the mid-session join push in
  // ConnectionManager.addUserSpace) so the two code paths can never diverge.
  // The helper applies the same VIEW_CHANNEL filtering used when building the
  // `spaces` array above.
  const voiceStates: Record<string, string[]> = {};
  const voiceChannelElapsedSeconds: Record<string, number> = {};
  const spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }> = {};
  for (const space of spaces) {
    const snap = connectionManager.buildSpaceVoiceState(space.id, userId);
    Object.assign(voiceStates, snap.voiceStates);
    Object.assign(voiceChannelElapsedSeconds, snap.voiceChannelElapsedSeconds);
    Object.assign(spaceVoiceStates, snap.spaceVoiceStates);
  }

  // Build active calls from user's DM memberships
  const activeCalls: ActiveCallInfo[] = [];
  for (const dm of dmMemberships) {
    const room = connectionManager.getRoom(dm.dmChannelId);
    if (room && room.roomType === 'dm') {
      const dmMeta = room.metadata as DmRoomMeta;
      activeCalls.push({
        dmChannelId: dm.dmChannelId,
        callerId: dmMeta.callerId,
        participants: Array.from(room.participants),
        startedAt: room.startedAt,
        state: dmMeta.state,
      });
      // Inject DM call participants into voiceStates so frontend's generic handler works
      if (room.participants.size > 0) {
        voiceStates[dm.dmChannelId] = Array.from(room.participants);
      }
    }
  }

  // Resolve this user's homeUserId for token lookup
  const readyUser = db.select({ homeUserId: schema.users.homeUserId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  const myHomeUserId = readyUser?.homeUserId || userId;

  // Also include federated calls (this instance is NOT the host)
  for (const [_fedId, fedCall] of connectionManager.getAllFederatedCalls()) {
    const isParticipant = fedCall.ringedUserIds.includes(userId);
    const isDmMember = fedCall.dmChannelId && dmMemberships.some(dm => dm.dmChannelId === fedCall.dmChannelId);
    if (isParticipant || isDmMember) {
      activeCalls.push({
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: fedCall.federatedId,
        callerId: fedCall.callerId,
        participants: [],
        startedAt: fedCall.startedAt,
        state: fedCall.state,
        federatedCallHost: fedCall.federatedCallHost,
        livekitUrl: fedCall.livekitUrl,
        livekitToken: fedCall.tokens.get(myHomeUserId),
      });
    }
  }

  // Build voice user states — includes both space and DM participants now
  const voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> = {};
  for (const chId of Object.keys(voiceStates)) {
    const usersInChannel = voiceStates[chId];
    if (usersInChannel) {
      for (const uid of usersInChannel) {
        const status = connectionManager.getVoiceUserStatus(uid);
        if (status) {
          voiceUserStates[uid] = status;
        }
      }
    }
  }

  // Fetch read states for unread tracking
  const readStateRows = db.select()
    .from(schema.readStates)
    .where(eq(schema.readStates.userId, userId))
    .all();

  const readStates: ReadState[] = readStateRows
    .filter(rs => !isFederated || visibleChannelIdSet.has(rs.channelId))
    .map(rs => ({
      channelId: rs.channelId,
      lastReadMessageId: rs.lastReadMessageId,
    }));

  // Build user activities snapshot for all visible users: space members, DM
  // members and friends (a friend may share neither with the user). Keys are
  // this instance's row ids; userActivityIdentities names each key's federated
  // identity so the client can key it like every other view of that person.
  // Auto-inject customStatus as a 'custom' activity for users with no ephemeral activities
  const userActivities: Record<string, Activity[]> = {};
  const userActivityIdentities: Record<string, PresenceIdentity> = {};
  const seenUserIds = new Set<string>();

  function collectUserActivities(
    subject: { id: string; homeUserId: string | null; homeInstance: string | null; customStatus: string | null },
  ) {
    if (seenUserIds.has(subject.id)) return;
    seenUserIds.add(subject.id);
    const acts = snapshotActivities(connectionManager.getUserActivities(subject.id), subject.customStatus);
    if (acts.length > 0) {
      userActivities[subject.id] = acts;
      userActivityIdentities[subject.id] = presenceIdentityOf(subject);
    }
  }

  for (const space of spaces) {
    for (const member of space.members) {
      collectUserActivities({
        id: member.userId,
        homeUserId: member.user?.homeUserId ?? null,
        homeInstance: member.user?.homeInstance ?? null,
        customStatus: member.user?.customStatus ?? null,
      });
    }
  }
  for (const dm of dmChannels) {
    for (const member of dm.members) {
      collectUserActivities({
        id: member.id,
        homeUserId: member.homeUserId ?? null,
        homeInstance: member.homeInstance ?? null,
        customStatus: member.customStatus ?? null,
      });
    }
  }
  const friendIds = db.select({ userId: schema.friends.userId, friendId: schema.friends.friendId })
    .from(schema.friends)
    .where(or(eq(schema.friends.userId, userId), eq(schema.friends.friendId, userId)))
    .all()
    .map(f => (f.userId === userId ? f.friendId : f.userId));
  if (friendIds.length > 0) {
    const friendRows = db.select({
      id: schema.users.id,
      homeUserId: schema.users.homeUserId,
      homeInstance: schema.users.homeInstance,
      customStatus: schema.users.customStatus,
    })
      .from(schema.users)
      .where(inArray(schema.users.id, friendIds))
      .all();
    for (const friend of friendRows) collectUserActivities(friend);
  }

  // Rejected peer origins for unreachable member indicators
  const rejectedPeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'rejected'))
    .all();
  const rejectedPeerOrigins = rejectedPeers.map(p => p.origin);

  // Awaiting-approval peer origins for softer unreachable indicators
  const awaitingApprovalPeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'awaiting_approval'))
    .all();
  const awaitingApprovalPeerOrigins = awaitingApprovalPeers.map(p => p.origin);

  // Active peer origins — client uses this allowlist to gate DM events from remote instances
  const activePeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'active'))
    .all();
  const activePeerOrigins = activePeers.map(p => p.origin);

  // Pending approval count for admin notification
  let pendingApprovalCount = 0;
  if (userRow?.isAdmin === 1) {
    const countResult = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.peerApprovalRequests)
      .get();
    pendingApprovalCount = countResult?.count ?? 0;
  }

  return {
    user,
    spaces,
    dmChannels,
    folders,
    spaceLayout,
    layoutUpdatedAt,
    voiceStates,
    voiceChannelElapsedSeconds,
    voiceUserStates,
    spaceVoiceStates,
    supportsPoke: true,
    unreadCounts: {
      ...channelUnreadCounts(userId, spaces.flatMap(space => space.channels.map(channel => channel.id))),
      ...dmUnreadCounts(userId, dmChannels.map(dm => dm.id)),
    },
    readStates,
    notificationSettings: listNotificationSettings(userId),
    activeCalls,
    userActivities,
    userActivityIdentities,
    rejectedPeerOrigins,
    awaitingApprovalPeerOrigins,
    activePeerOrigins,
    pendingApprovalCount,
  };
}
