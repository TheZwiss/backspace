import { sqliteTable, text, integer, primaryKey, foreignKey, real, unique } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').unique().notNull(),
  displayName: text('display_name'),
  passwordHash: text('password_hash').notNull(),
  avatar: text('avatar'),
  status: text('status').default('offline'),
  customStatus: text('custom_status'),
  isAdmin: integer('is_admin').default(0),
  homeInstance: text('home_instance'),
  homeUserId: text('home_user_id'),
  replicatedInstances: text('replicated_instances').default('[]'),
  banner: text('banner'),
  accentColor: text('accent_color'),
  avatarColor: text('avatar_color'),
  bio: text('bio'),
  isDeleted: integer('is_deleted').default(0),
  discoverable: integer('discoverable').default(1),
  profileUpdatedAt: integer('profile_updated_at'),
  passwordChangedAt: integer('password_changed_at'),
  showActivity: integer('show_activity').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon'),
  banner: text('banner'),
  avatarColor: text('avatar_color'),
  ownerId: text('owner_id').notNull().references(() => users.id),
  inviteCode: text('invite_code').unique(),
  visibility: text('visibility').default('private'),
  description: text('description'),
  createdAt: integer('created_at').notNull(),
});

export const spaceMembers = sqliteTable('space_members', {
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nickname: text('nickname'),
  joinedAt: integer('joined_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.spaceId, table.userId] }),
}));

export const channelCategories = sqliteTable('channel_categories', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').default(0),
  createdAt: integer('created_at').notNull(),
});

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  topic: text('topic'),
  position: integer('position').default(0),
  categoryId: text('category_id'),
  createdAt: integer('created_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),
  replyToId: text('reply_to_id'),
  content: text('content'),
  editedAt: integer('edited_at'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  replyToFk: foreignKey({
    columns: [table.replyToId],
    foreignColumns: [table.id],
  }).onDelete('set null'),
}));

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  dmMessageId: text('dm_message_id').references(() => dmMessages.id, { onDelete: 'cascade' }),
  uploaderId: text('uploader_id'),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimetype: text('mimetype').notNull(),
  size: integer('size').notNull(),
  thumbnailFilename: text('thumbnail_filename'),
  width: integer('width'),
  height: integer('height'),
  duration: real('duration'),
  sourceUrl: text('source_url'),
  federationStatus: text('federation_status'),
  federationMeta: text('federation_meta'),
  createdAt: integer('created_at').notNull(),
});

export const embeds = sqliteTable('embeds', {
  id: text('id').primaryKey(),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  dmMessageId: text('dm_message_id').references(() => dmMessages.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  embedType: text('embed_type').notNull(),
  provider: text('provider'),
  title: text('title'),
  description: text('description'),
  image: text('image'),
  embedUrl: text('embed_url'),
  width: integer('width'),
  height: integer('height'),
  color: text('color'),
  createdAt: integer('created_at').notNull(),
});

export const dmChannels = sqliteTable('dm_channels', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  federatedId: text('federated_id'),
  ownerHomeUserId: text('owner_home_user_id'),
  ownerHomeInstance: text('owner_home_instance'),
  deletedAt: integer('deleted_at'),
  createdAt: integer('created_at').notNull(),
});

export const dmMembers = sqliteTable('dm_members', {
  dmChannelId: text('dm_channel_id').notNull().references(() => dmChannels.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  closed: integer('closed').default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.dmChannelId, table.userId] }),
}));

export const dmMessages = sqliteTable('dm_messages', {
  id: text('id').primaryKey(),
  dmChannelId: text('dm_channel_id').notNull().references(() => dmChannels.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),
  replyToId: text('reply_to_id'),
  content: text('content'),
  editedAt: integer('edited_at'),
  sourceInstance: text('source_instance'),
  sourceMessageId: text('source_message_id'),
  encryptionVersion: integer('encryption_version').default(0),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  replyToFk: foreignKey({
    columns: [table.replyToId],
    foreignColumns: [table.id],
  }).onDelete('set null'),
}));

export const friends = sqliteTable('friends', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  friendId: text('friend_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.friendId] }),
}));

export const friendRequests = sqliteTable('friend_requests', {
  id: text('id').primaryKey(),
  fromId: text('from_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toId: text('to_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').default('pending'), // 'pending', 'accepted', 'declined'
  createdAt: integer('created_at').notNull(),
});

export const reactions = sqliteTable('reactions', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const dmReactions = sqliteTable('dm_reactions', {
  id: text('id').primaryKey(),
  dmMessageId: text('dm_message_id').notNull().references(() => dmMessages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').default('#b9bbbe'),
  position: integer('position').default(0),
  permissions: text('permissions'), // JSON string of permission keys
  createdAt: integer('created_at').notNull(),
});

export const memberRoles = sqliteTable('member_roles', {
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.spaceId, table.userId, table.roleId] }),
}));

export const channelOverrides = sqliteTable('channel_overrides', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(), // 'role' | 'member'
  targetId: text('target_id').notNull(), // role ID or user ID
  allow: text('allow').notNull().default('0'), // BigInt decimal string
  deny: text('deny').notNull().default('0'), // BigInt decimal string
}, (table) => ({
  pk: primaryKey({ columns: [table.channelId, table.targetType, table.targetId] }),
}));

