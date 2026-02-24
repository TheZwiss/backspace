import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, hasPermission, getChannelServerId, PermissionBits, computePermissions } from '../utils/permissions.js';
import { connectionManager } from '../ws/handler.js';
import type {
  CreateChannelRequest,
  UpdateChannelRequest,
  Channel,
} from '@opencord/shared';

function rowToChannel(row: typeof schema.channels.$inferSelect): Channel {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    type: row.type as Channel['type'],
    topic: row.topic,
    position: row.position ?? 0,
    createdAt: row.createdAt,
  };
}

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/servers/:id/channels - List channels in a server
  app.get<{ Params: { id: string } }>('/api/servers/:id/channels', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!isMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this server', statusCode: 403 });
    }

    const allChannels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.serverId, id))
      .all();

    // Filter by VIEW_CHANNEL permission per channel
    const visibleChannels = allChannels.filter(ch => {
      const perms = computePermissions(request.userId, id, ch.id);
      return (perms & PermissionBits.VIEW_CHANNEL) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
    });

    // Sort by position
    visibleChannels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    return reply.code(200).send(visibleChannels.map(rowToChannel));
  });

  // POST /api/servers/:id/channels - Create a channel (admin+)
  app.post<{ Params: { id: string }; Body: CreateChannelRequest }>('/api/servers/:id/channels', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, type, topic } = request.body;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'Channel name is required', statusCode: 400 });
    }

    const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      return reply.code(400).send({ error: 'Channel name must be between 1 and 100 characters', statusCode: 400 });
    }

    if (!type || !['text', 'voice', 'video'].includes(type)) {
      return reply.code(400).send({ error: 'Channel type must be "text", "voice", or "video"', statusCode: 400 });
    }

    // Get max position for ordering
    const existingChannels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.serverId, id))
      .all();

    const maxPosition = existingChannels.reduce((max, ch) => Math.max(max, ch.position ?? 0), -1);

    const channelId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.channels).values({
      id: channelId,
      serverId: id,
      name: trimmedName,
      type,
      topic: topic?.trim() || null,
      position: maxPosition + 1,
      createdAt: now,
    }).run();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
    if (!channel) {
      return reply.code(500).send({ error: 'Failed to create channel', statusCode: 500 });
    }

    const channelData = rowToChannel(channel);

    // Broadcast channel_created to all server members
    connectionManager.sendToServer(id, {
      type: 'channel_created',
      channel: channelData,
      serverId: id,
    });

    return reply.code(201).send(channelData);
  });

  // PATCH /api/channels/:id - Update a channel (admin+)
  app.patch<{ Params: { id: string }; Body: UpdateChannelRequest }>('/api/channels/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, topic, position } = request.body;
    const db = getDb();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    const serverId = channel.serverId;
    if (!hasPermission(request.userId, serverId, PermissionBits.MANAGE_CHANNELS, id)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    const updates: Partial<typeof schema.channels.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
      if (trimmedName.length < 1 || trimmedName.length > 100) {
        return reply.code(400).send({ error: 'Channel name must be between 1 and 100 characters', statusCode: 400 });
      }
      updates.name = trimmedName;
    }

    if (topic !== undefined) {
      updates.topic = topic.trim() || null;
    }

    if (position !== undefined) {
      if (typeof position !== 'number' || position < 0) {
        return reply.code(400).send({ error: 'Position must be a non-negative number', statusCode: 400 });
      }
      updates.position = position;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    db.update(schema.channels).set(updates).where(eq(schema.channels.id, id)).run();

    const updated = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'Failed to update channel', statusCode: 500 });
    }

    const channelData = rowToChannel(updated);

    // Broadcast channel_updated to all server members
    connectionManager.sendToServer(serverId, {
      type: 'channel_updated',
      channel: channelData,
      serverId,
    });

    return reply.code(200).send(channelData);
  });

  // DELETE /api/channels/:id - Delete a channel (admin+)
  app.delete<{ Params: { id: string } }>('/api/channels/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    const serverId = channel.serverId;
    if (!hasPermission(request.userId, serverId, PermissionBits.MANAGE_CHANNELS, id)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission', statusCode: 403 });
    }

    // Delete messages in channel (attachments cascade), then channel
    db.delete(schema.messages).where(eq(schema.messages.channelId, id)).run();
    db.delete(schema.channels).where(eq(schema.channels.id, id)).run();

    // Broadcast channel_deleted to all server members
    connectionManager.sendToServer(serverId, {
      type: 'channel_deleted',
      channelId: id,
      serverId,
    });

    return reply.code(200).send({ success: true });
  });

  // ─── Channel Override Endpoints ───────────────────────────────────────────

  // GET /api/channels/:id/overrides - List channel permission overrides
  app.get<{ Params: { id: string } }>('/api/channels/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, channel.serverId, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    const overrides = db.select().from(schema.channelOverrides)
      .where(eq(schema.channelOverrides.channelId, id))
      .all();

    return reply.code(200).send(overrides.map(o => ({
      channelId: o.channelId,
      targetType: o.targetType,
      targetId: o.targetId,
      allow: o.allow,
      deny: o.deny,
    })));
  });

  // PUT /api/channels/:id/overrides - Create or update a channel override
  app.put<{
    Params: { id: string };
    Body: { targetType: string; targetId: string; allow: string; deny: string };
  }>('/api/channels/:id/overrides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { targetType, targetId, allow, deny } = request.body;
    const db = getDb();

    if (!targetType || !['role', 'member'].includes(targetType)) {
      return reply.code(400).send({ error: 'targetType must be "role" or "member"', statusCode: 400 });
    }
    if (!targetId || typeof targetId !== 'string') {
      return reply.code(400).send({ error: 'targetId is required', statusCode: 400 });
    }

    const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, channel.serverId, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    // Validate that allow/deny are valid bigint strings
    try {
      BigInt(allow || '0');
      BigInt(deny || '0');
    } catch {
      return reply.code(400).send({ error: 'allow and deny must be valid decimal integer strings', statusCode: 400 });
    }

    // Upsert: delete existing then insert
    db.transaction((tx) => {
      tx.delete(schema.channelOverrides).where(
        and(
          eq(schema.channelOverrides.channelId, id),
          eq(schema.channelOverrides.targetType, targetType),
          eq(schema.channelOverrides.targetId, targetId),
        )
      ).run();

      tx.insert(schema.channelOverrides).values({
        channelId: id,
        targetType,
        targetId,
        allow: allow || '0',
        deny: deny || '0',
      }).run();
    });

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/channels/:id/overrides/:targetType/:targetId - Remove a channel override
  app.delete<{ Params: { id: string; targetType: string; targetId: string } }>(
    '/api/channels/:id/overrides/:targetType/:targetId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id, targetType, targetId } = request.params;
      const db = getDb();

      const channel = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
      if (!channel) {
        return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
      }

      if (!hasPermission(request.userId, channel.serverId, PermissionBits.MANAGE_ROLES)) {
        return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
      }

      db.delete(schema.channelOverrides).where(
        and(
          eq(schema.channelOverrides.channelId, id),
          eq(schema.channelOverrides.targetType, targetType),
          eq(schema.channelOverrides.targetId, targetId),
        )
      ).run();

      return reply.code(200).send({ success: true });
    },
  );
}
