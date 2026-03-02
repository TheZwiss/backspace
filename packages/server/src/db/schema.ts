import { sqliteTable, text, integer, primaryKey, foreignKey } from 'drizzle-orm/sqlite-core';

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
  replicatedInstances: text('replicated_instances').default('[]'),
  createdAt: integer('created_at').notNull(),
});

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon'),
  ownerId: text('owner_id').notNull().references(() => users.id),
  inviteCode: text('invite_code').unique(),
  createdAt: integer('created_at').notNull(),
});

export const serverMembers = sqliteTable('server_members', {
  serverId: text('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nickname: text('nickname'),
  joinedAt: integer('joined_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.serverId, table.userId] }),
}));

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  topic: text('topic'),
  position: integer('position').default(0),
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
  dmMessageId: text('dm_message_id'),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimetype: text('mimetype').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const dmChannels = sqliteTable('dm_channels', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
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
  createdAt: integer('created_at').notNull(),
});

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
  dmMessageId: text('dm_message_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').default('#b9bbbe'),
  position: integer('position').default(0),
  permissions: text('permissions'), // JSON string of permission keys
  createdAt: integer('created_at').notNull(),
});

export const memberRoles = sqliteTable('member_roles', {
  serverId: text('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.serverId, table.userId, table.roleId] }),
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

export const readStates = sqliteTable('read_states', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
  lastReadMessageId: text('last_read_message_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.channelId] }),
}));

export const serverFolders = sqliteTable('server_folders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name'),
  color: text('color'),
  position: integer('position').default(0),
  createdAt: integer('created_at').notNull(),
});

export const serverFolderMembers = sqliteTable('server_folder_members', {
  folderId: text('folder_id').notNull().references(() => serverFolders.id, { onDelete: 'cascade' }),
  serverId: text('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.folderId, table.serverId] }),
}));

export const instanceSettings = sqliteTable('instance_settings', {
  id: integer('id').primaryKey().default(1),
  instanceName: text('instance_name').default('Backspace'),
  workerId: integer('worker_id'),
  maxBitrateKbps: integer('max_bitrate_kbps').notNull().default(20000),
  minBitrateKbps: integer('min_bitrate_kbps').notNull().default(500),
  bitrateStepKbps: integer('bitrate_step_kbps').notNull().default(500),
  allowedResolutions: text('allowed_resolutions').notNull().default('540,720,1080'),
  allowedFramerates: text('allowed_framerates').notNull().default('30,45,60'),
  maxResolution: integer('max_resolution').notNull().default(1080),
  maxFramerate: integer('max_framerate').notNull().default(60),
  updatedAt: integer('updated_at').notNull(),
});