export const categoryOverrides = sqliteTable('category_overrides', {
  categoryId: text('category_id').notNull().references(() => channelCategories.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  allow: text('allow').notNull().default('0'),
  deny: text('deny').notNull().default('0'),
}, (table) => ({
  pk: primaryKey({ columns: [table.categoryId, table.targetType, table.targetId] }),
}));

export const readStates = sqliteTable('read_states', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
  lastReadMessageId: text('last_read_message_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.channelId] }),
}));

export const spaceFolders = sqliteTable('space_folders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name'),
  color: text('color'),
  position: integer('position').default(0),
  createdAt: integer('created_at').notNull(),
});

export const spaceFolderMembers = sqliteTable('space_folder_members', {
  folderId: text('folder_id').notNull().references(() => spaceFolders.id, { onDelete: 'cascade' }),
  spaceId: text('space_id').notNull(), // No FK — federated space IDs don't exist locally
  position: integer('position').default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.folderId, table.spaceId] }),
}));

export const userSpaceLayout = sqliteTable('user_space_layout', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  layout: text('layout').notNull().default('[]'),
  updatedAt: integer('updated_at').notNull(),
});

export const instanceSettings = sqliteTable('instance_settings', {
  id: integer('id').primaryKey().default(1),
  instanceName: text('instance_name').default('Backspace'),
  workerId: integer('worker_id'),
  discoveryEnabled: integer('discovery_enabled').notNull().default(1),
  maxBitrateKbps: integer('max_bitrate_kbps').notNull().default(20000),
  minBitrateKbps: integer('min_bitrate_kbps').notNull().default(500),
  bitrateStepKbps: integer('bitrate_step_kbps').notNull().default(500),
  allowedResolutions: text('allowed_resolutions').notNull().default('540,720,1080'),
  allowedFramerates: text('allowed_framerates').notNull().default('30,45,60'),
  maxResolution: integer('max_resolution').notNull().default(1080),
  maxFramerate: integer('max_framerate').notNull().default(60),
  registrationOpen: integer('registration_open'),  // null = use env var default, 0/1 = explicit
  gifApiKey: text('gif_api_key'),
  bitrateMatrixOverrides: text('bitrate_matrix_overrides'),
  allowCustomBitrate: integer('allow_custom_bitrate').notNull().default(1),
  maxUploadSizeBytes: integer('max_upload_size_bytes'),
  federationRelayEnabled: integer('federation_relay_enabled').notNull().default(1),
  federationRelayTtlDays: integer('federation_relay_ttl_days').notNull().default(30),
  updatedAt: integer('updated_at').notNull(),
});

export const bans = sqliteTable('bans', {
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason'),
  bannedBy: text('banned_by').references(() => users.id),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.spaceId, table.userId] }),
}));

export const joinRequests = sqliteTable('join_requests', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  message: text('message'),
  status: text('status').notNull().default('pending'),
  decidedBy: text('decided_by').references(() => users.id),
  createdAt: integer('created_at').notNull(),
  decidedAt: integer('decided_at'),
});

export const voiceRestrictions = sqliteTable('voice_restrictions', {
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  restrictionType: text('restriction_type').notNull(), // 'mute' | 'deafen'
  moderatorId: text('moderator_id').references(() => users.id),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.spaceId, table.userId, table.restrictionType] }),
}));

export const federationPeers = sqliteTable('federation_peers', {
  id: text('id').primaryKey(),
  origin: text('origin').notNull().unique(),
  instanceName: text('instance_name'),
  hmacSecret: text('hmac_secret').notNull(),
  status: text('status').notNull().default('active'),
  lastSeenAt: integer('last_seen_at'),
  lastFailureAt: integer('last_failure_at'),
  consecutiveFailures: integer('consecutive_failures').default(0),
  lastSyncedAt: integer('last_synced_at').default(0),
  remoteMaxUploadSize: integer('remote_max_upload_size'),
  createdAt: integer('created_at').notNull(),
});

export const federationOutbox = sqliteTable('federation_outbox', {
  id: text('id').primaryKey(),
  peerId: text('peer_id').notNull().references(() => federationPeers.id, { onDelete: 'cascade' }),
  contextId: text('context_id').notNull(),
  entityId: text('entity_id').notNull(),
  contextType: text('context_type').notNull().default('dm'),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(),
  encryptionVersion: integer('encryption_version').default(0),
  attempts: integer('attempts').default(0),
  nextRetryAt: integer('next_retry_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  uniquePerPeerMessage: unique().on(table.peerId, table.entityId),
}));

export const federationFileQueue = sqliteTable('federation_file_queue', {
  id: text('id').primaryKey(),
  peerOrigin: text('peer_origin').notNull(),
  dmMessageId: text('dm_message_id').notNull(),
  sourceUrl: text('source_url').notNull(),
  targetFilename: text('target_filename'),
  originalName: text('original_name').notNull(),
  mimetype: text('mimetype').notNull(),
  size: integer('size').notNull(),
  status: text('status').notNull().default('pending'),
  rejectionReason: text('rejection_reason'),
  attempts: integer('attempts').default(0),
  nextRetryAt: integer('next_retry_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const federationMutationLog = sqliteTable('federation_mutation_log', {
  id: text('id').primaryKey(),
  entityId: text('entity_id').notNull(),
  contextId: text('context_id').notNull(),
  contextType: text('context_type').notNull().default('dm'),
  mutationType: text('mutation_type').notNull(),
  mutatedAt: integer('mutated_at').notNull(),
  payload: text('payload'),
});
