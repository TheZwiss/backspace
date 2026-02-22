import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, isAdmin, getChannelServerId } from '../utils/permissions.js';
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

    const channels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.serverId, id))
      .all();

    // Sort by position
    channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    return reply.code(200).send(channels.map(rowToChannel));
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

    if (!isAdmin(id, request.userId)) {
      return reply.code(403).send({ error: 'Only admins can create channels', statusCode: 403 });
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
    if (!isAdmin(serverId, request.userId)) {
      return reply.code(403).send({ error: 'Only admins can update channels', statusCode: 403 });
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
    if (!isAdmin(serverId, request.userId)) {
      return reply.code(403).send({ error: 'Only admins can delete channels', statusCode: 403 });
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
}
